# dsh-shared-browser

Playwright tools that drive the **built-in Browser tab of DeepSeek Harness Desktop** — the tab the user opens
with `Ctrl+T` in the right sidebar.

- **Native pixels** — it is the tab the user is looking at, not a screencast or a mirrored canvas. The page is
  as sharp and as large as the panel.
- **Operable** — `bb_*` tools talk to that same page through CDP with Playwright: `goto / click / type / press /
  wait / text / eval / screenshot`, including Chinese input.
- **Shared** — the user can log in, solve a captcha or click around in the same tab; the agent sees the same page
  and the same session.

```
Agent ──► bb_* tools ──► playwright-core ──connectOverCDP──► DSH Desktop (Electron 44 / Chrome 152)
                                                                 └── Browser tab = WebContentsView
User  ──► the same tab, live
```

## Requirements

| Item | Value |
| --- | --- |
| OS | Windows 10/11, x64 |
| Target app | DeepSeek Harness Desktop **0.2.2-rc.5** (Electron 44.7.0, Chrome 152.0.7977.130) |
| `engines.dsh` | `>=0.2.2-rc.5 <0.3.0` — other desktop builds need a re-check of the asar layout |
| Node (bundled runtime) | `>= 20` (the plugin spawns the desktop runtime's own `node.exe`) |
| Dependency | `playwright-core ^1.65.1` (no browser download) |

## Install

```bash
# marketplace / plugin manager
plugin_manager install_bundle target=dsh-shared-browser@0.4.0
# or from a tarball
plugin_manager install_bundle target=file:C:\path\dsh-shared-browser-0.4.0.tgz
```

Then **restart DSH once** (tray → Quit). That is the whole setup — no launcher, no arguments, no shortcut edit.

What happens on that restart:

1. On load the plugin arms a watchdog (`[dsh-shared-browser] auto-armed watchdog …`,
   `%TEMP%\dsh-shared-browser\arm-status.json` → `armed`).
2. When the app exits, the watchdog closes leftover sidecar processes that still hold `app.asar`, backs the archive
   up to `app.asar.bak-<timestamp>`, patches a copy, verifies it (20056 entries + 400-entry parity check), swaps it
   in, relaunches the app and waits for CDP.
3. From then on every normal start carries `--remote-debugging-port=9223` and `bb_*` works.

If CDP never comes up the backup is restored and the app restarted — a failed patch never leaves a broken install.
A desktop app update overwrites `app.asar`; the plugin re-arms itself on the next start, so one more restart is
all it takes.

## How it works

The built-in Browser tab is **not** a DOM `<iframe>`. It is a `WebContentsView` owned by the Electron main process
(CDP reports it as `type: "webview"`), so the renderer cannot touch its DOM — **CDP is the only channel**.

1. **Give the app a debugging port.** The patcher injects one statement into the entry module resolved from the
   archive's own `package.json#main` (currently `lib/main.js`), *after* the module's last top-level `import`:

   ```js
   /*DSH_SHARED_BROWSER_CDP v2*/import{app as __dshCdpApp}from'electron';
   try{const p=process.env.DSH_CDP_PORT||'9223';
       if(!process.argv.some(a=>String(a).startsWith('--remote-debugging-port')))
         __dshCdpApp.commandLine.appendSwitch('remote-debugging-port',p);}catch{}
   ```

2. **Make Playwright accept the target.** `playwright-core` detaches every CDP target that is not a `page`
   (`lib/coreBundle.js` → `treatOtherAsPage`). The plugin flips a one-line, env-gated condition
   (`DSH_BUILTIN_WEBVIEW_AS_PAGE=1`) so `webview` targets are treated as pages. The original file is kept as
   `coreBundle.js.orig`.

3. **Drive it.** `bb_*` = ordinary Playwright page calls on that page, plus a `bb_snapshot` that tags interactive
   elements with stable refs (`data-bbref`).

### Coexistence with other archive-patching plugins

- The target file comes from `package.json#main` — never a hard-coded `lib/main.js`.
- The statement goes after the import block, so another plugin's leading banner/comments stay intact.
- The marker is `/*DSH_SHARED_BROWSER_CDP v2*/` and may sit anywhere in the file, not only at byte 0.
- If the entry module already contains `appendSwitch('remote-debugging-port', …)` — i.e. another plugin already
  opened a port — the patcher **leaves the archive byte-for-byte untouched** and reports `foreignSwitch: true`.
- Re-running the patch is a no-op; `already: true` is returned with the archive unchanged.

## Tools

| Tool | What it does |
| --- | --- |
| `bb_status` | CDP endpoint, playwright patch state, app/asar location, archive state (patched / port / size), connection, open pages |
| `bb_enable` | Arm the watchdog (`mode: 'patch'`, default) or rewrite launchers (`mode: 'shortcut'`, `undo: true`) |
| `bb_open` | Navigate the tab, creating one through the sidebar address bar when none exists (`createdTab: true`) |
| `bb_snapshot` | List interactive elements with refs, roles, labels and text |
| `bb_click` / `bb_type` / `bb_press` / `bb_wait` | Interact by ref or CSS selector; `submit: true` presses Enter |
| `bb_text` | Read the page text (or one selector) |
| `bb_eval` | Evaluate JS in the page |
| `bb_screenshot` | Native-pixel screenshot to a file (`-Path`) |
| `bb_reconnect` | Drop the cached CDP connection and reconnect |

Typical flow: `bb_status` → (`bb_enable` if not patched, then restart) → `bb_open <url>` → `bb_snapshot` →
`bb_click` / `bb_type` → `bb_screenshot`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_CDP` | `http://127.0.0.1:9223` | CDP endpoint used by `bb_*` |
| `DSH_CDP_PORT` | `9223` | Port injected by the prelude and expected by the watchdog |
| `DSH_AUTO_ARM` | on | `off` disables the automatic arming on plugin load |
| `DSH_NODE` | – | Explicit `node.exe` for the watchdog (otherwise the desktop runtime is used) |
| `DSH_APP_EXE` / `DSH_ASAR_PATH` | auto-detected | Override app / archive discovery |

## Safety

- Never edits a running archive: the swap happens only after the app has exited, and a failed swap restores the
  backup and relaunches the app.
- Verification before the swap: full structural read, marker/switch/port checks, and a 400-entry content parity
  check against the original.
- `app.asar.bak-<timestamp>` is left next to the archive; delete it once the install is confirmed healthy.
- `shortcut` mode exists for users who prefer not to touch the binary at all.

## Uninstall

1. `bb_enable` is not required for removal — just uninstall the plugin.
2. Restore the archive: `resources\app.asar.bak-<timestamp>` → `app.asar` (or reinstall the desktop app, which also
   reverts the patch).
3. Optional: `playwright-core\lib\coreBundle.js.orig` → `coreBundle.js`.

## License

MIT.

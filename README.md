# dsh-shared-browser

A browser for **DeepSeek Harness desktop**: it upgrades the sidebar browser tab into a real integrated browser
(address bar, zoom, find-in-page, device emulation, history/bookmarks, site permissions, storage clearing and a
built-in DevTools panel) and adds **screenshots, region screenshots, element comments and console logs that go
straight into the chat draft**, plus 26 `bb_*` tools that let the agent drive **the same page the user is looking at**.

One page, one session: the user can log in, solve a captcha or click around while the agent works, and the agent
sees exactly that state.

```
user ─┐
      ├─► Browser tab in the sidebar (Electron webview, isolated per workspace)
agent ─┘        ▲
        bb_* tools ─┐
                     └─ host plugin /dsh-shared-browser (SSE command channel) ─► client plugin (the tab body)
```

## Turnkey

1. Open **Plugins → Add plugin**, or `plugin_manager install_bundle target=dsh-shared-browser`.
2. Restart DSH once.
3. Click **Browser** in the sidebar (or `Ctrl+T`). Toolbar, menu and tools are all there.

No patching, no `app.asar` edits, no launch flags, no shortcut rewriting. Disable the bundle and the sidebar
falls back to the DSH built-in browser.

## What the tab offers

| Capability | Entry point |
| --- | --- |
| Back / forward / reload / stop / address bar | left side of the toolbar |
| Zoom 50%–300% | `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, or the menu |
| Find in page (match count, wrap-around, native highlight) | `Ctrl+F` |
| Device emulation (iPhone 14, Pixel 7, Galaxy S23, iPad mini, desktop) | menu → Device emulation |
| History / bookmarks | `Ctrl+H` / `Ctrl+D`, or the menu |
| Site permissions, clear storage, browser settings | menu |
| Screenshot to chat | toolbar ⤓ or menu → Screenshot |
| Region screenshot to chat | toolbar ▣ or menu → Region screenshot |
| Pick element to chat / comment on element | toolbar ⌖ / ✎ |
| Console log to chat | menu → Console log |
| DevTools panel: console / elements / network / run JS | `F12` or toolbar ⚙ |
| Open in external browser, copy address, new tab | menu |

Screenshots, region captures, element comments and console excerpts land in the **current session's composer**
as a quote plus an image or text block. Nothing is sent for you — edit and send it, or let the agent read it.

## Agent tools (26)

| Tool | Purpose |
| --- | --- |
| `bb_status` | connection state, tabs, counters |
| `bb_open` / `bb_navigate` | open a URL / back, forward, reload, stop |
| `bb_tabs` | list, activate, open, reload, close tabs |
| `bb_snapshot` | interactive element tree (`e12 <button> "Sign in"`) |
| `bb_text` | page text |
| `bb_click` / `bb_type` / `bb_press` / `bb_wait` | click, type, press keys, wait |
| `bb_eval` | run JavaScript in the page |
| `bb_screenshot` / `bb_region_screenshot` | screenshot / region capture, stored and served |
| `bb_console` / `bb_network` | console and network buffers (host side) |
| `bb_comment` / `bb_comments` | comment on an element / read comments |
| `bb_find` / `bb_zoom` / `bb_emulate` | find, zoom, device emulation |
| `bb_devtools` / `bb_open_devtools_native` | panel state / probe native CDP |
| `bb_storage` / `bb_permissions` / `bb_history` | storage, permission policy, history |
| `bb_add_to_chat` | put a screenshot / region / element / console log in the composer |

Tools and UI share one channel: the host sends commands over SSE, the tab executes them and reports back.
When no tab is open the tools say so explicitly. Once a comment is submitted, `bb_comments` returns its
selector, `ref`, text, rect and note — the agent can read what the user pointed at.

## Compatibility

- **No DSH changes**: no `app.asar` patching, no binary edits, no global injection.
- Public surfaces only: tab type registration (`priority: 'extension'` taking over `kind: 'browser'`), slots,
  the `window.dshDesktop.browser` lease bridge, host `webServer` routes and `ctx.tools`.
- Claims only the `browser` tab kind; other plugins and tab types are untouched. Disabling the bundle restores
  the built-in browser immediately.
- In the Web carrier (no desktop bridge) the plugin steps aside and keeps the built-in browser intact.
- Styles live in `<style data-plugin="dsh-shared-browser">` and are removed with the plugin.

## Known limits (imposed by the desktop shell)

- Inside the shared browser partition **site permissions, downloads and native popups are always denied** —
  that is the shell's fixed policy for sidebar browsers.
- The packaged shell disables the guest's `devTools`, so `openDevTools()` is unavailable. This plugin ships its
  own DevTools panel (console / elements / network / run JS). `bb_open_devtools_native` explains the external CDP
  route.
- The partition is per workspace and **not persisted**: a DSH restart drops logins, same as the built-in browser.
- Not supported yet: multiple windows, bookmark sync, download manager, extensions.

## Requirements

| Item | Value |
| --- | --- |
| Carrier | DSH **desktop** 0.2.2-rc.5 or newer (verified on Electron 44 / Chrome 152) |
| `engines.dsh` | `>=0.2.2-rc.5 <0.3.0` |
| Dependencies | none |

## Debugging

- Read-only host route: `GET /dsh-shared-browser/state` (state, tabs, counters).
- Start DSH with `DSH_SHARED_BROWSER_DEV=1` to also register `POST /dsh-shared-browser/debug/command`, which runs
  a tool by name. Loopback only and development-only.
- Client side: `window.__dshBrowserDebug` (`session()`, `probe()`, `lastMount`).

## License

MIT

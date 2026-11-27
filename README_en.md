# dsh-shared-browser

[简体中文](https://github.com/FeiGenb/dsh-shared-browser/blob/main/README.md) · [English](https://github.com/FeiGenb/dsh-shared-browser/blob/main/README_en.md)

A browser for **DeepSeek Harness desktop**: it upgrades the sidebar browser tab into a real integrated browser
(address bar, zoom, find-in-page, device emulation, history/bookmarks, site permissions, storage clearing and a
built-in DevTools panel) and adds **screenshots, region screenshots, element comments and console logs that go
straight into the chat draft**, plus 28 `bb_*` tools that let the agent drive **the same page the user is looking at**. When a Cloudflare-style verification wall appears, the tools tell the agent to stop and hand the page back to you.

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

From then on the sidebar's Browser tab is this plugin; disable it and the tab returns to DSH's own browser tab.

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

## Two channels: in-app tab / your own browser

The in-app tab is an Electron `<webview>`: it lives in the sidebar and supports screenshots and element comments, but **its session is not persistent** and Cloudflare-class walls reject its user agent. When a real browser is needed the plugin can hand the same address to the local Edge/Chrome:

| Situation | How |
| --- | --- |
| Force the real browser | `bb_open { url, channel: "external" }` or `bb_external { action: "launch", url }` |
| Make it the default | `bb_settings { action: "set", channel: "external" }` |
| Auto-switch on a wall | On by default: when the in-app tab detects a challenge it is closed and the page reopens externally (`bb_settings { action: "set", autoLaunch: false }` disables it) |
| Inspect / stop it | `bb_external { action: "status" }` / `{ action: "close" }` |

External tabs are addressed as `ext:<id>`; every other tool (`bb_snapshot`, `bb_click`, `bb_screenshot`, `bb_console` …) routes on that id. The sidebar shows an "External browser" mirror that polls frames and forwards clicks and wheel events to the real window.

Settings live in `$DSH_HOME/shared-browser/settings.json`: `channel`, `browser` (`msedge`/`chrome`), `profileDir`, `autoLaunch`. The external profile defaults to `$DSH_HOME/shared-browser/profiles/<browser>` so logins survive restarts.

### Verification walls (Cloudflare / DataDome)

When the in-app tab hits a challenge page the tools return `wall: true` with a fixed instruction: **do not** try to pass or bypass the check and **do not** click the verification widget — hand the page back to the user.
With `autoLaunch` on, the plugin closes the in-app tab and reopens the same address in the external browser window so you can complete the check yourself; the external channel keeps a persistent profile, so the result sticks.

## Agent tools (28)

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
| `bb_external` | Detect, launch and close the local Edge/Chrome over CDP. |
| `bb_settings` | Read or change channel, external browser, profile folder, auto-switch. |

Tools and UI share one channel: the host sends commands over SSE, the tab executes them and reports back.
When no tab is open the tools say so explicitly. Once a comment is submitted, `bb_comments` returns its
selector, `ref`, text, rect and note — the agent can read what the user pointed at.

## How it works

This describes the code in 0.6.12. Every mechanism goes through DSH's public surfaces.

### 1. Three boundaries: host / renderer / page

| Layer | Where | Responsibility |
| --- | --- | --- |
| Host plugin | DSH main process (`index.js`) | registers the 28 `bb_*` tools, HTTP routes, attachment storage, the external channel, command queueing and timeouts |
| Client plugin | renderer (`lib/client.cjs`) | takes over the sidebar Browser tab, creates the `<webview>`, injects into the page, captures, comments, draws DevTools |
| Page guest | the real page inside the webview | a tiny injected agent: DOM queries, input events, log forwarding |

The host cannot reach the guest's DOM (different process) and the renderer cannot reach the host's routes.
The two ends talk over their own channel instead of CDP or a patched DSH.

### 2. Host ↔ tab: one SSE download, one POST upload

- `GET /dsh-shared-browser/events`: `text/event-stream`, single connection, `: ping` every 15 s
  (`x-accel-buffering: no` so proxies do not buffer). The stream records `sessionId`/`version`; when the tab
  closes or the page reloads, `failAll('detached')` rejects in-flight commands so no tool hangs.
- `POST /dsh-shared-browser/report`: the tab's acknowledgements — `result` / `tabs` / `console` / `network` /
  `comments`. A `result` is matched to the pending promise by command id; default timeout 20 s.
- `fence(req, origin)` refuses cross-site calls; failures become `BridgeError` → 400/403/500.
- Every buffer is bounded, dropping the oldest: console 2000, network 600, comments 1000. That is why
  `bb_console` / `bb_network` read the **host cache** and still answer after the page navigates away.

### 3. Taking over the tab without editing DSH

- `sidebarRightTabs.register({ kind: 'browser', priority: 'extension' })` claims DSH's own browser tab kind.
- `slots.inject('sidebar.right.pane.tab')` injects the body, `…pane.tab.title` the title button.
- On a carrier without the desktop bridge (the Web build) it `setFailure('no-bridge')` and steps aside.

### 4. One tab = one lease + one webview

- `window.dshDesktop.browser.acquire('cwd:<workspace>')` obtains a lease; `document.createElement('webview')`
  is created with `name=<lease>` and `partition=<partition>` — **the same partition as DSH's built-in browser**,
  so logins are shared and every tab in the same `cwd:` sees them.
- UA goes through `effectiveUserAgent()`: Electron/DSH tokens are rewritten to a plain Chrome version string,
  so Cloudflare does not classify the tab as an automation client on sight.
- Guest capabilities are wrapped one by one: `executeJavaScript`, `setZoomFactor`, `findInPage` /
  `stopFindInPage` (native highlight and scrolling), `sendInputEvent` (mouse/keyboard/char), `capturePage`
  (3-second timeout plus an `isEmpty()` check) and `resize` (explicit viewport, because an Electron webview
  ignores CSS scaling).

### 5. Only a tiny agent inside the page

- `executeJavaScript` installs the page agent; console, network (wrapping fetch/XHR), comments and element
  picking are `push`ed to the client, which `POST`s them to the host.
- Element targeting: `snapshot()` stamps interactive elements with `data-bb-ref` (`e12`), and `resolve()`
  accepts both a ref and a CSS selector, so one tool can click `e12` or `#submit`.
- Clicks and typing prefer `sendInputEvent` (the real input pipeline, so site focus/event logic runs); DOM
  dispatch is only the fallback when an element cannot be hit.

### 6. Command routing and the two channels

`run(op, args)` routes on the `tabId` prefix: `ext:` → `ExternalBrowser.command()`, everything else →
`hub.command()` over SSE to the tab.

The external channel (`lib/external.mjs`) detects a local Edge/Chrome, launches it with
`--remote-debugging-port` and its own profile (`$DSH_HOME/shared-browser/profiles/<browser>`), reads
`webSocketDebuggerUrl` from `/json/list`, then speaks CDP over a bare WebSocket: `Runtime.evaluate`,
`Page.captureScreenshot`, `Input.dispatchMouseEvent`/`KeyEvent`, `Emulation.setDeviceMetricsOverride`. The
sidebar mirror (`ExternalPane`) polls `GET /external/frame?tab=` (the host turns it into a PNG) and forwards
clicks and wheel events to `POST /external/input` into the real window.

### 7. Verification walls: detect, hand back, never bypass

`CHALLENGE` plus `looksLikeChallenge()` (title first, then the first 600 characters of body text) decide whether
the tab is on a wall. On a hit, `handOff()` launches the external browser, picks the target tab, calls
`hub.command('ensure', { external: 'ext:<id>' })` so the mirror appears, and returns `wall: true` with the fixed
`WALL_POLICY` text. The plugin never tries to solve the challenge.

### 8. Screenshots, regions, comments and logs into the chat

- The `capturePage` data URL goes through `storeCapture()` into `$DSH_HOME/shared-browser/attachments` and comes
  back as an `…/attachment?path=` URL; the route guards traversal with `resolved.startsWith(dir)`.
- Region capture reuses `capturePage(rect)`; an element comment carries selector, ref, text and rect back, so
  `bb_comments` can hand all of it to the agent.
- `addToComposer()` uses the `sessions` service to place a "quote strip + File" into that session's composer
  draft — it never sends for you.

### 9. A hand-drawn DevTools panel (because the shell disables the guest's DevTools)

The packaged shell sets the guest's `devTools` to false, so `openDevTools()` is unavailable. The panel is React
drawn: console / elements / network read the client cache, the run box uses `executeJavaScript`. For native
DevTools, `bb_open_devtools_native` explains the external CDP route.

### 10. State, settings, teardown

- Settings live in `$DSH_HOME/shared-browser/settings.json` (`channel` / `browser` / `profileDir` /
  `autoLaunch`), written by a merged `readSettings()` + `writeSettings()`.
- Read-only diagnostics: `GET /dsh-shared-browser/state`; `POST /dsh-shared-browser/debug/command` exists only
  when `DSH_SHARED_BROWSER_DEV=1` (loopback only).
- Teardown is complete: route registrations sit inside `injected.effect(...)`, so disabling the plugin calls
  `hub.detach()` and unregisters them; styles live under `<style data-plugin="dsh-shared-browser">` and are
  removed with the plugin.

## Compatibility

- **Only touches the plugin itself**: tab type registration (`priority: 'extension'` taking over `kind: 'browser'`),
  slots, the `window.dshDesktop.browser` lease bridge, host `webServer` routes and `ctx.tools`.
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
- Screenshots need the window in front: when the DSH window is minimised or fully covered, `capturePage`
  never returns a frame, so the plugin gives up after about six seconds with
  "Capture failed: bring the DSH window to the front and try again" instead of spinning forever.
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

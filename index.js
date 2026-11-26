/**
 * dsh-shared-browser — one browser, shared by the user and the agent.
 *
 * Two halves, one product:
 *
 * - **Client half** (`lib/client.cjs`) takes over DSH's own Browser tab through
 *   the public `sidebarRightTabs` registry (`priority: 'extension'`, same
 *   `kind: 'browser'`), then draws the full desktop-browser chrome around the
 *   Electron `<webview>` the shell already owns: back/forward/reload, zoom,
 *   find-in-page, device emulation, history, bookmarks, permissions, storage
 *   clearing, screenshots, region screenshots, element picking, element
 *   comments, a DevTools panel, and the context menu the product menu shows.
 *
 * - **Host half** (this file) exposes the same browser to the agent as tools,
 *   relays commands over an authenticated SSE/POST bridge, and owns everything
 *   that must survive a tab: the console log, the network log, element
 *   comments, and screenshots written to disk.
 *
 * Because the tab type is a registration and the bridge is a route pair, the
 * bundle needs no edit to DSH: unloading it restores the stock browser.
 * @module dsh-shared-browser
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Hub, BridgeError, ROUTE_BASE, fence, readJson, replyError, replyJson } from './lib/bridge.mjs'

export const name = 'dsh-shared-browser'
export const inject = ['tools']

const VERSION = '0.5.0'
const ATTACHMENT_PREFIX = `${ROUTE_BASE}/attachment?path=`

/** Tool output envelope: JSON text plus a generic card. */
const json = () => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
})

/** Present-call descriptor for the tool card. */
const present = (title, args) => ({ card: 'generic', title, kind: 'other', rawInput: args || {} })

/** Directory where screenshots and captured payloads are stored. */
function attachmentsRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'shared-browser', 'attachments')
}

/** Ensure the attachments directory exists. @returns {Promise<string>} absolute path. */
async function ensureAttachments() {
  const dir = attachmentsRoot()
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Decode a data URL produced by the browser into raw bytes.
 * @param {string} dataUrl - `data:image/png;base64,…`.
 * @returns {{ bytes: Buffer, mime: string, ext: string }} decoded payload.
 */
function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/su.exec(String(dataUrl ?? ''))
  if (match === null) throw new BridgeError('截图数据不是合法的 data URL。', 'bad-image')
  const mime = match[1] ?? 'image/png'
  const bytes = Buffer.from(match[2], 'base64')
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
  return { bytes, mime, ext }
}

/**
 * Persist one browser capture and describe it for the tool result.
 * @param {{ dataUrl: string, name?: string }} capture - client payload.
 * @param {string} kind - `screenshot` | `region` | `element`.
 * @returns {Promise<Record<string, unknown>>} stored file facts.
 */
async function storeCapture(capture, kind) {
  const dir = await ensureAttachments()
  const { bytes, mime, ext } = decodeDataUrl(capture.dataUrl)
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const base = String(capture.name ?? kind).replace(/[^\w.-]+/gu, '-').slice(0, 40) || kind
  const file = join(dir, `${stamp}-${base}-${randomUUID().slice(0, 8)}.${ext}`)
  await writeFile(file, bytes)
  return {
    path: file,
    bytes: bytes.length,
    mime,
    url: `${ATTACHMENT_PREFIX}${encodeURIComponent(file.slice(dir.length + 1).replace(/\\/gu, '/'))}`,
  }
}

/**
 * Mount the routes and tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const hub = new Hub({ attachmentsDir: attachmentsRoot() })
  /** @type {Array<() => void>} */
  const disposers = []

  // Routes exist only once the Host has a web server. Waiting for the service keeps
  // the tools usable on carriers without one (a plain CLI session, for example).
  ctx.inject(['webServer'], (injected) => {
    const webServer = injected.webServer
    const origin = (() => {
      try { return webServer.getOrigin() } catch { return undefined }
    })()

    /**
     * Wrap a route handler with the same-origin fence and uniform error replies.
     * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler - body.
     * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} guarded handler.
     */
    const route = handler => (req, res) => {
      const refusal = fence(req, origin)
      if (refusal !== null) {
        replyError(res, 403, refusal, 'forbidden')
        return
      }
      handler(req, res).catch((error) => {
        if (error instanceof BridgeError) replyError(res, 400, error.message, error.code)
        else replyError(res, 500, error instanceof Error ? error.message : String(error), 'internal')
      })
    }

    disposers.push(webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/state`,
      handler: route(async (_req, res) => {
        replyJson(res, { ok: true, version: VERSION, ...hub.status() })
      }),
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/events`,
      handler: route(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        hub.attach(res, { sessionId: url.searchParams.get('sessionId'), version: url.searchParams.get('version') })
        req.on('close', () => { /* stream close is handled by the response */ })
      }),
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/report`,
      handler: route(async (req, res) => {
        if (req.method !== 'POST') { replyError(res, 405, 'POST only', 'method'); return }
        const type = String(req.headers['content-type'] ?? '')
        if (!type.toLowerCase().includes('application/json')) {
          replyError(res, 415, 'report 必须是 application/json。', 'content-type')
          return
        }
        const body = await readJson(req)
        replyJson(res, hub.ingest(body))
      }),
    }))

    // Opt-in debugging hook. It lets a local script drive the same host → client
    // command path the tools use, without spending a model turn. Never
    // registered unless the Host process was started with the flag.
    if (process.env.DSH_SHARED_BROWSER_DEV === '1') {
      disposers.push(webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/debug/command`,
        handler: route(async (req, res) => {
          if (req.method !== 'POST') { replyError(res, 405, 'POST only', 'method'); return }
          const body = await readJson(req)
          const name = String(body.tool ?? body.op ?? '')
          const run = tools.get(name)
          if (run === undefined) throw new BridgeError(`unknown tool: ${name}`, 'tool')
          const value = await run(body.args ?? {})
          replyJson(res, { ok: true, value })
        }),
      }))
    }

    disposers.push(webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/attachment`,
      handler: route(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const requested = url.searchParams.get('path') ?? ''
        const dir = await ensureAttachments()
        const resolved = join(dir, requested)
        if (!resolved.startsWith(dir)) { replyError(res, 400, '非法附件路径。', 'path'); return }
        const { readFile } = await import('node:fs/promises')
        const bytes = await readFile(resolved).catch(() => null)
        if (bytes === null) { replyError(res, 404, '附件不存在。', 'missing'); return }
        const mime = resolved.endsWith('.jpg') ? 'image/jpeg' : resolved.endsWith('.webp') ? 'image/webp' : 'image/png'
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'content-length': bytes.length })
        res.end(bytes)
      }),
    }))

    injected.effect(() => () => {
      hub.detach()
      for (const off of disposers) {
        try { off() } catch { /* route already gone */ }
      }
    }, 'dsh-shared-browser routes')
  })

  /* ------------------------------------------------------------------ tools */

  /**
   * Register one agent tool with a uniform envelope.
   * @param {string} toolName - `bb_*` name.
   * @param {string} description - model-facing contract.
   * @param {Record<string, unknown>} properties - JSON schema properties.
   * @param {(args: any) => Promise<unknown>} execute - implementation.
   * @param {string} title - card title.
   * @param {string[]} [required] - required properties.
   */
  /** Tool table, reused by the opt-in debug route. */
  const tools = new Map()

  const tool = (toolName, description, properties, execute, title, required = []) => {
    tools.set(toolName, execute)
    ctx.tools.register({
      name: toolName,
      description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties,
        ...(required.length === 0 ? {} : { required }),
      },
      output: json(),
      execute,
      presentCall: args => present(title, args),
    })
  }

  const tabArg = { type: 'string', description: 'Tab id from bb_tabs. Defaults to the active tab.' }

  tool('bb_status',
    'Read the shared-browser state: whether a Browser tab is attached, every open tab, and how much console/network/comment data is held. Read-only; start here when something looks disconnected.',
    {},
    async () => ({ version: VERSION, ...hub.status(), attachmentsDir: attachmentsRoot() }),
    'Shared browser status')

  tool('bb_tabs',
    'List, activate, open, reload or close shared-browser tabs. The tab list is the same one the user sees in the right sidebar.',
    {
      action: { type: 'string', enum: ['list', 'activate', 'open', 'reload', 'close'], description: 'Operation. Default list.' },
      tabId: tabArg,
      url: { type: 'string', description: 'For action=open: address to open in a new tab.' },
      background: { type: 'boolean', description: 'For action=open: open without stealing focus.' },
    },
    async (a) => {
      const action = a.action ?? 'list'
      if (action === 'list') return { tabs: hub.tabs, activeTabId: hub.activeTabId }
      const value = await hub.command('tabs', { action, tabId: a.tabId ?? null, url: a.url ?? null, background: a.background === true })
      return value
    },
    'Shared browser tabs',
    [])

  tool('bb_open',
    'Open an address in the shared browser and wait until it is usable. If no Browser tab exists yet, this opens one. Returns the tab id, final URL and title.',
    {
      url: { type: 'string', description: 'http(s) address to open.' },
      newTab: { type: 'boolean', description: 'Open in a new tab instead of the active one.' },
      waitMs: { type: 'number', description: 'How long to wait for load. Default 15000.' },
    },
    async (a) => hub.command('open', { url: a.url, newTab: a.newTab === true, waitMs: a.waitMs ?? 15000 }, { timeoutMs: (a.waitMs ?? 15000) + 10000 }),
    'Open in shared browser',
    ['url'])

  tool('bb_navigate',
    'Navigate the active tab (or tabId) to an address, with optional back/forward/reload.',
    {
      url: { type: 'string', description: 'Address to load. Omit for a history move.' },
      action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload', 'stop'], description: 'Default goto when url is given, otherwise reload.' },
      tabId: tabArg,
      waitMs: { type: 'number', description: 'How long to wait for load. Default 15000.' },
    },
    async (a) => hub.command('navigate', { ...a }, { timeoutMs: (a.waitMs ?? 15000) + 10000 }),
    'Navigate shared browser')

  tool('bb_snapshot',
    'Read the page as an accessibility-style tree with stable element refs (e1, e2, …). Use the refs with bb_click/bb_type instead of guessing selectors.',
    {
      tabId: tabArg,
      interactiveOnly: { type: 'boolean', description: 'Only interactive and labeled elements. Default false.' },
      maxChars: { type: 'number', description: 'Budget for the returned text. Default 20000.' },
      maxDepth: { type: 'number', description: 'DOM depth cap. Default 12.' },
    },
    async (a) => hub.command('snapshot', { ...a }, { timeoutMs: 15000 }),
    'Snapshot page')

  tool('bb_text',
    'Extract readable text from the page (main content first), optionally limited to one element.',
    {
      tabId: tabArg,
      selector: { type: 'string', description: 'Optional CSS selector to read instead of the whole page.' },
      maxChars: { type: 'number', description: 'Default 20000.' },
    },
    async (a) => hub.command('text', { ...a }, { timeoutMs: 15000 }),
    'Read page text')

  tool('bb_click',
    'Click an element in the shared browser: by ref from bb_snapshot, by CSS selector, or at viewport coordinates. The user sees the real click.',
    {
      ref: { type: 'string', description: 'Element ref from bb_snapshot (e12).' },
      selector: { type: 'string', description: 'CSS selector, or text= prefix for text match.' },
      x: { type: 'number', description: 'Viewport X for a coordinate click.' },
      y: { type: 'number', description: 'Viewport Y for a coordinate click.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
      clickCount: { type: 'number', description: 'Default 1; 2 double-clicks.' },
      tabId: tabArg,
    },
    async (a) => hub.command('click', { ...a }, { timeoutMs: 15000 }),
    'Click in shared browser')

  tool('bb_type',
    'Type text into a focused or selected control (ref/selector), optionally pressing Enter. Fires real input events, so site listeners run.',
    {
      ref: { type: 'string', description: 'Element ref from bb_snapshot.' },
      selector: { type: 'string', description: 'CSS selector or text= match.' },
      text: { type: 'string', description: 'Text to type.' },
      clear: { type: 'boolean', description: 'Clear the field first. Default true.' },
      submit: { type: 'boolean', description: 'Press Enter afterwards.' },
      delayMs: { type: 'number', description: 'Per-character delay. Default 8.' },
      tabId: tabArg,
    },
    async (a) => hub.command('type', { ...a }, { timeoutMs: 20000 }),
    'Type in shared browser',
    ['text'])

  tool('bb_press',
    'Press a key or chord in the page (Enter, Tab, Escape, Control+A, Meta+K, ArrowDown, F5 …).',
    {
      keys: { type: 'string', description: 'Key or chord, e.g. "Control+Shift+R".' },
      tabId: tabArg,
    },
    async (a) => hub.command('press', { ...a }, { timeoutMs: 10000 }),
    'Press keys',
    ['keys'])

  tool('bb_wait',
    'Wait for a selector, a text snippet, or the document to reach readyState complete.',
    {
      selector: { type: 'string', description: 'CSS selector to wait for.' },
      text: { type: 'string', description: 'Visible text to wait for.' },
      state: { type: 'string', enum: ['visible', 'hidden'], description: 'Default visible.' },
      timeoutMs: { type: 'number', description: 'Default 10000.' },
      tabId: tabArg,
    },
    async (a) => hub.command('wait', { ...a }, { timeoutMs: (a.timeoutMs ?? 10000) + 5000 }),
    'Wait for page state')

  tool('bb_eval',
    'Evaluate JavaScript in the page main world and return its value. Use for data the snapshot cannot express; prefer bb_text/bb_snapshot for reading.',
    {
      expression: { type: 'string', description: 'Expression or body to evaluate. A Promise is awaited.' },
      awaitPromise: { type: 'boolean', description: 'Default true.' },
      tabId: tabArg,
    },
    async (a) => hub.command('evaluate', { ...a }, { timeoutMs: 20000 }),
    'Evaluate in page',
    ['expression'])

  tool('bb_screenshot',
    'Capture the visible tab (or one element) as a PNG and save it under the DSH home. Returns the absolute path, so you can attach it or read it back.',
    {
      selector: { type: 'string', description: 'Capture only this element.' },
      fullPage: { type: 'boolean', description: 'Capture the whole scrollable page. Default false.' },
      name: { type: 'string', description: 'File name prefix.' },
      tabId: tabArg,
    },
    async (a) => {
      const capture = await hub.command('screenshot', { ...a }, { timeoutMs: 30000 })
      return storeCapture(capture, 'screenshot')
    },
    'Screenshot shared browser')

  tool('bb_region_screenshot',
    'Capture a rectangle of the tab (viewport coordinates, CSS pixels) as a PNG. Use it for a region the user is talking about.',
    {
      x: { type: 'number', description: 'Left edge in CSS pixels.' },
      y: { type: 'number', description: 'Top edge in CSS pixels.' },
      width: { type: 'number', description: 'Width in CSS pixels.' },
      height: { type: 'number', description: 'Height in CSS pixels.' },
      name: { type: 'string', description: 'File name prefix.' },
      tabId: tabArg,
    },
    async (a) => {
      const capture = await hub.command('regionScreenshot', { ...a }, { timeoutMs: 30000 })
      return storeCapture(capture, 'region')
    },
    'Region screenshot',
    ['x', 'y', 'width', 'height'])

  tool('bb_console',
    'Read console output (console.* calls, page errors and unhandled rejections) captured from the shared browser. Newest last.',
    {
      level: { type: 'string', enum: ['error', 'warning', 'info', 'debug', 'verbose'], description: 'Only this level.' },
      levelAtLeast: { type: 'string', enum: ['error', 'warning', 'info', 'debug'], description: 'This level or more severe.' },
      limit: { type: 'number', description: 'Default 100, max 1000.' },
      since: { type: 'number', description: 'Only entries at or after this epoch millisecond.' },
      tabId: tabArg,
      clear: { type: 'boolean', description: 'Drop the buffer after reading.' },
    },
    async (a) => {
      const rank = { error: 0, warning: 1, info: 2, debug: 3, verbose: 4 }
      let entries = hub.console({ level: a.level, limit: a.limit, tabId: a.tabId, since: a.since })
      if (typeof a.levelAtLeast === 'string') {
        const floor = rank[a.levelAtLeast] ?? 0
        entries = entries.filter(entry => (rank[entry.level] ?? 9) <= floor)
      }
      if (a.clear === true) hub.clear()
      return { count: entries.length, entries }
    },
    'Console log')

  tool('bb_network',
    'Read network activity captured from the page (fetch/XHR, method, status, duration, failures). Newest last.',
    {
      limit: { type: 'number', description: 'Default 50.' },
      failedOnly: { type: 'boolean', description: 'Only failed requests.' },
      filter: { type: 'string', description: 'Substring of the URL.' },
    },
    async (a) => {
      const entries = hub.network({ limit: a.limit, failedOnly: a.failedOnly === true, filter: a.filter })
      return { count: entries.length, entries }
    },
    'Network log')

  tool('bb_comment',
    'Attach a comment to an element of the shared browser, exactly as the user\'s comment tool does. Omit ref/selector to comment on the element the user picked last.',
    {
      ref: { type: 'string', description: 'Element ref from bb_snapshot or from bb_comments.' },
      selector: { type: 'string', description: 'CSS selector.' },
      note: { type: 'string', description: 'Comment body.' },
      tabId: tabArg,
    },
    async (a) => {
      const comment = await hub.command('comment', { ...a }, { timeoutMs: 15000 })
      hub.ingest({ type: 'comment', comment })
      return comment
    },
    'Comment element',
    ['note'])

  tool('bb_comments',
    'List element comments the user left in the shared browser (and any the agent added): selector, element text, the comment body, and the screenshot when captured.',
    {
      selector: { type: 'string', description: 'Only comments on this selector.' },
      tabId: tabArg,
      limit: { type: 'number', description: 'Default 50.' },
    },
    async (a) => {
      const comments = hub.commentsFor({ selector: a.selector, tabId: a.tabId, limit: a.limit })
      return { count: comments.length, comments }
    },
    'Element comments')

  tool('bb_find',
    'Find text in the page and scroll to the first match, like Ctrl+F. Returns the match count and a short excerpt.',
    {
      text: { type: 'string', description: 'Text to find.' },
      action: { type: 'string', enum: ['find', 'next', 'previous', 'stop'], description: 'Default find.' },
      tabId: tabArg,
    },
    async (a) => hub.command('find', { ...a }, { timeoutMs: 10000 }),
    'Find in page',
    ['text'])

  tool('bb_zoom',
    'Set or reset the page zoom factor, like Ctrl+= / Ctrl+- / Ctrl+NumPad0.',
    {
      action: { type: 'string', enum: ['in', 'out', 'reset', 'set'], description: 'Default reset.' },
      factor: { type: 'number', description: 'For action=set: 0.25 … 5.' },
      tabId: tabArg,
    },
    async (a) => hub.command('zoom', { ...a }, { timeoutMs: 8000 }),
    'Zoom page')

  tool('bb_devtools',
    'Open or close the shared browser\'s DevTools panel (console, elements, network, eval). The panel belongs to the browser UI, so the user sees the same window.',
    {
      action: { type: 'string', enum: ['open', 'close', 'toggle', 'status'], description: 'Default toggle.' },
      panel: { type: 'string', enum: ['console', 'elements', 'network', 'eval'], description: 'Panel to focus.' },
      tabId: tabArg,
    },
    async (a) => hub.command('devtools', { ...a }, { timeoutMs: 8000 }),
    'DevTools panel')

  tool('bb_storage',
    'Inspect or clear the site storage of the shared browser: cookies, localStorage, sessionStorage, caches and IndexedDB for the current origin (or every origin with scope=all).',
    {
      action: { type: 'string', enum: ['status', 'clear'], description: 'Default status.' },
      scope: { type: 'string', enum: ['origin', 'all'], description: 'Default all, matching the menu item.' },
      tabId: tabArg,
    },
    async (a) => hub.command('storage', { ...a }, { timeoutMs: 15000 }),
    'Site storage')

  tool('bb_permissions',
    'Report which site permissions the shared browser grants (camera, microphone, notifications, geolocation, popups, downloads) and why they are refused, plus the site the tab is on.',
    { tabId: tabArg },
    async (a) => hub.command('permissions', { ...a }, { timeoutMs: 8000 }),
    'Site permissions')

  tool('bb_history',
    'Read or clear the shared browser history (the same list the browser menu shows).',
    {
      action: { type: 'string', enum: ['list', 'clear'], description: 'Default list.' },
      query: { type: 'string', description: 'Filter by URL or title substring.' },
      limit: { type: 'number', description: 'Default 50.' },
    },
    async (a) => hub.command('history', { ...a }, { timeoutMs: 8000 }),
    'Browser history')

  tool('bb_emulate',
    'Switch the shared browser into device emulation (viewport size, device pixel ratio, touch, user agent) or leave it with mode=none. Used by the menu item 设备仿真.',
    {
      device: { type: 'string', enum: ['none', 'iphone-14', 'pixel-7', 'ipad-mini', 'galaxy-s23', 'desktop-720'], description: 'Preset. Default none.' },
      width: { type: 'number', description: 'Custom width in CSS pixels.' },
      height: { type: 'number', description: 'Custom height in CSS pixels.' },
      tabId: tabArg,
    },
    async (a) => hub.command('emulate', { ...a }, { timeoutMs: 10000 }),
    'Device emulation')

  tool('bb_add_to_chat',
    'Put something from the browser into the conversation as a draft attachment the user can review and send: a screenshot, a region, the picked element, or the console tail. Returns what was inserted.',
    {
      kind: { type: 'string', enum: ['screenshot', 'region', 'element', 'console'], description: 'What to add.' },
      note: { type: 'string', description: 'Optional sentence to insert with it.' },
      selector: { type: 'string', description: 'For kind=element: element to describe.' },
      ref: { type: 'string', description: 'For kind=element: ref from bb_snapshot.' },
      x: { type: 'number', description: 'For kind=region: left edge.' },
      y: { type: 'number', description: 'For kind=region: top edge.' },
      width: { type: 'number', description: 'For kind=region: width.' },
      height: { type: 'number', description: 'For kind=region: height.' },
      tabId: tabArg,
    },
    async (a) => hub.command('addToChat', { ...a }, { timeoutMs: 30000 }),
    'Add browser content to chat',
    ['kind'])

  tool('bb_open_devtools_native',
    'Explain how to reach the real Chromium DevTools for the app window, and report whether a remote debugging port is already reachable. Read-only.',
    {},
    async () => {
      const probe = async (port) => fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) })
        .then(async response => (response.ok ? { port, ok: true, info: await response.json() } : { port, ok: false }))
        .catch(() => ({ port, ok: false }))
      const [first, second] = await Promise.all([probe(9223), probe(9222)])
      const reachable = [first, second].filter(entry => entry.ok)
      return {
        reachable,
        note: reachable.length === 0
          ? 'The packaged app disables guest DevTools (devTools: !app.isPackaged). Use the in-app panel from bb_devtools; a native window needs a launch with --remote-debugging-port=9222.'
          : 'A debugging endpoint is reachable; open chrome://inspect or connect Playwright to it.',
        inAppPanel: 'bb_devtools action=open',
      }
    },
    'Native DevTools availability')

  // Keep the module importable in tests without a Cordis context.
  return { hub, version: VERSION }
}

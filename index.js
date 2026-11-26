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

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Hub, BridgeError, ROUTE_BASE, fence, readJson, replyError, replyJson } from './lib/bridge.mjs'
import { ExternalBrowser, detectBrowsers, profileRoot } from './lib/external.mjs'

export const name = 'dsh-shared-browser'
export const inject = ['tools']

const VERSION = '0.6.0'
const ATTACHMENT_PREFIX = `${ROUTE_BASE}/attachment?path=`

/** Tool output envelope: JSON text plus a generic card. */
const json = () => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
})

/** Present-call descriptor for the tool card. */
const present = (title, args) => ({ card: 'generic', title, kind: 'other', rawInput: args || {} })

/** Directory where screenshots and captured payloads are stored. */
const SETTINGS_FILE = 'settings.json'
const settingsRoot = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'shared-browser')

/** Read the small JSON settings file; defaults keep the in-app browser. */
async function readSettings() {
  try {
    const raw = await readFile(join(settingsRoot(), SETTINGS_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist a partial settings patch. */
async function writeSettings(patch) {
  const next = { ...(await readSettings()), ...patch }
  await mkdir(settingsRoot(), { recursive: true })
  await writeFile(join(settingsRoot(), SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

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
  /* Real Chromium channel: the user's own Edge/Chrome over CDP, used when the
     built-in webview cannot do the job (Cloudflare-class challenges, logins
     that must survive restarts, downloads, DevTools). */
  const external = new ExternalBrowser(() => {})
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

    /* The sidebar mirror polls these two routes: a PNG of the real page and a
       channel for pointer/keyboard events coming back from the pane. */
    disposers.push(webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/external/frame`,
      handler: route(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const tabId = url.searchParams.get('tab') ?? ''
        const capture = await external.command('screenshot', {}, tabId)
        const bytes = Buffer.from(String(capture.dataUrl ?? '').split(',')[1] ?? '', 'base64')
        if (bytes.length === 0) { replyError(res, 409, '外部页签没有画面。', 'empty'); return }
        res.writeHead(200, { 'content-type': capture.mime ?? 'image/png', 'cache-control': 'no-store', 'content-length': bytes.length })
        res.end(bytes)
      }),
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/external/command`,
      handler: route(async (req, res) => {
        if (req.method !== 'POST') { replyError(res, 405, 'POST only', 'method'); return }
        const body = await readJson(req)
        const tabId = String(body.tab ?? '')
        const value = await run(String(body.op ?? ''), { ...(body.args ?? {}), tabId })
        replyJson(res, { ok: true, value })
      }),
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/external/input`,
      handler: route(async (req, res) => {
        if (req.method !== 'POST') { replyError(res, 405, 'POST only', 'method'); return }
        const body = await readJson(req)
        replyJson(res, { ok: true, ...(await external.input(String(body.tab ?? ''), body)) })
      }),
    }))

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

  /** Built-in tabs known to sit on a challenge page. */
  const walledTabs = new Set()

  /** Guidance repeated in every result that lands on a bot wall. */
  const WALL_POLICY = '这是 Cloudflare/DataDome 等防自动程序页面：不要尝试完成或绕过人机验证，也不要点击验证控件。请把情况告诉用户，让用户在弹出的真实浏览器窗口里自行验证，或改用其它数据源。'

  /**
   * Flag a challenge page from its title or body text.
   * @param {object|null} value - snapshot or text result.
   * @returns {{wall: boolean, hint: string}} wall flag plus guidance.
   */
  const wallInfo = (value) => {
    const title = String(value?.title ?? '')
    const body = String(value?.text ?? '')
    const wall = CHALLENGE.test(title) === true || CHALLENGE.test(body) === true
    return { wall, hint: WALL_POLICY }
  }

  /** Bot walls that never clear inside an Electron webview. */
  const CHALLENGE = /请稍候|正在进行安全验证|访问暂时受限|Just a moment|Verify you are human|challenge-platform|\bcf-\w+/i

  /**
   * True when the built-in tab is sitting on a challenge page.
   * @param {unknown} opened - result of the built-in open command.
   * @returns {Promise<boolean>} whether the page is a bot wall.
   */
  const looksLikeChallenge = async (opened) => {
    const tabId = opened !== null && typeof opened === 'object' ? opened.tabId : null
    const title = String(opened?.title ?? '')
    if (CHALLENGE.test(title) === true) return true
    const probe = await hub.command('text', { tabId, maxChars: 600 }, { timeoutMs: 8000 }).catch(() => null)
    const text = String(probe?.text ?? '')
    return text !== '' && CHALLENGE.test(text)
  }

  /**
   * Move a walled page into the user's real browser, mirror it into the sidebar,
   * and report the new tab.
   * @param {string} target - address that hit the wall.
   * @returns {Promise<object>} external tab descriptor.
   */
  /** Compare addresses ignoring a trailing slash, which Edge adds on its own. */
  const normaliseUrl = value => String(value ?? '').replace(/\/+$/, '')
  /** Pick the tab that actually shows the target, else the newest one. */
  const pickTab = (tabs, target) => tabs.find(entry => normaliseUrl(entry.url) === normaliseUrl(target)) ?? tabs[tabs.length - 1]

  const handOff = async (target) => {
    const state = await external.ensure({ url: target })
    const tabs = await external.listTabs()
    const tab = pickTab(tabs, target)
    const tabId = tab === undefined ? 'ext:unknown' : `ext:${tab.id}`
    hub.command('ensure', { url: target, external: tabId }, { timeoutMs: 8000 }).catch(() => {})
    return { channel: 'external', handoff: 'challenge', tabId, url: tab?.url ?? target, title: tab?.title ?? '', browser: state.browser?.name ?? null, note: '内置浏览器被 Cloudflare 类防护拦截，已自动切换到外部浏览器。', hint: `${WALL_POLICY}验证请在已弹出的外部浏览器窗口里由用户完成。` }
  }

  /** Route a command to the external channel when the tab id says so. */
  const isExternal = tabId => typeof tabId === 'string' && tabId.startsWith('ext:')
  const run = (op, args = {}, options) => {
    const tabId = args !== null && typeof args === 'object' ? args.tabId : undefined
    if (isExternal(tabId)) return external.command(op, args, tabId)
    return hub.command(op, args, options)
  }

  tool('bb_status',
    'Read the shared-browser state: whether a Browser tab is attached, every open tab, and how much console/network/comment data is held. Read-only; start here when something looks disconnected.',
    {},
    async () => ({ version: VERSION, ...hub.status(), attachmentsDir: attachmentsRoot(), wallPolicy: WALL_POLICY }),
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
      if (action === 'list') {
        const externalTabs = external.running === true ? (await external.command('tabs', {}).catch(() => ({ tabs: [] }))).tabs : []
        return { tabs: [...hub.tabs, ...externalTabs], activeTabId: hub.activeTabId, external: external.summary() }
      }
      if (isExternal(a.tabId)) return external.command(action === 'activate' ? 'tabs' : action, { tabId: a.tabId, url: a.url })
      const value = await hub.command('tabs', { action, tabId: a.tabId ?? null, url: a.url ?? null, background: a.background === true })
      return value
    },
    'Shared browser tabs',
    [])

  tool('bb_open',
    'Open an address in the shared browser and wait until it is usable. If no Browser tab exists yet, this opens one. Returns the tab id, final URL and title. Cloudflare-class challenges are handed to the external browser automatically; never try to solve the verification, ask the user to finish it in the real window.',
    {
      url: { type: 'string', description: 'http(s) address to open.' },
      newTab: { type: 'boolean', description: 'Open in a new tab instead of the active one.' },
      channel: { type: 'string', enum: ['builtin', 'external'], description: 'Which browser drives the page. builtin is the in-app webview; external is the user own Edge/Chrome over CDP, with real fingerprints, persistent logins and working DevTools.' },
      waitMs: { type: 'number', description: 'How long to wait for load. Default 15000.' },
    },
    async (a) => {
      const target = String(a.url ?? '')
      const waitMs = a.waitMs ?? 15000
      const settings = await readSettings()
      const channel = a.channel ?? (settings.channel === 'external' ? 'external' : 'builtin')
      if (channel === 'external') {
        const state = await external.ensure({ url: target })
        const tabs = await external.listTabs()
        const tab = pickTab(tabs, target)
        const tabId = tab === undefined ? 'ext:unknown' : `ext:${tab.id}`
        /* Mirror the tab into the sidebar so the user can watch the same page. */
        hub.command('ensure', { url: target, external: tabId }, { timeoutMs: 8000 }).catch(() => {})
        return { channel: 'external', tabId, url: tab?.url ?? target, title: tab?.title ?? '', browser: state.browser?.name ?? null, profileDir: state.profileDir }
      }
      /* Ask the page to open a pane first: the user should not have to open the
         browser before an Agent can use it. */
      const ensured = await hub.command('ensure', { url: target }, { timeoutMs: 8000 }).catch(error => ({ opened: false, reason: String(error && error.message ? error.message : error) }))
      if (ensured !== null && ensured.opened === true) {
        /* The new pane loads `params.url` by itself; give it a moment, then report
           the tab the client registered. */
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 400))
          const tab = hub.status().tabs.find(entry => entry.visible === true)
          if (tab !== undefined) {
            if (settings.autoLaunch !== false && (await looksLikeChallenge({ tabId: tab.id, title: tab.title })) === true) {
              await hub.command('tabs', { action: 'close', tabId: tab.id }).catch(() => {})
              return await handOff(target)
            }
            return { tabId: tab.id, url: tab.url || target, title: tab.title ?? '', opened: true }
          }
        }
        return { opened: true, url: target, pending: true }
      }
      const opened = await hub.command('open', { url: target, newTab: a.newTab === true, waitMs }, { timeoutMs: waitMs + 10000 })
      /* Cloudflare-class walls never resolve inside the Electron webview. Hand the
         page to the user's real browser instead of leaving a dead tab behind. */
      const wall = await looksLikeChallenge(opened)
      if (wall === true) {
        await hub.command('tabs', { action: 'close', tabId: opened?.tabId ?? null }).catch(() => {})
        if (settings.autoLaunch === false) {
          if (typeof opened?.tabId === 'string') walledTabs.add(opened.tabId)
          return { channel: 'builtin', wall: true, ...opened, hint: WALL_POLICY, note: '页面被 Cloudflare 类防护拦截；在 bb_settings 里打开 autoLaunch 可自动切换外部浏览器。' }
        }
        return await handOff(target)
      }
      return opened
    },
    'Open in shared browser',
    ['url'])

  tool('bb_settings',
    'Read or change how the browser is driven: default channel (builtin|external), preferred external browser, and the profile folder used for persistent logins.',
    {
      action: { type: 'string', enum: ['get', 'set'], description: 'Operation. Default get.' },
      channel: { type: 'string', enum: ['builtin', 'external'], description: 'Default channel for bb_open.' },
      browser: { type: 'string', enum: ['msedge', 'chrome'], description: 'Preferred external browser.' },
      profileDir: { type: 'string', description: 'Folder for the external profile. Empty restores the default.' },
      autoLaunch: { type: 'boolean', description: 'Switch to the external browser automatically when the built-in one hits a bot wall. Default true.' },
    },
    async (a) => {
      if (a.action === 'set') {
        const patch = {}
        if (a.channel !== undefined) patch.channel = a.channel
        if (a.browser !== undefined) patch.browser = a.browser
        if (a.profileDir !== undefined) patch.profileDir = a.profileDir
        if (a.autoLaunch !== undefined) patch.autoLaunch = a.autoLaunch === true
        const settings = await writeSettings(patch)
        return { settings, path: join(settingsRoot(), SETTINGS_FILE) }
      }
      return { settings: await readSettings(), path: join(settingsRoot(), SETTINGS_FILE), profileRoot: profileRoot(), candidates: detectBrowsers() }
    },
    'Browser settings')

  tool('bb_external',
    'Manage the external Chromium channel: report which Edge/Chrome is installed, launch it with a persistent profile, or close it. Use this when a site rejects the built-in browser (Cloudflare-class challenges, downloads, logins that must survive restarts).',
    {
      action: { type: 'string', enum: ['status', 'launch', 'close'], description: 'Operation. Default status.' },
      browser: { type: 'string', enum: ['msedge', 'chrome'], description: 'Preferred browser for launch.' },
      url: { type: 'string', description: 'Address for action=launch.' },
    },
    async (a) => {
      const action = a.action ?? 'status'
      if (action === 'launch') {
        const settings = await readSettings()
        await external.ensure({ url: a.url ?? 'about:blank', browser: a.browser ?? settings.browser, profileDir: settings.profileDir || undefined })
        return { launched: true, ...external.summary(), candidates: detectBrowsers() }
      }
      if (action === 'close') {
        await external.shutdown(true)
        return { running: false }
      }
      return { ...external.summary(), candidates: detectBrowsers(), profileRoot: profileRoot() }
    },
    'External browser channel')

  tool('bb_navigate',
    'Navigate the active tab (or tabId) to an address, with optional back/forward/reload.',
    {
      url: { type: 'string', description: 'Address to load. Omit for a history move.' },
      action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload', 'stop'], description: 'Default goto when url is given, otherwise reload.' },
      tabId: tabArg,
      waitMs: { type: 'number', description: 'How long to wait for load. Default 15000.' },
    },
    async (a) => run('navigate', { ...a }, { timeoutMs: (a.waitMs ?? 15000) + 10000 }),
    'Navigate shared browser')

  tool('bb_snapshot',
    'Read the page as an accessibility-style tree with stable element refs (e1, e2, …). Use the refs with bb_click/bb_type instead of guessing selectors. A result carrying wall:true is an anti-bot challenge: never try to solve it.',
    {
      tabId: tabArg,
      interactiveOnly: { type: 'boolean', description: 'Only interactive and labeled elements. Default false.' },
      maxChars: { type: 'number', description: 'Budget for the returned text. Default 20000.' },
      maxDepth: { type: 'number', description: 'DOM depth cap. Default 12.' },
    },
    async (a) => {
      try {
        const value = await run('snapshot', { ...a }, { timeoutMs: 15000 })
        return { ...value, ...wallInfo(value) }
      } catch (error) {
        const tabId = typeof a.tabId === 'string' ? a.tabId : hub.status().activeTabId
        const tab = hub.status().tabs.find(entry => entry.id === tabId)
        const walled = walledTabs.has(tabId) || CHALLENGE.test(String(tab?.title ?? '')) === true
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(walled === true ? `${message} ${WALL_POLICY}` : message)
      }
    },
    'Snapshot page')

  tool('bb_text',
    'Extract readable text from the page (main content first), optionally limited to one element. A result carrying wall:true is an anti-bot challenge: never try to solve it.',
    {
      tabId: tabArg,
      selector: { type: 'string', description: 'Optional CSS selector to read instead of the whole page.' },
      maxChars: { type: 'number', description: 'Default 20000.' },
    },
    async (a) => {
      try {
        const value = await run('text', { ...a }, { timeoutMs: 15000 })
        return { ...value, ...wallInfo(value) }
      } catch (error) {
        const tabId = typeof a.tabId === 'string' ? a.tabId : hub.status().activeTabId
        const tab = hub.status().tabs.find(entry => entry.id === tabId)
        const walled = walledTabs.has(tabId) || CHALLENGE.test(String(tab?.title ?? '')) === true
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(walled === true ? `${message} ${WALL_POLICY}` : message)
      }
    },
    'Read page text')

  tool('bb_click',
    'Click an element in the shared browser: by ref from bb_snapshot, by CSS selector, or at viewport coordinates. The user sees the real click. Do not use it on anti-bot verification widgets (Cloudflare, DataDome, I-am-not-a-robot): hand those to the user instead.',
    {
      ref: { type: 'string', description: 'Element ref from bb_snapshot (e12).' },
      selector: { type: 'string', description: 'CSS selector, or text= prefix for text match.' },
      x: { type: 'number', description: 'Viewport X for a coordinate click.' },
      y: { type: 'number', description: 'Viewport Y for a coordinate click.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
      clickCount: { type: 'number', description: 'Default 1; 2 double-clicks.' },
      tabId: tabArg,
    },
    async (a) => {
      const tabId = typeof a.tabId === 'string' ? a.tabId : hub.status().activeTabId
      if (walledTabs.has(tabId) === true) return { clicked: false, wall: true, hint: WALL_POLICY }
      return run('click', { ...a }, { timeoutMs: 15000 })
    },
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
    async (a) => run('type', { ...a }, { timeoutMs: 20000 }),
    'Type in shared browser',
    ['text'])

  tool('bb_press',
    'Press a key or chord in the page (Enter, Tab, Escape, Control+A, Meta+K, ArrowDown, F5 …).',
    {
      keys: { type: 'string', description: 'Key or chord, e.g. "Control+Shift+R".' },
      tabId: tabArg,
    },
    async (a) => run('press', { ...a }, { timeoutMs: 10000 }),
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
    async (a) => run('wait', { ...a }, { timeoutMs: (a.timeoutMs ?? 10000) + 5000 }),
    'Wait for page state')

  tool('bb_eval',
    'Evaluate JavaScript in the page main world and return its value. Use for data the snapshot cannot express; prefer bb_text/bb_snapshot for reading.',
    {
      expression: { type: 'string', description: 'Expression or body to evaluate. A Promise is awaited.' },
      awaitPromise: { type: 'boolean', description: 'Default true.' },
      tabId: tabArg,
    },
    async (a) => run('evaluate', { ...a }, { timeoutMs: 20000 }),
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
      const capture = await run('screenshot', { ...a }, { timeoutMs: 30000 })
      const value = await storeCapture(capture, 'screenshot')
      const tabId = typeof a.tabId === 'string' ? a.tabId : hub.status().activeTabId
      const title = String(hub.status().tabs.find(entry => entry.id === tabId)?.title ?? '')
      return { ...value, ...wallInfo({ title }) }
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
      const capture = await run('regionScreenshot', { ...a }, { timeoutMs: 30000 })
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
      let entries = isExternal(a.tabId)
        ? (await external.command('console', {})).entries ?? []
        : hub.console({ level: a.level, limit: a.limit, tabId: a.tabId, since: a.since })
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
      const entries = isExternal(a.tabId)
        ? (await external.command('network', { failedOnly: a.failedOnly === true, filter: a.filter })).entries ?? []
        : hub.network({ limit: a.limit, failedOnly: a.failedOnly === true, filter: a.filter })
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
      const comment = await run('comment', { ...a }, { timeoutMs: 15000 })
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
    async (a) => run('find', { ...a }, { timeoutMs: 10000 }),
    'Find in page',
    ['text'])

  tool('bb_zoom',
    'Set or reset the page zoom factor, like Ctrl+= / Ctrl+- / Ctrl+NumPad0.',
    {
      action: { type: 'string', enum: ['in', 'out', 'reset', 'set'], description: 'Default reset.' },
      factor: { type: 'number', description: 'For action=set: 0.25 … 5.' },
      tabId: tabArg,
    },
    async (a) => run('zoom', { ...a }, { timeoutMs: 8000 }),
    'Zoom page')

  tool('bb_devtools',
    'Open or close the shared browser\'s DevTools panel (console, elements, network, eval). The panel belongs to the browser UI, so the user sees the same window.',
    {
      action: { type: 'string', enum: ['open', 'close', 'toggle', 'status'], description: 'Default toggle.' },
      panel: { type: 'string', enum: ['console', 'elements', 'network', 'eval'], description: 'Panel to focus.' },
      tabId: tabArg,
    },
    async (a) => run('devtools', { ...a }, { timeoutMs: 8000 }),
    'DevTools panel')

  tool('bb_storage',
    'Inspect or clear the site storage of the shared browser: cookies, localStorage, sessionStorage, caches and IndexedDB for the current origin (or every origin with scope=all).',
    {
      action: { type: 'string', enum: ['status', 'clear'], description: 'Default status.' },
      scope: { type: 'string', enum: ['origin', 'all'], description: 'Default all, matching the menu item.' },
      tabId: tabArg,
    },
    async (a) => run('storage', { ...a }, { timeoutMs: 15000 }),
    'Site storage')

  tool('bb_permissions',
    'Report which site permissions the shared browser grants (camera, microphone, notifications, geolocation, popups, downloads) and why they are refused, plus the site the tab is on.',
    { tabId: tabArg },
    async (a) => run('permissions', { ...a }, { timeoutMs: 8000 }),
    'Site permissions')

  tool('bb_history',
    'Read or clear the shared browser history (the same list the browser menu shows).',
    {
      action: { type: 'string', enum: ['list', 'clear'], description: 'Default list.' },
      query: { type: 'string', description: 'Filter by URL or title substring.' },
      limit: { type: 'number', description: 'Default 50.' },
    },
    async (a) => run('history', { ...a }, { timeoutMs: 8000 }),
    'Browser history')

  tool('bb_emulate',
    'Switch the shared browser into device emulation (viewport size, device pixel ratio, touch, user agent) or leave it with mode=none. Used by the menu item 设备仿真.',
    {
      device: { type: 'string', enum: ['none', 'iphone-14', 'pixel-7', 'ipad-mini', 'galaxy-s23', 'desktop-720'], description: 'Preset. Default none.' },
      width: { type: 'number', description: 'Custom width in CSS pixels.' },
      height: { type: 'number', description: 'Custom height in CSS pixels.' },
      tabId: tabArg,
    },
    async (a) => run('emulate', { ...a }, { timeoutMs: 10000 }),
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
    async (a) => run('addToChat', { ...a }, { timeoutMs: 30000 }),
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

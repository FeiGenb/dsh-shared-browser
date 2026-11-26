/**
 * Host-side hub for the shared browser.
 *
 * The browser UI (a Client plugin) owns the Electron <webview>. The Host owns
 * the tool surface. They meet here:
 *
 *   Host  --SSE /events-->  Client      (commands: navigate, click, screenshot…)
 *   Host  <--POST /report-- Client      (results, tab list, console, comments)
 *
 * Nothing in this file knows about DSH internals; index.js wires it to routes
 * and tools. One Client instance is attached at a time (the newest stream wins,
 * so a reloaded window never leaves a dead stream behind).
 * @module dsh-shared-browser/lib/bridge
 */

import { randomUUID } from 'node:crypto'

/** Absolute prefix of every route this bundle registers. */
export const ROUTE_BASE = '/dsh-shared-browser'

const KEEPALIVE_MS = 15000
const DEFAULT_TIMEOUT_MS = 20000
const MAX_CONSOLE = 2000
const MAX_NETWORK = 600
const MAX_COMMENTS = 1000

/** Console levels the page can report, most severe first. */
export const CONSOLE_LEVELS = ['error', 'warning', 'info', 'debug', 'verbose']

/** Trim an array to its newest `limit` entries, in place. */
function trim(list, limit) {
  if (list.length > limit) list.splice(0, list.length - limit)
}

/** One error the caller can present verbatim. */
export class BridgeError extends Error {
  /** @param {string} message - user-facing sentence. @param {string} [code] - machine tag. */
  constructor(message, code = 'unavailable') {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/** Command router between the Host tools and the Client browser UI. */
export class Hub {
  /** @param {{ attachmentsDir?: string }} [options] - where screenshots land. */
  constructor(options = {}) {
    /** @type {{ id: string, res: import('node:http').ServerResponse, sessionId: string | null, since: number } | null} */
    this.stream = null
    /** @type {Array<Record<string, unknown>>} */
    this.tabs = []
    /** @type {string | null} */
    this.activeTabId = null
    /** @type {Array<Record<string, unknown>>} */
    this.consoleLog = []
    /** @type {Array<Record<string, unknown>>} */
    this.networkLog = []
    /** @type {Array<Record<string, unknown>>} */
    this.comments = []
    /** @type {Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    /** @type {number} */
    this.lastSeen = 0
    /** @type {string | null} */
    this.lastTabKey = null
    /** @type {string} */
    this.attachmentsDir = options.attachmentsDir ?? ''
    /** @type {string | null} */
    this.version = null
  }

  /** Whether a Client UI is currently streaming to this Host. @returns {boolean} */
  get connected() {
    return this.stream !== null
  }

  /**
   * Attach the newest SSE stream, dropping any previous one.
   * @param {import('node:http').ServerResponse} res - long-lived response.
   * @param {{ sessionId?: string | null, version?: string | null }} [meta] - client identity.
   */
  attach(res, meta = {}) {
    if (this.stream !== null) {
      try { this.stream.res.end() } catch { /* the old stream is already gone */ }
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    const stream = { id: randomUUID(), res, sessionId: meta.sessionId ?? null, since: Date.now() }
    this.stream = stream
    this.lastSeen = Date.now()
    if (typeof meta.version === 'string') this.version = meta.version
    const keepalive = setInterval(() => {
      if (this.stream !== stream) return clearInterval(keepalive)
      try { res.write(': ping\n\n') } catch { /* dropped below */ }
    }, KEEPALIVE_MS)
    res.on('close', () => {
      clearInterval(keepalive)
      if (this.stream === stream) this.stream = null
      this.failAll(new BridgeError('浏览器页签已关闭或页面已刷新，命令已中止。', 'detached'))
    })
    res.on('error', () => { try { res.destroy() } catch { /* already closed */ } })
  }

  /** Drop the current stream (used on Host shutdown). */
  detach() {
    if (this.stream === null) return
    try { this.stream.res.end() } catch { /* already closed */ }
    this.stream = null
    this.failAll(new BridgeError('浏览器桥已断开。', 'detached'))
  }

  /**
   * Send one event to the attached Client.
   * @param {string} event - SSE event name.
   * @param {unknown} payload - JSON payload.
   * @returns {boolean} whether it reached a live stream.
   */
  emit(event, payload) {
    if (this.stream === null) return false
    try {
      this.stream.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      return true
    } catch {
      this.stream = null
      return false
    }
  }

  /** Reject every in-flight command. @param {Error} error - reason. */
  failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /**
   * Run one operation in the Client and await its result.
   * @param {string} op - operation name understood by the Client.
   * @param {Record<string, unknown>} [args] - operation arguments.
   * @param {{ timeoutMs?: number, tabId?: string | null }} [options] - command options.
   * @returns {Promise<unknown>} the Client's result value.
   */
  command(op, args = {}, options = {}) {
    if (this.stream === null) {
      return Promise.reject(new BridgeError(
        '浏览器页签没有连接。先让用户在右侧栏打开 Browser 页签（或调用 bb_open），再执行该操作。',
        'not-connected',
      ))
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const id = randomUUID()
    const target = options.tabId ?? this.activeTabId
    const payload = { id, op, args, tabId: target, sentAt: Date.now() }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError(`浏览器命令 ${op} 超时（${timeoutMs}ms 未返回）。`, 'timeout'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      if (!this.emit('command', payload)) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new BridgeError('浏览器页签没有连接。', 'not-connected'))
      }
    })
  }

  /**
   * Ingest one POST /report body from the Client.
   * @param {Record<string, any>} body - report payload.
   * @returns {{ ok: true, notice?: string }} acknowledgement.
   */
  ingest(body) {
    this.lastSeen = Date.now()
    switch (body?.type) {
      case 'result': {
        const entry = this.pending.get(body.id)
        if (entry === undefined) return { ok: true }
        this.pending.delete(body.id)
        clearTimeout(entry.timer)
        if (body.ok) entry.resolve(body.value)
        else entry.reject(new BridgeError(String(body.error ?? '浏览器操作失败。'), 'client-error'))
        return { ok: true }
      }
      case 'tabs': {
        this.tabs = Array.isArray(body.tabs) ? body.tabs.slice(0, 50) : []
        this.activeTabId = typeof body.activeTabId === 'string' ? body.activeTabId : null
        return { ok: true }
      }
      case 'console': {
        const entries = Array.isArray(body.entries) ? body.entries : []
        this.consoleLog.push(...entries)
        trim(this.consoleLog, MAX_CONSOLE)
        return { ok: true }
      }
      case 'network': {
        const entries = Array.isArray(body.entries) ? body.entries : []
        this.networkLog.push(...entries)
        trim(this.networkLog, MAX_NETWORK)
        return { ok: true }
      }
      case 'comment': {
        if (typeof body.comment?.id !== 'string') return { ok: false, notice: 'comment needs an id' }
        this.comments = this.comments.filter(entry => entry.id !== body.comment.id)
        this.comments.push(body.comment)
        trim(this.comments, MAX_COMMENTS)
        return { ok: true, notice: 'comment stored' }
      }
      case 'detach': {
        this.failAll(new BridgeError('浏览器页签已关闭。', 'detached'))
        return { ok: true }
      }
      case 'hello': {
        if (typeof body.version === 'string') this.version = body.version
        if (typeof body.sessionId === 'string' && this.stream !== null) this.stream.sessionId = body.sessionId
        return { ok: true, notice: 'hello' }
      }
      default:
        return { ok: false, notice: `unknown report type: ${String(body?.type)}` }
    }
  }

  /** Console entries, newest last, filtered and bounded. @param {{ level?: string, limit?: number, tabId?: string | null, since?: number }} [query] - filter. @returns {Array<object>} matching entries. */
  console(query = {}) {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000)
    return this.consoleLog
      .filter(entry => (query.level === undefined || entry.level === query.level))
      .filter(entry => (query.tabId == null || entry.tabId === query.tabId))
      .filter(entry => (typeof query.since === 'number' ? Number(entry.ts) >= query.since : true))
      .slice(-limit)
  }

  /** Network entries, newest last. @param {{ limit?: number, failedOnly?: boolean, filter?: string }} [query] - filter. @returns {Array<object>} matching entries. */
  network(query = {}) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500)
    const needle = typeof query.filter === 'string' ? query.filter.toLowerCase() : ''
    return this.networkLog
      .filter(entry => (query.failedOnly === true ? entry.ok !== true : true))
      .filter(entry => (needle === '' ? true : String(entry.url).toLowerCase().includes(needle)))
      .slice(-limit)
  }

  /** Comments, newest last. @param {{ selector?: string, tabId?: string | null, limit?: number }} [query] - filter. @returns {Array<object>} matching comments. */
  commentsFor(query = {}) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500)
    return this.comments
      .filter(entry => (query.selector === undefined ? true : entry.selector === query.selector))
      .filter(entry => (query.tabId == null ? true : entry.tabId === query.tabId))
      .slice(-limit)
  }

  /** Drop captured telemetry (console, network, optionally comments). @param {{ comments?: boolean }} [options] - what to clear. @returns {{ cleared: string[] }} what was dropped. */
  clear(options = {}) {
    const cleared = []
    if (this.consoleLog.length > 0) { this.consoleLog = []; cleared.push('console') }
    if (this.networkLog.length > 0) { this.networkLog = []; cleared.push('network') }
    if (options.comments === true && this.comments.length > 0) { this.comments = []; cleared.push('comments') }
    return { cleared }
  }

  /** One JSON-safe status snapshot for tools and /state. @returns {Record<string, unknown>} status. */
  status() {
    return {
      connected: this.connected,
      clientVersion: this.version,
      sessionId: this.stream?.sessionId ?? null,
      streamingSince: this.stream === null ? null : new Date(this.stream.since).toISOString(),
      activeTabId: this.activeTabId,
      tabs: this.tabs,
      consoleEntries: this.consoleLog.length,
      networkEntries: this.networkLog.length,
      comments: this.comments.length,
      pendingCommands: this.pending.size,
      lastSeen: this.lastSeen === 0 ? null : new Date(this.lastSeen).toISOString(),
    }
  }
}

/**
 * Reject a request that did not come from this Host's own UI.
 *
 * Both carriers reach us the same way in practice: the desktop shell proxies
 * the renderer's fetch through its own authenticated connection and strips the
 * browser's Origin/Host headers, while the Web carrier sends a same-origin
 * request. So the fence accepts a loopback Host header and, when an Origin is
 * present, requires it to name the same authority.
 * @param {import('node:http').IncomingMessage} req - candidate request.
 * @param {string} [origin] - this server's origin, when known.
 * @returns {string | null} a refusal sentence, or null when the request is fine.
 */
export function fence(req, origin) {
  const host = String(req.headers.host ?? '')
  const hostname = host.replace(/:\d+$/u, '').replace(/^\[|\]$/gu, '').toLowerCase()
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1'
    || /^127\./u.test(hostname)
  let ownHost = ''
  try { ownHost = origin === undefined ? '' : new URL(origin).host.toLowerCase() } catch { ownHost = '' }
  if (!loopback && host.toLowerCase() !== ownHost) {
    return `拒绝来自非本机地址的请求（Host: ${host || 'missing'}）。`
  }
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site === 'cross-site') return '拒绝跨站请求。'
  const requestOrigin = req.headers.origin
  if (typeof requestOrigin === 'string' && requestOrigin !== '') {
    let requestHost = ''
    try { requestHost = new URL(requestOrigin).host.toLowerCase() } catch { return '拒绝来源不明的请求（Origin 无法解析）。' }
    if (requestHost !== host.toLowerCase() && requestHost !== ownHost) return '拒绝跨源请求。'
  }
  return null
}

/**
 * Read a JSON body with a hard size cap.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} [limitBytes] - cap.
 * @returns {Promise<Record<string, any>>} parsed body.
 */
export async function readJson(req, limitBytes = 24 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new BridgeError(`请求体超过 ${Math.round(limitBytes / 1024 / 1024)}MB 上限。`, 'too-large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new BridgeError('请求体不是合法 JSON。', 'bad-json')
  }
}

/**
 * Answer a request that failed before producing a payload.
 * @param {import('node:http').ServerResponse} res - response to finish.
 * @param {number} status - HTTP status.
 * @param {string} message - human sentence.
 * @param {string} [code] - machine tag.
 */
export function replyError(res, status, message, code = 'error') {
  if (res.headersSent) { try { res.end() } catch { /* already finished */ } return }
  const body = JSON.stringify({ ok: false, error: message, code })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Answer a request with one JSON value.
 * @param {import('node:http').ServerResponse} res - response to finish.
 * @param {unknown} value - JSON payload.
 * @param {number} [status] - HTTP status.
 */
export function replyJson(res, value, status = 200) {
  if (res.headersSent) { try { res.end() } catch { /* already finished */ } return }
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

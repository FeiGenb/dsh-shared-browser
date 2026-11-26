/**
 * dsh-shared-browser — external Chromium channel.
 *
 * The built-in `<webview>` is locked down by the desktop shell (no persistent
 * partition, no downloads, no DevTools, Electron UA), which makes real sites
 * such as Cloudflare-protected ones unusable. This module drives the user's own
 * Edge/Chrome through the Chrome DevTools Protocol instead: real fingerprints,
 * a persistent profile, extensions, downloads and DevTools, and no change to
 * DSH itself.
 *
 * Everything here is plain HTTP + WebSocket to 127.0.0.1, so the Host process
 * needs no extra dependency.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LAUNCH_TIMEOUT_MS = 20000
const COMMAND_TIMEOUT_MS = 20000

/** Absolute profile root for the external browsers. */
export function profileRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'shared-browser', 'profiles')
}

/** Candidate browser binaries, most preferred first. */
export function detectBrowsers() {
  const found = []
  const push = (id, name, path) => {
    if (path !== undefined && existsSync(path) === true && found.some(entry => entry.path === path) === false) {
      found.push({ id, name, path })
    }
  }
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    push('msedge', 'Microsoft Edge', join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    push('msedge', 'Microsoft Edge', join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    push('chrome', 'Google Chrome', join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    push('chrome', 'Google Chrome', join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    push('chrome', 'Google Chrome', join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  } else if (process.platform === 'darwin') {
    push('chrome', 'Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    push('msedge', 'Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    push('chrome', 'Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    for (const [id, name, path] of [
      ['chrome', 'Google Chrome', '/usr/bin/google-chrome'],
      ['chrome', 'Chromium', '/usr/bin/chromium'],
      ['chrome', 'Chromium', '/usr/bin/chromium-browser'],
      ['msedge', 'Microsoft Edge', '/usr/bin/microsoft-edge'],
    ]) {
      push(id, name, path)
    }
  }
  return found
}

/** Minimal CDP page session over the global WebSocket. */
class PageSession {
  constructor(webSocketUrl, onEvent) {
    this.url = webSocketUrl
    this.onEvent = onEvent
    this.nextId = 1
    this.pending = new Map()
    this.socket = null
    this.ready = null
  }

  async connect() {
    if (this.ready !== null) return this.ready
    this.ready = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url)
      this.socket = socket
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
      socket.addEventListener('message', (event) => this.handle(event.data))
      socket.addEventListener('close', () => {
        for (const [, entry] of this.pending) entry.reject(new Error('CDP 连接已断开'))
        this.pending.clear()
        this.ready = null
      })
    })
    return this.ready
  }

  handle(data) {
    let message
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(message.error.message ?? 'CDP 错误'))
      else entry.resolve(message.result)
      return
    }
    if (typeof message.method === 'string' && typeof this.onEvent === 'function') {
      this.onEvent(message.method, message.params ?? {})
    }
  }

  send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 命令超时: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '脚本执行失败'
      throw new Error(String(text).split('\n')[0])
    }
    return result.result?.value
  }

  close() {
    try { this.socket?.close() } catch { /* already gone */ }
    this.ready = null
  }
}

/** One launched Chromium and the page sessions attached to it. */
export class ExternalBrowser {
  constructor(log = () => {}) {
    this.log = log
    this.process = null
    this.port = 0
    this.browser = null
    this.profileDir = ''
    this.sessions = new Map()
    this.zoom = new Map()
    this.consoleLog = []
    this.networkLog = []
  }

  get running() {
    return this.port !== 0 && this.process !== null && this.process.exitCode === null
  }

  /** Launch the browser once and wait for its DevTools port file. */
  async ensure(options = {}) {
    if (this.running === true) {
      const url = typeof options.url === 'string' && options.url !== '' ? options.url : null
      try {
        if (url !== null) {
          const tabs = await this.listTabs()
          const wanted = url.replace(/\/+$/, '')
          const already = tabs.find(entry => String(entry.url ?? '').replace(/\/+$/, '') === wanted)
          if (already === undefined) await this.waitReady(await this.openTab(url))
        }
        return this.summary()
      } catch {
        /* The window went away between calls: fall through and relaunch. */
        this.running = false
        this.port = null
        for (const [, session] of this.sessions) session.close()
        this.sessions.clear()
      }
    }
    const candidates = detectBrowsers()
    if (candidates.length === 0) throw new Error('没有找到 Edge 或 Chrome，无法使用外部通道。')
    const wanted = typeof options.browser === 'string' && options.browser !== ''
      ? candidates.find(entry => entry.id === options.browser || entry.path === options.browser)
      : undefined
    const pick = wanted ?? candidates[0]
    const profileDir = options.profileDir ?? join(profileRoot(), pick.id)
    await mkdir(profileDir, { recursive: true })
    const portFile = join(profileDir, 'DevToolsActivePort')
    await rm(portFile, { force: true }).catch(() => {})
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1200,860',
      options.url ?? 'about:blank',
    ]
    const child = spawn(pick.path, args, { detached: true, stdio: 'ignore' })
    child.unref()
    this.process = child
    this.browser = pick
    this.profileDir = profileDir
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (existsSync(portFile) === true) {
        const content = await readFile(portFile, 'utf8').catch(() => '')
        const port = Number.parseInt(String(content).split('\n')[0] ?? '', 10)
        if (Number.isFinite(port) && port > 0) {
          this.port = port
          this.log(`external: ${pick.name} on port ${port}`)
          /* First launch also has to paint the page: wait so callers see a title. */
          if (typeof options.url === 'string' && options.url !== '') await this.waitTab(options.url).catch(() => null)
          return this.summary()
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`外部浏览器启动超时：${pick.name}`)
  }

  summary() {
    return {
      running: this.running,
      browser: this.browser === null ? null : { id: this.browser.id, name: this.browser.name, path: this.browser.path },
      port: this.port,
      profileDir: this.profileDir,
      candidates: detectBrowsers().map(entry => ({ id: entry.id, name: entry.name })),
    }
  }

  async http(path, method = 'GET') {
    if (this.running === false) throw new Error('外部浏览器没有运行。')
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, { method })
    if (response.ok === false) throw new Error(`CDP HTTP ${response.status}`)
    const text = await response.text()
    return text === '' ? null : JSON.parse(text)
  }

  async listTabs() {
    const targets = await this.http('/json/list')
    return (targets ?? []).filter(target => target.type === 'page')
  }

  async openTab(url) {
    const target = await this.http(`/json/new?${encodeURIComponent(url)}`, 'PUT')
    if (target?.id === undefined) throw new Error('无法新建外部页签。')
    return target.id
  }

  async closeTab(targetId) {
    await this.http(`/json/close/${encodeURIComponent(targetId)}`).catch(() => {})
    const session = this.sessions.get(targetId)
    if (session !== undefined) {
      session.close()
      this.sessions.delete(targetId)
    }
  }

  /** Attach to one external page and enable the domains we read. */
  async session(targetId) {
    const existing = this.sessions.get(targetId)
    if (existing !== undefined) {
      await existing.connect()
      return existing
    }
    const targets = await this.listTabs()
    const target = targets.find(entry => entry.id === targetId)
    if (target === undefined) throw new Error('外部页签不存在。')
    const session = new PageSession(target.webSocketDebuggerUrl, (method, params) => this.onEvent(targetId, method, params))
    await session.connect()
    await session.send('Runtime.enable').catch(() => {})
    await session.send('Page.enable').catch(() => {})
    await session.send('Network.enable').catch(() => {})
    this.sessions.set(targetId, session)
    return session
  }

  onEvent(targetId, method, params) {
    if (method === 'Runtime.consoleAPICalled') {
      const level = params.type === 'error' ? 'error' : params.type === 'warning' ? 'warning' : 'info'
      const text = (params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' ')
      this.consoleLog.push({ level, text, ts: params.timestamp ?? Date.now(), tabId: targetId })
      if (this.consoleLog.length > 2000) this.consoleLog.shift()
      return
    }
    if (method === 'Log.entryAdded') {
      const entry = params.entry ?? {}
      this.consoleLog.push({ level: entry.level ?? 'info', text: entry.text ?? '', ts: entry.timestamp ?? Date.now(), tabId: targetId })
      return
    }
    if (method === 'Network.responseReceived') {
      const response = params.response ?? {}
      this.networkLog.push({
        method: response.requestHeadersText ?? 'GET',
        url: response.url ?? '',
        status: response.status ?? 0,
        ok: Number(response.status ?? 0) < 400,
        ms: Math.round(params.timestamp ?? 0),
        tabId: targetId,
      })
      if (this.networkLog.length > 600) this.networkLog.shift()
    }
  }

  /** Resolve a target id from a tool tab id such as `ext:ABCD`. */
  static targetOf(tabId) {
    const raw = String(tabId ?? '')
    return raw.startsWith('ext:') ? raw.slice(4) : null
  }

  /** Wait until a freshly opened page is ready to answer evaluations. */
  async waitReady(id, timeoutMs = 8000) {
    const session = await this.session(id).catch(() => null)
    if (session === null) return
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await session.evaluate('document.readyState').catch(() => '')
      if (state === 'complete' || state === 'interactive') return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  /** Describe the element a comment should attach to. */
  async describe(session, args) {
    const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : null
    const ref = typeof args.ref === 'string' && args.ref !== '' ? args.ref : null
    const expression = `(() => {
      const selector = ${JSON.stringify(selector)}
      const ref = ${JSON.stringify(ref)}
      const element = selector !== null ? document.querySelector(selector) : (ref !== null ? document.querySelector('[data-dsb-ref="' + ref + '"]') : null)
      if (element === null) return null
      const rect = element.getBoundingClientRect()
      return {
        selector: selector ?? '[data-dsb-ref="' + ref + '"]',
        tag: element.tagName.toLowerCase(),
        name: String(element.getAttribute('aria-label') ?? element.getAttribute('name') ?? '').slice(0, 120),
        text: String(element.innerText ?? element.textContent ?? '').trim().slice(0, 300),
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      }
    })()`
    return await session.evaluate(expression).catch(() => null)
  }

  /** Capture a rectangular region of the page as a data URL. */
  async captureClip(session, rect) {
    const width = Math.max(1, Math.round(rect.width))
    const height = Math.max(1, Math.round(rect.height))
    const shot = await session.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width, height, scale: 1 },
      captureBeyondViewport: true,
    })
    return `data:image/png;base64,${shot.data}`
  }

  /** Wait until the requested address shows up with a title. */
  async waitTab(url, timeoutMs = 15000) {
    const wanted = String(url ?? '').replace(/\/+$/, '')
    if (wanted === '') return null
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const tabs = await this.listTabs().catch(() => [])
      const hit = tabs.find(entry => String(entry.url ?? '').replace(/\/+$/, '') === wanted && String(entry.title ?? '') !== '')
      if (hit !== undefined) return hit
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    return null
  }

  async command(op, args = {}, tabId) {
    const targetId = ExternalBrowser.targetOf(tabId) ?? (await this.activeTarget(args))
    switch (op) {
      case 'open': {
        const id = await this.openTab(String(args.url ?? 'about:blank'))
        await this.waitReady(id)
        return { tabId: `ext:${id}`, url: String(args.url ?? '') }
      }
      case 'tabs': {
        const tabs = (await this.listTabs()).map(target => ({
          id: `ext:${target.id}`,
          url: target.url,
          title: target.title,
          loading: false,
          visible: true,
        }))
        return { tabs }
      }
      case 'navigate': {
        const session = await this.session(targetId)
        await session.send('Page.navigate', { url: String(args.url ?? '') })
        return { url: String(args.url ?? '') }
      }
      case 'zoom': {
        const session = await this.session(targetId)
        const action = String(args.action ?? 'reset')
        const steps = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
        const current = this.zoom.get(targetId) ?? 1
        let next = current
        if (action === 'reset') next = 1
        else if (action === 'in') next = steps.find(step => step > current + 0.001) ?? steps[steps.length - 1]
        else if (action === 'out') next = [...steps].reverse().find(step => step < current - 0.001) ?? steps[0]
        else if (action === 'set') next = Math.min(5, Math.max(0.25, Number(args.factor ?? 1)))
        this.zoom.set(targetId, next)
        await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: next })
        return { zoom: next }
      }
      case 'find': {
        const session = await this.session(targetId)
        const action = String(args.action ?? 'find')
        const wanted = String(args.text ?? '')
        if (action === 'stop' || wanted === '') {
          await session.evaluate('window.getSelection().removeAllRanges()').catch(() => {})
          return { count: 0, found: false }
        }
        const probe = "(() => { var t = " + JSON.stringify(wanted.toLowerCase()) + "; var n = 0; var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); var node; while ((node = walker.nextNode())) { var value = String(node.nodeValue || '').toLowerCase(); var at = value.indexOf(t); while (at !== -1) { n += 1; at = value.indexOf(t, at + t.length) } } return n })()"
        const count = await session.evaluate(probe).catch(() => 0)
        await session.evaluate('window.find(' + JSON.stringify(wanted) + ', false, false, true)').catch(() => {})
        return { count: Number(count) || 0, found: Number(count) > 0, text: wanted }
      }
      case 'comment': {
        const session = await this.session(targetId)
        const target = await this.describe(session, args)
        if (target === null) throw new Error('未找到要评论的元素：先选取元素或传入 selector。')
        const clip = await this.captureClip(session, target.rect).catch(() => null)
        return {
          id: `ext-${Date.now()}`,
          tabId: `ext:${targetId}`,
          url: await session.evaluate('location.href').catch(() => ''),
          title: await session.evaluate('document.title').catch(() => ''),
          selector: target.selector,
          ref: null,
          tag: target.tag,
          name: target.name,
          text: target.text,
          note: String(args.note ?? ''),
          rect: target.rect,
          screenshot: clip,
          ts: Date.now(),
        }
      }
      case 'text': {
        const session = await this.session(targetId)
        const text = await session.evaluate('document.body === null ? "" : document.body.innerText')
        return { text: String(text ?? '') }
      }
      case 'snapshot': {
        const session = await this.session(targetId)
        return await snapshot(session)
      }
      case 'evaluate': {
        const session = await this.session(targetId)
        const value = await session.evaluate(String(args.expression ?? 'undefined'))
        return { value: value ?? null }
      }
      case 'screenshot': {
        const session = await this.session(targetId)
        const shot = await session.send('Page.captureScreenshot', { format: 'png' })
        return { mime: 'image/png', dataUrl: `data:image/png;base64,${shot.data}` }
      }
      case 'regionScreenshot': {
        const session = await this.session(targetId)
        const clip = {
          x: Number(args.x ?? 0),
          y: Number(args.y ?? 0),
          width: Math.max(1, Number(args.width ?? 1)),
          height: Math.max(1, Number(args.height ?? 1)),
          scale: 1,
        }
        const shot = await session.send('Page.captureScreenshot', { format: 'png', clip })
        return { mime: 'image/png', dataUrl: `data:image/png;base64,${shot.data}`, clip }
      }
      case 'click': {
        const session = await this.session(targetId)
        const rect = await elementRect(session, args)
        const x = rect.x + rect.width / 2
        const y = rect.y + rect.height / 2
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        return { clicked: true, x: Math.round(x), y: Math.round(y) }
      }
      case 'type': {
        const session = await this.session(targetId)
        const selector = args.selector === undefined ? null : String(args.selector)
        await session.evaluate(focusSnippet(args))
        await session.send('Input.insertText', { text: String(args.text ?? '') })
        return { typed: String(args.text ?? '').length, selector }
      }
      case 'press': {
        const session = await this.session(targetId)
        await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: String(args.key ?? 'Enter'), code: String(args.code ?? '') })
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: String(args.key ?? 'Enter'), code: String(args.code ?? '') })
        return { pressed: String(args.key ?? 'Enter') }
      }
      case 'console':
        return { entries: this.consoleLog.slice(-200) }
      case 'network':
        return { entries: this.networkLog.slice(-200) }
      case 'close': {
        if (targetId !== null) await this.closeTab(targetId)
        return { closed: targetId }
      }
      default:
        throw new Error(`外部通道不支持该操作: ${op}`)
    }
  }

  async activeTarget(args) {
    const explicit = args.tabId === undefined ? null : ExternalBrowser.targetOf(args.tabId)
    if (explicit !== null) return explicit
    const tabs = await this.listTabs()
    if (tabs.length === 0) throw new Error('外部浏览器没有页签。')
    return tabs[tabs.length - 1].id
  }

  /** Forward one pointer/key event from the sidebar mirror. */
  async input(tabId, event = {}) {
    const targetId = ExternalBrowser.targetOf(tabId) ?? (await this.activeTarget({}))
    const session = await this.session(targetId)
    const kind = event.kind
    if (kind === 'mouse') {
      const type = event.type === 'down' ? 'mousePressed' : event.type === 'up' ? 'mouseReleased' : 'mouseMoved'
      await session.send('Input.dispatchMouseEvent', {
        type,
        x: Number(event.x ?? 0),
        y: Number(event.y ?? 0),
        button: event.button ?? 'left',
        clickCount: type === 'mouseMoved' ? 0 : Number(event.clickCount ?? 1),
      })
      return { sent: type }
    }
    if (kind === 'wheel') {
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Number(event.x ?? 0),
        y: Number(event.y ?? 0),
        deltaX: Number(event.deltaX ?? 0),
        deltaY: Number(event.deltaY ?? 0),
      })
      return { sent: 'wheel' }
    }
    if (kind === 'key') {
      if (typeof event.text === 'string' && event.text !== '') {
        await session.send('Input.insertText', { text: event.text })
        return { sent: 'text' }
      }
      const key = String(event.key ?? '')
      const code = String(event.code ?? '')
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code })
      return { sent: 'key' }
    }
    return { sent: 'ignored' }
  }

  async shutdown(kill = false) {
    for (const [, session] of this.sessions) session.close()
    this.sessions.clear()
    if (kill === true) {
      try { this.process?.kill() } catch { /* already gone */ }
    }
    this.port = 0
    this.process = null
  }
}

/** `document.querySelector` helper shared by click/type. */
function targetSnippet(args) {
  const selector = args.selector === undefined ? null : JSON.stringify(String(args.selector))
  const ref = args.ref === undefined ? null : JSON.stringify(String(args.ref))
  return `(() => {
    if (${selector} !== null) return document.querySelector(${selector})
    if (${ref} !== null) return document.querySelector('[data-dsb-ref="' + ${ref} + '"]')
    return document.body
  })()`
}

async function elementRect(session, args) {
  const rect = await session.evaluate(`(() => {
    const element = ${targetSnippet(args)}
    if (element === null) return null
    const box = element.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  })()`)
  if (rect === null || rect === undefined) throw new Error('未找到要操作的元素。')
  return rect
}

function focusSnippet(args) {
  return `(() => {
    const element = ${targetSnippet(args)}
    if (element === null) return false
    element.focus()
    if ('value' in element && element.value !== undefined) {
      element.value = ''
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return true
  })()`
}

/** Accessible-ish tree with stable refs, mirroring the built-in channel. */
async function snapshot(session) {
  const value = await session.evaluate(`(() => {
    let index = 0
    const lines = []
    const walk = (node, depth) => {
      if (node === null || node.nodeType !== 1) return
      const tag = node.tagName.toLowerCase()
      if (['script', 'style', 'noscript', 'template'].includes(tag) === true) return
      const box = node.getBoundingClientRect()
      if (box.width < 1 || box.height < 1) return
      const label = (node.innerText || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '').trim().split('\\n')[0].slice(0, 80)
      index += 1
      node.setAttribute('data-dsb-ref', 'e' + index)
      lines.push('e' + index + ' <' + tag + '>' + (label === '' ? '' : ' "' + label + '"'))
      for (const child of node.children) walk(child, depth + 1)
    }
    if (document.body !== null) walk(document.body, 0)
    return { url: location.href, title: document.title, lines: lines.slice(0, 400) }
  })()`)
  const lines = Array.isArray(value?.lines) ? value.lines : []
  return { url: value?.url ?? '', title: value?.title ?? '', text: lines.join('\\n'), lineCount: lines.length }
}

/** Write a small marker file so the UI can show which browser is in use. */
export async function writeState(file, state) {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 2), 'utf8')
}

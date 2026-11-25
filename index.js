/**
 * dsh-shared-browser — drive DSH Desktop's own Browser tab with Playwright over CDP.
 *
 * The desktop app embeds each Browser tab as an Electron <webview>. When the app
 * is started with `--remote-debugging-port=9223`, that guest shows up as a CDP
 * target of type "webview". Playwright's connectOverCDP ignores that type, so
 * `ensurePatch()` applies one env-gated line change to the installed
 * playwright-core copy (backup kept next to it, idempotent, re-applied on
 * upgrade). With it, the tab behaves like an ordinary Playwright page:
 * goto / click / type / keyboard / evaluate / screenshot, all with native
 * pixels because it is the real on-screen webview.
 *
 * There is no panel: the display IS the built-in Browser tab the user sees.
 * @module dsh-shared-browser
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { locateApp, archiveState } from './lib/locate.mjs'
import { installShortcut, shortcutState, uninstallShortcut } from './lib/shortcut.mjs'

export const name = 'dsh-shared-browser'
export const inject = ['tools']

const ENDPOINT = process.env.DSH_CDP || 'http://127.0.0.1:9223'
const PATCH_ENV = 'DSH_BUILTIN_WEBVIEW_AS_PAGE'
const TASK_NAME = 'dsh-shared-browser-arm'

// Must be set before playwright-core is imported, so the patched branch runs.
process.env[PATCH_ENV] = '1'

const require = createRequire(import.meta.url)

const ANCHOR =
  'const treatOtherAsPage = targetInfo.type === "other" && process.env.PW_CHROMIUM_ATTACH_TO_OTHER;'
const PATCHED =
  'const treatOtherAsPage = (targetInfo.type === "other" && process.env.PW_CHROMIUM_ATTACH_TO_OTHER) || (targetInfo.type === "webview" && process.env.DSH_BUILTIN_WEBVIEW_AS_PAGE === "1");'

/** Ensure the installed playwright-core attaches to `webview` targets. */
function ensurePatch() {
  let bundle
  try {
    bundle = resolve(process.cwd(), require.resolve('playwright-core/package.json'))
  } catch (error) {
    throw new Error('playwright-core is not installed for this plugin: ' + error.message)
  }
  const file = join(dirname(bundle), 'lib', 'coreBundle.js')
  if (!existsSync(file)) throw new Error('playwright-core layout changed (no lib/coreBundle.js): ' + file)
  const source = readFileSync(file, 'utf8')
  if (source.includes(PATCHED)) return { patched: 'already', file }
  if (!source.includes(ANCHOR)) {
    throw new Error('playwright-core patch anchor not found (version changed?): ' + file)
  }
  if (!existsSync(file + '.orig')) copyFileSync(file, file + '.orig')
  writeFileSync(file, source.replace(ANCHOR, PATCHED), 'utf8')
  return { patched: 'applied', file }
}

/** node.exe binaries shipped with DSH (the host may not have node on PATH). */
function runtimeNodes() {
  const found = []
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const home of homes) {
    const root = join(home, 'dsh-runtimes')
    let names = []
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const candidate = join(root, name, 'dependencies', 'node', 'bin', 'node.exe')
      if (existsSync(candidate)) found.push(candidate)
    }
  }
  return found
}

/** A real node.exe for the watchdog (the host may run as Electron with ELECTRON_RUN_AS_NODE). */
function nodeExe() {
  const candidates = [
    process.env.DSH_NODE,
    process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR
      ? join(process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR, 'dependencies', 'node', 'bin', 'node.exe')
      : null,
    process.env.DSH_HOME
      ? join(process.env.DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
      : null,
    /node\.exe$/i.test(process.execPath) ? process.execPath : null,
    ...runtimeNodes(),
    'node',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate === 'node') return candidate
    if (existsSync(candidate)) return candidate
  }
  return 'node'
}

let patchState = null
function patchOnce() {
  if (patchState === null) patchState = ensurePatch()
  return patchState
}

/** Load playwright-core without going through its package entry.
 *
 * DSH's CommonJS hook rewrites `require('./lib/coreBundle')` inside
 * playwright-core/index.js, which leaves `.inprocess` undefined and makes every
 * call fail with "Cannot read properties of undefined (reading 'playwright')".
 * Reading the bundled entry by absolute path skips that hook.
 */
function loadPlaywright() {
  try {
    const pkg = require.resolve('playwright-core/package.json')
    const bundle = require(join(dirname(pkg), 'lib', 'coreBundle.js'))
    const pw = bundle && bundle.inprocess && bundle.inprocess.playwright
    if (pw && pw.chromium) return pw
  } catch { /* fall back below */ }
  return null
}

let browserPromise = null
let chromiumRef = null

async function browser() {
  patchOnce()
  if (chromiumRef === null) {
    const direct = loadPlaywright()
    const pw = direct || (await import('playwright-core'))
    chromiumRef = pw.chromium
  }
  if (browserPromise === null) {
    browserPromise = chromiumRef.connectOverCDP(ENDPOINT).catch((error) => {
      browserPromise = null
      throw new Error(
        'cannot reach the DSH desktop app on ' + ENDPOINT + ' (' + error.message + ').\n' +
        'The app is running without --remote-debugging-port. Run bb_enable once (default mode '
        + 'rewrites the DSH launcher shortcut, no binary is touched), then open DSH from that '
        + 'shortcut: every launch from then on carries the port.',
      )
    })
  }
  return browserPromise
}

/** Drop the cached connection (call after the app restarts). */
async function resetBrowser() {
  const p = browserPromise
  browserPromise = null
  if (p !== null) {
    try { const b = await p; await b.close().catch(() => {}) } catch { /* ignore */ }
  }
}

function isWebPage(url) {
  return /^https?:/i.test(url || '')
}

/** Find the built-in Browser tab page (optionally one whose URL contains `match`). */
// The sidebar keeps its address bar in the app shell; typing there creates the
// WebContentsView we drive. Used when no Browser tab exists yet.
async function openTabThroughAddressBar(url) {
  const b = await browser()
  const pages = []
  for (const ctx of b.contexts()) for (const page of ctx.pages()) pages.push(page)
  const shell = pages.find((page) => page.url().startsWith('dsh-app://'))
  if (!shell) throw new Error('cannot find the app shell page (dsh-app://) to open a Browser tab')
  const box = shell.locator('input[placeholder="输入 HTTP(S) 地址"]').first()
  try {
    await box.waitFor({ state: 'visible', timeout: 5000 })
  } catch {
    throw new Error(
      'no Browser tab and its address bar is not visible. Click the sidebar tab labelled 浏览器 (Ctrl+T) once, then retry.',
    )
  }
  await box.click()
  await box.fill(url)
  await box.press('Enter')
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 400))
    const now = []
    for (const ctx of b.contexts()) for (const page of ctx.pages()) now.push(page)
    const web = now.filter((page) => isWebPage(page.url()))
    if (web.length) return web[web.length - 1]
  }
  throw new Error('typed the URL into the address bar but no Browser tab appeared; open it manually once.')
}

async function pickPage(match) {
  const b = await browser()
  const pages = []
  for (const ctx of b.contexts()) for (const page of ctx.pages()) pages.push(page)
  const web = pages.filter((page) => isWebPage(page.url()))
  if (web.length === 0) {
    if (match && /^https?:/i.test(match)) return openTabThroughAddressBar(match)
    throw new Error(
      'no web page found in the built-in Browser tab. Open one first: press Ctrl+T in the panel dock ' +
      '(or click the Browser tab that lists Ctrl+T) and type a URL; bb_open with a URL also creates one.',
    )
  }
  if (match) {
    const hit = web.find((page) => page.url().includes(match))
    if (hit) return hit
    throw new Error('no page whose URL contains ' + JSON.stringify(match) + '; open pages: ' + web.map((p) => p.url()).join(' | '))
  }
  return web[web.length - 1]
}

/** Tag interactive elements in the page and return a compact inventory. */
async function snapshot(page, limit) {
  const data = await page.evaluate((cap) => {
    const seen = new Set()
    const out = []
    let n = 0
    const sel = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[tabindex]:not([tabindex="-1"])'
    for (const el of document.querySelectorAll(sel)) {
      const rect = el.getBoundingClientRect()
      const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden'
      if (!visible || seen.has(el)) continue
      seen.add(el)
      const ref = 'e' + ++n
      el.setAttribute('data-bbref', ref)
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 80)
      const item = { ref, tag: el.tagName.toLowerCase(), label, y: Math.round(rect.top) }
      if (el.type) item.type = el.type
      if (el.disabled) item.disabled = true
      out.push(item)
      if (out.length >= cap) break
    }
    document.querySelectorAll('[data-bbref]').forEach((el) => el.removeAttribute('data-bbref'))
    // re-tag the ones we kept, so a later click can find them by ref
    return { items: out, text: document.body ? document.body.innerText.slice(0, 4000) : '' }
  }, limit || 60)
  // tag again and keep them until the next snapshot
  await page.evaluate((items) => {
    document.querySelectorAll('[data-bbref]').forEach((el) => el.removeAttribute('data-bbref'))
    const sel = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[tabindex]:not([tabindex="-1"])'
    const nodes = Array.from(document.querySelectorAll(sel)).filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    const byIndex = new Map()
    nodes.forEach((el, i) => byIndex.set('e' + (i + 1), el))
    for (const item of items) {
      const el = byIndex.get(item.ref)
      if (el) el.setAttribute('data-bbref', item.ref)
    }
  }, data.items)
  return data
}

function locator(page, target) {
  if (/^e\d+$/.test(target)) return page.locator('[data-bbref="' + target + '"]').first()
  return page.locator(target).first()
}

async function shotDir() {
  const dir = join(tmpdir(), 'dsh-shared-browser')
  mkdirSync(dir, { recursive: true })
  return dir
}

function pidAlive(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0) return false
  try {
    process.kill(id, 0)
    return true
  } catch {
    return false
  }
}

const clean = (v) => JSON.parse(JSON.stringify(v ?? null))
const json = () => ({ schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v ?? null) }] })
const present = (title, args) => ({ card: 'generic', title, kind: 'other', rawInput: args || {} })

// Arm the patch-mode watchdog. Shared by bb_enable(mode=patch) and autoArm().
async function armPatch({ port, cdpWaitMs } = {}) {
  const app = locateApp()
  if (!app.exeExists) throw new Error('cannot find the desktop app executable: ' + app.exe + ' (set DSH_APP_EXE to override)')
  if (!app.asarExists) throw new Error('cannot find app.asar: ' + app.asar + ' (set DSH_ASAR_PATH to override)')
  const p = String(port || new URL(ENDPOINT).port || '9223')
  const waitMs = Number(cdpWaitMs || 120000)
  const dir = join(tmpdir(), 'dsh-shared-browser')
  mkdirSync(dir, { recursive: true })
  const statusPath = join(dir, 'arm-status.json')
  const watchdog = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'watchdog.mjs')
  const launcher = join(dir, 'arm.cmd')
  const startupDir = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  const startupCmd = join(startupDir, 'dsh-shared-browser-arm.cmd')
  const lines = [
    '@echo off',
    'set "DSH_CDP_PORT=' + p + '"',
    '"' + nodeExe() + '" "' + watchdog + '" --exe "' + app.exe + '" --asar "' + app.asar + '" --port ' + p + ' --status "' + statusPath + '" --cdp-wait-ms ' + waitMs + ' --cleanup "' + startupCmd + '"',
  ]
  writeFileSync(launcher, lines.join('\r\n') + '\r\n', 'utf8')
  const ps =
    "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c \"" +
    launcher.replace(/'/g, "''") +
    "\"' } | ForEach-Object { $_.ProcessId }"
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000 })
  const launcherPid = Number(String(res.stdout || '').trim().split(/\s+/).filter(Boolean).pop())
  if (res.status !== 0 || !Number.isFinite(launcherPid) || !launcherPid) {
    throw new Error('could not arm the watchdog: ' + (res.stderr || res.error || 'unknown error') + ' (launcher: ' + launcher + ')')
  }
  // Survive a reboot: Windows runs everything in the Startup folder at logon,
  // which needs no elevation (schtasks ONLOGON is denied on this machine).
  let startup = null
  try {
    mkdirSync(startupDir, { recursive: true })
    writeFileSync(
      startupCmd,
      ['@echo off', 'rem keeps dsh-shared-browser armed across reboots; deletes itself after a patch', ...lines.slice(1), ''].join('\r\n'),
      'utf8',
    )
    startup = startupCmd
  } catch (error) {
    startup = 'failed: ' + String(error && error.message || error)
  }

  // The launch stub exits at once; the watchdog records its own pid in the status file.
  let pid = launcherPid
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 150))
    try {
      const now = JSON.parse(readFileSync(statusPath, 'utf8'))
      if (now.state === 'armed' && pidAlive(now.pid)) {
        pid = now.pid
        break
      }
    } catch {}
  }
  return {
    armed: true,
    pid,
    startup,
    port: p,
    asar: app.asar,
    backupDir: dir,
    statusPath,
    launcher,
    node: nodeExe(),
    next:
      'Quit DeepSeek Harness from its tray menu now (closing the window only hides it). The watchdog will back up ' +
      'app.asar, patch a verified copy, restart the app and wait for CDP on port ' + p + '. If CDP never answers it ' +
      'restores the backup and starts the app unchanged. Then call bb_status.',
  }
}

// Arm on load: the install → one restart sequence is enough, because the restart
// itself is the exit the watchdog is waiting for. It patches, then starts the app
// with the switch baked into app.asar, so no shortcut or flag is needed anymore.
function autoArm() {
  if (String(process.env.DSH_AUTO_ARM || '').toLowerCase() === 'off') return
  try {
    const app = locateApp()
    if (!app.exeExists || !app.asarExists) return
    if (archiveState(app.asar).patched) return
    const statusPath = join(tmpdir(), 'dsh-shared-browser', 'arm-status.json')
    try {
      const prev = JSON.parse(readFileSync(statusPath, 'utf8'))
      if (prev.state === 'armed' && pidAlive(prev.pid) && Date.now() - Date.parse(prev.at) < 6 * 3600 * 1000) return
    } catch {}
    armPatch({})
      .then((info) => console.info('[dsh-shared-browser] auto-armed watchdog pid ' + info.pid + ' on port ' + info.port))
      .catch((error) => console.warn('[dsh-shared-browser] auto-arm failed: ' + String((error && error.message) || error)))
  } catch (error) {
    console.warn('[dsh-shared-browser] auto-arm skipped: ' + String((error && error.message) || error))
  }
}

export function apply(ctx) {
  let patchInfo
  try {
    patchInfo = patchOnce()
    console.info('[dsh-shared-browser] playwright-core patch ' + patchInfo.patched + ' :: ' + patchInfo.file)
  } catch (error) {
    console.warn('[dsh-shared-browser] patch failed: ' + error.message)
  }

  autoArm()

  ctx.tools.register({
    name: 'bb_enable',
    description:
      'Give the desktop app a persistent debugging port so the built-in Browser tab can be driven by Playwright. ' +
      'Default mode=shortcut rewrites the DSH launcher shortcut so every normal launch carries ' +
      '--remote-debugging-port (no binary touched, survives app updates, undo with mode=shortcut undo=true). ' +
      'mode=patch bakes the switch into app.asar instead (verified copy, backup, automatic rollback). ' +
      'No scripts, no elevation.',
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        port: { type: 'number', description: 'Debugging port to bake in. Default 9223.' },
        cdpWaitMs: { type: 'number', description: 'How long the watchdog waits for CDP after restarting. Default 120000.' },
        mode: {
          type: 'string',
          enum: ['shortcut', 'patch'],
          description:
            'shortcut (default): rewrite the DSH launcher shortcut so every normal launch carries the port — no binary is touched and app updates keep working. ' +
            'patch: bake the switch into app.asar (verified copy, backup, rollback) and wait for the app to quit.',
        },
        undo: { type: 'boolean', description: 'With mode=shortcut: restore the original shortcuts and remove the wrapper.' },
      },
    },
    output: json({}),
    async execute(a) {
      const app = locateApp()
      if (!app.exeExists) throw new Error('cannot find the desktop app executable: ' + app.exe + ' (set DSH_APP_EXE to override)')
      if (!app.asarExists) throw new Error('cannot find app.asar: ' + app.asar + ' (set DSH_ASAR_PATH to override)')

      const port = String(a.port || new URL(ENDPOINT).port || '9223')
      const dir0 = join(tmpdir(), 'dsh-shared-browser')
      mkdirSync(dir0, { recursive: true })
      const recordPath = join(dir0, 'shortcut-record.json')

      if ((a.mode || 'shortcut') === 'shortcut') {
        if (a.undo) {
          const undone = uninstallShortcut({ recordPath })
          return { mode: 'shortcut', undone: true, restored: undone.restored }
        }
        const record = installShortcut({ exe: app.exe, port, recordPath })
        return {
          mode: 'shortcut',
          installed: true,
          port,
          wrapper: record.wrapper,
          shortcuts: record.shortcuts.map((x) => x.lnk),
          next:
            record.shortcuts.length === 0
              ? 'No DeepSeek shortcut was found. Use the wrapper directly: ' + record.wrapper
              : 'Open DSH from its shortcut from now on (close it first if it is running): the next launch carries --remote-debugging-port=' +
                port +
                '. Nothing was written into app.asar.',
        }
      }

      const state = archiveState(app.asar)
      if (state.error) throw new Error('cannot read app.asar: ' + state.error)
      if (state.patched) {
        return {
          patched: true,
          already: true,
          asar: app.asar,
          port: state.port,
          hint: state.port === port ? 'app.asar already carries the switch; just (re)start the app.' : 'app.asar is patched for port ' + state.port + '; rerun with port ' + state.port + ' or patch again.',
        }
      }

      const dir = join(tmpdir(), 'dsh-shared-browser')
      mkdirSync(dir, { recursive: true })
      const statusPath = join(dir, 'arm-status.json')
      if (existsSync(statusPath)) {
        try {
          const prev = JSON.parse(readFileSync(statusPath, 'utf8'))
          const ageMin = (Date.now() - Date.parse(prev.at || 0)) / 60000
          if (prev.state === 'armed' && ageMin < 20 && pidAlive(prev.pid)) {
            return { armed: true, alreadyArmed: true, pid: prev.pid, statusPath, ageMinutes: Math.round(ageMin), next: 'quit the app from the tray; the watchdog is already waiting.' }
          }
        } catch {}
      }

      return await armPatch({ port, cdpWaitMs: a.cdpWaitMs })
    },
    presentCall: () => present('Enable built-in browser automation'),
  })

  ctx.tools.register({
    name: 'bb_status',
    description: 'Check whether the DSH desktop app exposes its built-in Browser tab to automation (CDP on 127.0.0.1:9223) and list the pages Playwright can see. Read-only.',
    parameters: { type: 'object', additionalProperties: true, properties: {} },
    output: json({}),
    async execute() {
      const app = locateApp()
      const out = { endpoint: ENDPOINT, patch: patchState, app: { ...app, archive: archiveState(app.asar) } }
      try {
        const b = await browser()
        out.connected = true
        out.pages = []
        for (const c of b.contexts()) for (const p of c.pages()) out.pages.push({ url: p.url(), web: isWebPage(p.url()), title: await p.title().catch(() => '') })
      } catch (error) {
        out.connected = false
        out.error = error.message
      }
      return out
    },
    presentCall: () => present('Built-in browser status'),
  })

  ctx.tools.register({
    name: 'bb_reconnect',
    description: 'Drop the cached CDP connection and reconnect. Use after the desktop app was restarted.',
    parameters: { type: 'object', additionalProperties: true, properties: {} },
    output: json({}),
    async execute() { await resetBrowser(); return { ok: true, endpoint: ENDPOINT } },
    presentCall: () => present('Reconnect built-in browser'),
  })

  ctx.tools.register({
    name: 'bb_open',
    description: 'Navigate the built-in Browser tab to a URL. The user watches the same tab, so this is a shared, visible navigation. Use `match` when several tabs are open.',
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        match: { type: 'string', description: 'Only use a tab whose current URL contains this text.' },
        waitUntil: { type: 'string', description: 'load (default) | domcontentloaded | networkidle' },
        timeoutMs: { type: 'number', description: 'Default 30000.' },
      },
      required: ['url'],
    },
    output: json({}),
    async execute(a) {
      let page
      let createdTab = false
      try {
        page = await pickPage(a.match)
      } catch (error) {
        if (!/no web page found/.test(String(error && error.message))) throw error
        page = await openTabThroughAddressBar(a.url)
        createdTab = true
      }
      const response = createdTab ? null : await page.goto(a.url, { waitUntil: a.waitUntil || 'load', timeout: a.timeoutMs || 30000 })
      return { url: page.url(), title: await page.title(), status: response ? response.status() : null, createdTab }
    },
    presentCall: (a) => present('Open in built-in browser', a),
  })

  ctx.tools.register({
    name: 'bb_snapshot',
    description: 'List the interactive elements of the current page with short refs (e1, e2, ...) plus a text excerpt. Pass those refs to bb_click / bb_type. Re-snapshot after the page changes.',
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        match: { type: 'string', description: 'Only use a tab whose URL contains this text.' },
        limit: { type: 'number', description: 'Max elements, default 60.' },
      },
    },
    output: json({}),
    async execute(a) {
      const page = await pickPage(a.match)
      const data = await snapshot(page, a.limit)
      return clean({ url: page.url(), title: await page.title(), elements: data.items, text: data.text })
    },
    presentCall: (a) => present('Snapshot built-in browser', a),
  })

  ctx.tools.register({
    name: 'bb_click',
    description: 'Click an element in the built-in Browser tab, by snapshot ref (e3) or CSS selector. A human clicking the same spot would do the same thing.',
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        target: { type: 'string', description: 'Snapshot ref (eN) or CSS selector.' },
        match: { type: 'string', description: 'Only use a tab whose URL contains this text.' },
        timeoutMs: { type: 'number', description: 'Default 15000.' },
      },
      required: ['target'],
    },
    output: json({}),
    async execute(a) {
      const page = await pickPage(a.match)
      await locator(page, a.target).click({ timeout: a.timeoutMs || 15000 })
      await page.waitForTimeout(400)
      return { clicked: a.target, url: page.url(), title: await page.title() }
    },
    presentCall: (a) => present('Click in built-in browser', a),
  })

  ctx.tools.register({
    name: 'bb_type',
    description: 'Type text into a field in the built-in Browser tab (ref or CSS selector). With submit:true it presses Enter afterwards. Characters are inserted directly, so Chinese text is fine.',
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        target: { type: 'string', description: 'Snapshot ref (eN) or CSS selector.' },
        text: { type: 'string', description: 'Text to type.' },
        submit: { type: 'boolean', description: 'Press Enter after typing. Default false.' },
        match: { type: 'string', description: 'Only use a tab whose URL contains this text.' },
        timeoutMs: { type: 'number', description: 'Default 15000.' },
      },
      required: ['target', 'text'],
    },
    output: json({}),
    async execute(a) {
      const page = await pickPage(a.match)
      const el = locator(page, a.target)
      await el.click({ timeout: a.timeoutMs || 15000 })
      await el.fill(a.text, { timeout: a.timeoutMs || 15000 })
      if (a.submit) {
        await el.press('Enter')
        await page.waitForTimeout(1200)
      }
      return clean({ target: a.target, value: await el.inputValue().catch(() => null), submitted: !!a.submit, url: page.url() })
    },
    presentCall: (a) => present('Type in built-in browser', a),
  })

  ctx.tools.register({
    name: 'bb_press',
    description: 'Press a key or chord in the built-in Browser tab (Enter, Escape, PageDown, Control+A, ...).',
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        key: { type: 'string', description: 'Playwright key name.' },
        match: { type: 'string', description: 'Only use a tab whose URL contains this text.' },
      },
      required: ['key'],
    },
    output: json({}),
    async execute(a) {
      const page = await pickPage(a.match)
      await page.keyboard.press(a.key)
      await page.waitForTimeout(400)
      return { pressed: a.key, url: page.url() }
    },
    presentCall: (a) => present('Press key in built-in browser', a),
  })

  ctx.tools.register({
    name: 'bb_wait',
    description: 'Wait until some text appears or an element becomes visible in the built-in Browser tab.',
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        text: { type: 'string', description: 'Wait for this text on the page.' },
        selector: { type: 'string', description: 'Wait for this CSS selector to be visible.' },
        timeoutSec: { type: 'number', description: 'Default 20.' },
        match: { type: 'string', description: 'Only use a tab whose URL contains this text.' },
      },
    },
    output: json({}),
    async execute(a) {
      const page = await pickPage(a.match)
      const timeout = (a.timeoutSec || 20) * 1000
      if (a.text) await page.getByText(a.text, { exact: false }).first().waitFor({ state: 'visible', timeout })
      else if (a.selector) await page.locator(a.selector).first().waitFor({ state: 'visible', timeout })
      else throw new Error('give text or selector')
      return { ok: true, url: page.url(), title: await page.title() }
    },
    presentCall: (a) => present('Wait in built-in browser', a),
  })

  ctx.tools.register({
    name: 'bb_text',
    description: 'Read the visible text of the built-in Browser tab (whole page, or one selector). This is the page content the model quotes from.',
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector.' },
        maxChars: { type: 'number', description: 'Default 12000.' },
        match: { type: 'string', description: 'Only use a tab whose URL contains this text.' },
      },
    },
    output: json({}),
    async execute(a) {
      const page = await pickPage(a.match)
      const cap = a.maxChars || 12000
      const text = a.selector
        ? await page.locator(a.selector).first().innerText({ timeout: 15000 })
        : await page.evaluate(() => (document.body ? document.body.innerText : ''))
      return { url: page.url(), title: await page.title(), truncated: text.length > cap, text: text.slice(0, cap) }
    },
    presentCall: (a) => present('Read built-in browser', a),
  })

  ctx.tools.register({
    name: 'bb_eval',
    description: 'Evaluate a JavaScript expression inside the built-in Browser tab page and return its JSON value.',
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        expression: { type: 'string', description: 'Expression, e.g. document.title or [...document.querySelectorAll("h3")].map(h=>h.innerText).' },
        match: { type: 'string', description: 'Only use a tab whose URL contains this text.' },
      },
      required: ['expression'],
    },
    output: json({}),
    async execute(a) {
      const page = await pickPage(a.match)
      const value = await page.evaluate(a.expression)
      return { url: page.url(), value }
    },
    presentCall: (a) => present('Evaluate in built-in browser', a),
  })

  ctx.tools.register({
    name: 'bb_screenshot',
    description: 'Screenshot the built-in Browser tab as it renders on screen and return the file path. The user is looking at the same pixels.',
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        path: { type: 'string', description: 'Optional absolute .png path.' },
        fullPage: { type: 'boolean', description: 'Capture the whole scrollable page. Default false.' },
        match: { type: 'string', description: 'Only use a tab whose URL contains this text.' },
      },
    },
    output: json({}),
    async execute(a) {
      const page = await pickPage(a.match)
      const dir = await shotDir()
      const file = a.path || join(dir, 'shot-' + Date.now() + '.png')
      await page.screenshot({ path: file, fullPage: !!a.fullPage })
      return { path: file, url: page.url(), title: await page.title() }
    },
    presentCall: (a) => present('Screenshot built-in browser', a),
  })

  console.info('[dsh-shared-browser] 12 tools registered against ' + ENDPOINT)
}

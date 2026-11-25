/**
 * watchdog.mjs — the safe half of dsh-shared-browser.
 *
 * Patching app.asar has to happen while the desktop app is *not* running, so the
 * plugin arms this watchdog as a detached process; the user then quits the app from
 * its tray menu and the watchdog:
 *
 *   1. waits for every process of that executable to exit,
 *   2. backs app.asar up next to itself (app.asar.bak-<stamp>),
 *   3. writes a patched copy, then VERIFIES it (header, target entry, 400-file parity),
 *   4. replaces app.asar only when the verification passed,
 *   5. relaunches the app and waits for the CDP endpoint to answer,
 *   6. and if the endpoint never answers, restores the backup and relaunches the
 *      pristine app — a bad patch can never leave the user without a working app.
 *
 * Everything the relaunched app needs is written into a tiny .cmd launcher, because
 * processes created through WMI do not inherit our environment and nested quoting
 * through powershell -Command mangles arguments.
 *
 * CLI: node lib/watchdog.mjs --exe <app.exe> --asar <resources/app.asar> --port 9223
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from './asar-patch.mjs'
const requireRaw = createRequire(import.meta.url)
let rawFs = null
try {
  rawFs = requireRaw('original-fs')
} catch {
  rawFs = null
}
const nodeFs = await import('node:fs')
const copyFileSync = (a, b) => (rawFs ? rawFs.copyFileSync(a, b) : nodeFs.copyFileSync(a, b))
const renameSync = (a, b) => (rawFs ? rawFs.renameSync(a, b) : nodeFs.renameSync(a, b))
import { basename, dirname, join } from 'node:path'
import { patchArchive, writeArchive, verifyArchive, compareArchives } from './asar-patch.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgv(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq > 2) {
      args.set(token.slice(2, eq), token.slice(eq + 1))
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key, next)
      i += 1
    } else {
      args.set(key, true)
    }
  }
  return args
}

/** Run the patch cycle. Resolves with the final status object (never throws). */
export async function armAndPatch(options) {
  const exe = options.exe
  const asar = options.asar
  const port = String(options.port || '9223')
  const statusPath = options.statusPath || asar + '.dsh-status.json'
  const logPath = options.logPath || statusPath.replace(/\.json$/, '') + '.log'
  // 0 (or a negative value) means "wait as long as it takes": the user may quit
  // the app hours from now and the patch must still be applied.
  const waitExitMs = Number(options.waitExitMs ?? 0) > 0 ? Number(options.waitExitMs) : 0
  const cdpWaitMs = Number(options.cdpWaitMs || 120 * 1000)
  const extraArgs = String(options.extraArgs || '').trim()
  const childEnv = options.childEnv || {}
  const cleanupPath = String(options.cleanup || '').trim()
  const cleanup = () => {
    if (!cleanupPath) return
    try {
      rmSync(cleanupPath, { force: true })
      note('startup entry removed', { file: cleanupPath })
    } catch (error) {
      note('startup entry removal failed', { file: cleanupPath, message: String(error && error.message || error) })
    }
  }
  const untaskName = String(options.untask || '').trim()
  const untask = () => {
    if (!untaskName) return
    try {
      const r = spawnSync('schtasks.exe', ['/Delete', '/F', '/TN', untaskName], { encoding: 'utf8', timeout: 20000 })
      note('task removed', { task: untaskName, status: r.status })
    } catch (error) {
      note('task removal failed', { task: untaskName, message: String(error && error.message || error) })
    }
  }

  const log = []
  const note = (step, extra) => {
    const line = new Date().toISOString().slice(11, 19) + ' ' + step + (extra ? ' :: ' + JSON.stringify(extra) : '')
    log.push(line)
    try {
      appendFileSync(logPath, line + '\n')
    } catch {}
  }
  const writeStatus = (state, extra = {}) => {
    const body = { state, at: new Date().toISOString(), pid: process.pid, exe, asar, port, log, ...extra }
    try {
      writeFileSync(statusPath, JSON.stringify(body, null, 2))
    } catch {}
    return body
  }

  const runningPids = () => {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // Only the app's own processes count: renderer/GPU/utility children (--type=)
          // and plugin sidecars (they run node code, e.g. node_modules\\...) do not.
          `@(Get-CimInstance Win32_Process -Filter "Name='${basename(exe)}'" | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq '${exe}') -and ([string]$_.CommandLine -notmatch '--type=') -and ([string]$_.CommandLine -notmatch 'node_modules') } | ForEach-Object { $_.ProcessId }) -join ','`,
        ],
        { encoding: 'utf8', timeout: 20000 },
      ).trim()
      return out ? out.split(',').map((n) => Number(n.trim())).filter(Boolean) : []
    } catch {
      return []
    }
  }

  // Only orphaned app processes are closed: a live instance keeps its own tree, so
  // a window the user re-opened in the meantime is never touched.
  // Anything left over from the instance that just exited can still hold app.asar
  // mapped (Electron children, and the plugin sidecars the desktop app spawns from
  // its own install directory). Only processes whose parent is already gone are
  // closed, so a window the user re-opened in the meantime is never touched.
  const closeOrphans = () => {
    try {
      const exeName = basename(exe)
      const installDir = dirname(exe).replace(/\\/g, '\\\\')
      const script =
        `$all = @(Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId });` +
        `@(Get-CimInstance Win32_Process | Where-Object { ` +
        `(($_.Name -ieq '${exeName}') -and $_.ExecutablePath -and ($_.ExecutablePath -ieq '${exe}')) -or ` +
        `(($_.Name -ieq 'node.exe') -and $_.CommandLine -and ($_.CommandLine -like '*${installDir}*'))` +
        ` } | Where-Object { $all -notcontains $_.ParentProcessId } | ` +
        `ForEach-Object { $_.ProcessId }) -join ','`
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 30000,
      }).trim()
      const pids = out ? out.split(',').map((n) => Number(n.trim())).filter(Boolean) : []
      if (!pids.length) return 0
      note('closing leftover processes', { pids })
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', pids.map((pid) => `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`).join('; ')],
        { timeout: 30000 },
      )
      note('closed orphaned app processes', { pids })
      return pids.length
    } catch (error) {
      note('orphan cleanup failed', { message: String((error && error.message) || error) })
      return 0
    }
  }

  const fetchJson = async (url, ms = 2500) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), ms)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      return res.ok ? await res.json() : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  const launchApp = () => {
    const lines = Object.entries({ DSH_CDP_PORT: port, ...childEnv }).map(([k, v]) => `set "${k}=${v}"`)
    lines.push(`start "" "${exe}"${extraArgs ? ' ' + extraArgs : ''}`)
    const launcher = statusPath.replace(/\.json$/, '') + '.launch.cmd'
    writeFileSync(launcher, '@echo off\r\n' + lines.join('\r\n') + '\r\n', 'utf8')
    const ps =
      "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c \"" +
      launcher.replace(/'/g, "''") +
      "\"' } | ForEach-Object { $_.ProcessId }"
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: 30000,
      }).trim()
      const pid = Number(out.split(/\s+/).filter(Boolean).pop())
      note('launcher written', { launcher, lines: lines.length - 1 })
      return Number.isFinite(pid) ? pid : 0
    } catch (error) {
      note('launch failed', { message: String(error.message || error) })
      return 0
    }
  }

  try {
    writeStatus('armed', { waitPolicy: waitExitMs === 0 ? 'until the app exits (no time limit)' : String(Math.round(waitExitMs / 1000)) + 's' })
    note('armed', { exe, asar, port })

    const started = Date.now()
    let seen = false
    while (waitExitMs === 0 || Date.now() - started < waitExitMs) {
      const pids = runningPids()
      if (pids.length) seen = true
      if (!pids.length) break
      await sleep(3000)
    }
    if (runningPids().length) throw new Error('the app never exited within ' + Math.round(waitExitMs / 1000) + 's')
    note('app exited', { seen, seconds: ((Date.now() - started) / 1000).toFixed(1) })

    // Leftover renderer/plugin children keep app.asar mapped; close the orphans and
    // give a window the user may have re-opened a chance to finish on its own.
    for (let round = 0; round < 6; round++) {
      if (!runningPids().length) {
        closeOrphans()
        await sleep(1500)
      }
      if (!runningPids().length) break
      note('app came back before patching; waiting for the next exit')
      while (runningPids().length) await sleep(2000)
    }

    if (verifyArchive(asar, { port }).ok) {
      note('already patched', { asar })
      untask()
      cleanup()
      return writeStatus('patched', { already: true })
    }

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const backup = asar + '.bak-' + stamp
    copyFileSync(asar, backup)
    note('backup', { backup, bytes: readFileSync(asar).length })

    const tmp = asar + '.dsh-tmp'
    writeArchive(tmp, patchArchive(asar, { port }))
    const verdict = verifyArchive(tmp, { port })
    const parity = compareArchives(asar, tmp, { limit: 400 })
    note('verify', verdict)
    note('parity', { compared: parity.compared, differ: parity.differCount, ok: parity.ok })
    if (!verdict.ok || !parity.ok) {
      try {
        renameSync(tmp, tmp + '.rejected')
      } catch {}
      note('patch rejected', { problems: verdict.problems })
      launchApp()
      return writeStatus('rejected', { backup, problems: verdict.problems })
    }

    let swapped = false
    for (let attempt = 1; attempt <= 80 && !swapped; attempt++) {
      try {
        renameSync(tmp, asar)
        swapped = true
      } catch (error) {
        const code = String((error && error.code) || (error && error.message) || '')
        if (!/EBUSY|EPERM|EACCES/.test(code)) throw error
        note('app.asar busy, retrying', { attempt, code })
        await sleep(1500)
      }
    }
    if (!swapped) throw new Error('app.asar stayed locked; nothing was replaced')
    note('asar replaced', { bytes: readFileSync(asar).length })
    note('app launched', { pid: launchApp() })

    const cdpStarted = Date.now()
    let cdp = null
    while (Date.now() - cdpStarted < cdpWaitMs) {
      const version = await fetchJson('http://127.0.0.1:' + port + '/json/version')
      if (version && version.webSocketDebuggerUrl) {
        const list = (await fetchJson('http://127.0.0.1:' + port + '/json/list')) || []
        cdp = {
          browser: version.Browser,
          targets: list.length,
          appTarget: list.some((t) => String(t.url || '').startsWith('dsh-app://')),
          seconds: ((Date.now() - cdpStarted) / 1000).toFixed(1),
        }
        break
      }
      await sleep(900)
    }
    if (cdp) {
      note('cdp up', cdp)
      // The archive now carries the switch, so the reboot-proof arming stub has
      // done its job; remove it before anyone re-arms on the next logon.
      untask()
      cleanup()
      return writeStatus('patched', { backup, cdp })
    }

    note('cdp never answered, rolling back')
    copyFileSync(backup, asar)
    note('asar restored', { backup })
    launchApp()
    return writeStatus('reverted', { backup, reason: 'cdp did not answer in time' })
  } catch (error) {
    note('fatal', { message: String(error && error.message || error) })
    try {
      if (!existsSync(asar)) throw new Error('missing asar')
    } catch {}
    return writeStatus('fatal', { reason: String(error && error.message || error) })
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/lib/watchdog.mjs')
if (invokedDirectly) {
  /** "--env 'K=V;K2=V2'" -> { K: 'V', K2: 'V2' } */
  function parseEnv(value) {
    const out = {}
    for (const pair of String(value || '').split(';')) {
      const at = pair.indexOf('=')
      if (at > 0) out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
    }
    return out
  }

  const args = parseArgv(process.argv.slice(2))
  const exe = args.get('exe')
  const asar = args.get('asar')
  if (!exe || !asar) {
    console.error('usage: node lib/watchdog.mjs --exe <app exe> --asar <resources/app.asar> [--port 9223] [--status <file>]')
    process.exit(2)
  }
  armAndPatch({
    exe,
    asar,
    port: args.get('port') || '9223',
    statusPath: args.get('status') || undefined,
    logPath: args.get('log') || undefined,
    waitExitMs: args.get('wait-exit-ms') || undefined,
    cdpWaitMs: args.get('cdp-wait-ms') || undefined,
    extraArgs: args.get('args') || undefined,
    childEnv: parseEnv(args.get('env')),
    untask: args.get('untask') || undefined,
    cleanup: args.get('cleanup') || undefined,
  }).then((status) => {
    console.log('[watchdog] ' + status.state)
    process.exit(status.state === 'patched' ? 0 : 1)
  })
}

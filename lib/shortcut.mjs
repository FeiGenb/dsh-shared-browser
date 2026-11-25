// Shortcut mode: make every normal launch of DSH start with --remote-debugging-port.
//
// Why this exists: replacing app.asar needs the file to be free, and the app's
// renderer/plugin children keep it mapped for a while after quitting (EPERM on
// rename). Rewriting the launcher shortcut touches no binary, survives app
// updates, and needs no elevation.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const START_MENU = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
const DESKTOP = join(process.env.USERPROFILE || '', 'Desktop')
const PUBLIC_DESKTOP = join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop')
const TASKBAR_PINS = join(process.env.APPDATA || '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')

const psQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'"

const runPs = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 30000,
  }).trim()

function readShortcut(lnk) {
  const out = runPs(
    [
      '$s = New-Object -ComObject WScript.Shell',
      `$l = $s.CreateShortcut(${psQuote(lnk)})`,
      '[pscustomobject]@{ target = $l.TargetPath; args = $l.Arguments; workdir = $l.WorkingDirectory; style = $l.WindowStyle } | ConvertTo-Json -Compress',
    ].join('; '),
  )
  return JSON.parse(out)
}

function writeShortcut(lnk, { target, args, workdir, style }) {
  runPs(
    [
      '$s = New-Object -ComObject WScript.Shell',
      `$l = $s.CreateShortcut(${psQuote(lnk)})`,
      `$l.TargetPath = ${psQuote(target)}`,
      `$l.Arguments = ${psQuote(args || '')}`,
      `$l.WorkingDirectory = ${psQuote(workdir || '')}`,
      `$l.WindowStyle = ${Number(style || 1)}`,
      '$l.Save()',
      '"saved"',
    ].join('; '),
  )
}

export function findShortcuts(exe) {
  const found = []
  for (const dir of [START_MENU, DESKTOP, PUBLIC_DESKTOP, TASKBAR_PINS]) {
    if (!existsSync(dir)) continue
    let listing = ''
    try {
      listing = runPs(
        `Get-ChildItem -Path ${psQuote(dir)} -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }`,
      )
    } catch {
      continue
    }
    for (const line of listing.split(/\r?\n/)) {
      const lnk = line.trim()
      if (!lnk) continue
      try {
        const sc = readShortcut(lnk)
        if (sc.target && resolve(sc.target).toLowerCase() === resolve(exe).toLowerCase()) {
          found.push({ lnk, ...sc })
        }
      } catch {
        /* not ours */
      }
    }
  }
  return found
}

const wrapperPath = (exe) => join(dirname(exe), 'launch-with-cdp.vbs')

const wrapperSource = (exe, port) =>
  [
    "' Launched by the dsh-shared-browser plugin: opens DSH with the DevTools port.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${exe}"" --remote-debugging-port=${port}", 1, False`,
    '',
  ].join('\r\n')

export function installShortcut({ exe, port, recordPath }) {
  const wrapper = wrapperPath(exe)
  writeFileSync(wrapper, wrapperSource(exe, port), 'utf8')

  const shortcuts = findShortcuts(exe)
  const record = { at: new Date().toISOString(), exe, port, wrapper, shortcuts: [] }

  for (const sc of shortcuts) {
    const backup = sc.lnk + '.dsh-original'
    if (!existsSync(backup)) copyFileSync(sc.lnk, backup)
    writeShortcut(sc.lnk, { target: 'wscript.exe', args: `"${wrapper}"`, workdir: dirname(exe), style: 1 })
    record.shortcuts.push({ lnk: sc.lnk, backup, was: { target: sc.target, args: sc.args || '' } })
  }

  if (recordPath) {
    mkdirSync(dirname(recordPath), { recursive: true })
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', 'utf8')
  }
  return record
}

export function shortcutState({ exe, port, recordPath }) {
  const wrapper = wrapperPath(exe)
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null
  let active = false
  try {
    const shortcuts = findShortcuts(exe)
    active = shortcuts.length === 0 && record
      ? false
      : findShortcuts(exe).length === 0
        ? false
        : findShortcuts(exe).every((sc) => basename(String(sc.target)).toLowerCase() === 'wscript.exe')
  } catch {
    active = false
  }
  return { mode: 'shortcut', wrapper, wrapperExists: existsSync(wrapper), shortcutsRewritten: active, port, record }
}

export function uninstallShortcut({ recordPath }) {
  if (!existsSync(recordPath)) return { restored: [] }
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  const restored = []
  for (const item of record.shortcuts || []) {
    if (existsSync(item.backup)) {
      copyFileSync(item.backup, item.lnk)
      rmSync(item.backup, { force: true })
      restored.push(item.lnk)
    }
  }
  if (record.wrapper && existsSync(record.wrapper)) rmSync(record.wrapper, { force: true })
  rmSync(recordPath, { force: true })
  return { restored }
}

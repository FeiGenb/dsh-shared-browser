/**
 * locate.mjs — where the DSH desktop app and its app.asar live, plus a cheap
 * "is this archive already patched?" probe.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MARKER, readAsar, listFiles, resolveMain } from './asar-patch.mjs'

export function locateApp(env = process.env) {
  const platform = process.platform
  let exe = env.DSH_APP_EXE || ''
  let asar = env.DSH_ASAR_PATH || ''
  if (!exe || !asar) {
    if (platform === 'win32') {
      const root = join(env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness')
      exe = exe || join(root, 'DeepSeek Harness.exe')
      asar = asar || join(root, 'resources', 'app.asar')
    } else if (platform === 'darwin') {
      const root = '/Applications/DeepSeek Harness.app/Contents'
      exe = exe || join(root, 'MacOS', 'DeepSeek Harness')
      asar = asar || join(root, 'Resources', 'app.asar')
    } else {
      exe = exe || '/opt/DeepSeek Harness/deepseek-harness'
      asar = asar || '/opt/DeepSeek Harness/resources/app.asar'
    }
  }
  return { exe, asar, platform, exeExists: existsSync(exe), asarExists: existsSync(asar) }
}

/**
 * Read the entry module out of the archive and look for the patch marker.
 * Returns { patched, port, bytes, targetPath } or { error }.
 */
export function archiveState(asarPath, port = '9223') {
  try {
    const { buf, header, dataStart } = readAsar(asarPath)
    const files = listFiles(header)
    const targetPath = resolveMain({ header })
    const entry = files.find((f) => f.path === targetPath)
    if (!entry) return { error: targetPath + ' not found in archive' }
    const start = dataStart + Number(entry.entry.offset)
    const size = Number(entry.entry.size)
    // Another plugin may prepend its own prelude, so look through the whole file
    // instead of assuming our marker sits at byte 0.
    const text = buf.subarray(start, start + size).toString('utf8')
    return {
      patched: text.includes(MARKER) || /appendSwitch\(\s*['"]remote-debugging-port['"]/.test(text),
      port: readPort(text),
      bytes: size,
      targetPath,
    }
  } catch (error) {
    return { error: String((error && error.message) || error) }
  }
}

function readPort(text) {
  // Our own prelude passes process.env.DSH_CDP_PORT with a literal fallback; a
  // foreign plugin may instead hard-code the port in appendSwitch(). Accept both.
  const patterns = [
    /DSH_CDP_PORT\s*\|\|\s*['"](\d+)['"]/,
    /appendSwitch\(\s*['"]remote-debugging-port['"]\s*,\s*['"](\d+)['"]/,
    /--remote-debugging-port=(\d+)/,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return m[1]
  }
  return null
}

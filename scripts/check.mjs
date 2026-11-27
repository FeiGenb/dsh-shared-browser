#!/usr/bin/env node
/**
 * Repository self-check used by CI and by contributors before pushing.
 *
 * It verifies two things without needing DSH, Electron or a browser:
 *   1. every shipped JavaScript file parses (ESM and CommonJS respectively);
 *   2. package.json still describes a loadable DSH plugin bundle.
 *
 * Run it with:  node scripts/check.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const problems = []

function fail(message) {
  problems.push(message)
  console.log('  FAIL  ' + message)
}

function listJavaScript() {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(entry.name)
  }
  for (const dir of ['lib', 'scripts']) {
    let entries = []
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(dir + '/' + entry.name)
    }
  }
  return files.sort()
}

function syntaxCheck(files) {
  console.log('syntax check')
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-shared-browser-check-'))
  try {
    for (const file of files) {
      if (file === 'scripts/check.mjs') {
        console.log('  skip  ' + file + ' (this script)')
        continue
      }
      let probe = join(root, file)
      if (!file.endsWith('.cjs')) {
        // `node --check` parses CommonJS unless the path ends in .mjs, and this
        // package is "type": "module", so parse a temporary .mjs copy instead.
        probe = join(scratch, 'probe.mjs')
        writeFileSync(probe, readFileSync(join(root, file)))
      }
      try {
        execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe', encoding: 'utf8' })
        console.log('  ok    ' + file)
      } catch (error) {
        const detail = String(error.stderr || error.stdout || error.message)
          .trim()
          .split('\n')
          .slice(0, 6)
          .join('\n        ')
        fail(file + ' does not parse\n        ' + detail)
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function manifestCheck() {
  console.log('manifest check')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch (error) {
    fail('package.json is not readable JSON: ' + error.message)
    return
  }
  for (const key of ['name', 'version', 'description', 'license', 'main', 'files', 'dsh']) {
    if (!pkg[key]) fail('package.json is missing "' + key + '"')
  }
  if (!pkg.dsh?.bundle?.patch) fail('package.json is missing dsh.bundle.patch')
  if (!pkg.dsh?.client?.platform) fail('package.json is missing dsh.client.platform')
  for (const file of ['index.js', 'cordis.patch.yml', 'README.md', 'README_en.md', 'LICENSE']) {
    try {
      readFileSync(join(root, file))
      console.log('  ok    ' + file)
    } catch {
      fail('missing file: ' + file)
    }
  }
  for (const entry of pkg.files || []) {
    const probe = join(root, entry.replace(/\/$/, ''))
    let readable = false
    try {
      readFileSync(probe)
      readable = true
    } catch {
      try {
        readdirSync(probe)
        readable = true
      } catch {
        readable = false
      }
    }
    if (readable) console.log('  ok    files[] ' + entry)
    else fail('files[] entry does not exist: ' + entry)
  }
  if (pkg.dsh?.client?.inject) {
    console.log('  ok    dsh.client.inject: ' + (pkg.dsh.client.inject.join(', ') || '(none)'))
  }
}

const files = listJavaScript()
console.log('files: ' + files.length)
syntaxCheck(files)
manifestCheck()

if (problems.length > 0) {
  console.log('\n' + problems.length + ' problem(s) found')
  process.exit(1)
}
console.log('\nall checks passed')

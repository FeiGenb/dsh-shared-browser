// Minimal, self-contained asar reader/writer for the DSH CDP patch.
// Format (as produced by @electron/asar):
//   0..4   u32  = 4           (size of the first pickle field)
//   4..8   u32  = U2          (8 + padded header JSON length)
//   8..12  u32  = U2 - 4
//  12..16  u32  = header JSON length (unpadded)
//  16..    header JSON, NUL padded to 4 bytes; then the data block.
// Entries: { size: number, offset: string, integrity?: {...}, unpacked?: boolean }
// Directories: { files: {...} }

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync as nodeRead, writeFileSync as nodeWrite } from 'node:fs';

// Inside Electron, node:fs resolves paths that contain ".asar" *inside* the archive
// ("ENOENT, not found in …app.asar"). original-fs bypasses that patch; plain Node
// falls back to node:fs.
const requireRaw = createRequire(import.meta.url);
let rawFs = null;
try {
  rawFs = requireRaw('original-fs');
} catch {
  rawFs = null;
}
export const readFileSync = (file, options) => (rawFs ? rawFs.readFileSync(file, options) : nodeRead(file, options));
export const writeFileSync = (file, data, options) => (rawFs ? rawFs.writeFileSync(file, data, options) : nodeWrite(file, data, options));
export const isRawFs = Boolean(rawFs);

const ALIGN = 4;
export const MARKER = '/*DSH_SHARED_BROWSER_CDP v2*/'
const FOREIGN_SWITCH = /appendSwitch\(\s*['"]remote-debugging-port['"]/;

export function prelude(port) {
  return (
    MARKER +
    "import{app as __dshCdpApp}from'electron';try{const __dshCdpPort=process.env.DSH_CDP_PORT||'" +
    port +
    "';const __dshCdpHas=process.argv.some((a)=>String(a).startsWith('--remote-debugging-port'));" +
    "if(!__dshCdpHas)__dshCdpApp.commandLine.appendSwitch('remote-debugging-port',__dshCdpPort);}catch(__dshCdpErr){}" +
    '\n'
  );
}

// Another plugin may prepend its own bootstrap to the same file. Our statement goes
// after the module's import block, so their text stays intact and both run.
const IMPORT_LINE = /^\s*import\s[^\n]*?from\s+['"][^'"]+['"];?\s*$/;

// Resolve the real entry point from the archive's package.json instead of assuming
// the upstream layout; fall back to the historical path when package.json is absent.
export function resolveMain(state) {
  const files = listFiles(state.header);
  const pkg = files.find((f) => f.path === 'package.json' || f.path === '/package.json');
  if (pkg && !pkg.entry.unpacked) {
    try {
      const text = payloadOf(state, pkg.entry).toString('utf8');
      const main = JSON.parse(text).main;
      if (typeof main === 'string' && main.trim()) {
        const clean = main.replace(/^\.?\//, '').replace(/\\/g, '/');
        if (files.some((f) => f.path === clean)) return clean;
      }
    } catch {}
  }
  return 'lib/main.js';
}

// Insert after the last top-level import in the file's opening block (or at the very
// start when there is none), so a foreign prelude keeps running before ours.
export function insertIndex(text) {
  const limit = Math.min(text.length, 64 * 1024);
  let at = 0;
  let cursor = 0;
  for (const line of text.slice(0, limit).split('\n')) {
    cursor += line.length + 1;
    if (IMPORT_LINE.test(line)) at = Math.min(cursor, limit);
  }
  return at;
}

export function readAsar(file) {
  const buf = readFileSync(file);
  const u1 = buf.readUInt32LE(0);
  const u2 = buf.readUInt32LE(4);
  const u3 = buf.readUInt32LE(8);
  const u4 = buf.readUInt32LE(12);
  if (u1 !== 4) throw new Error('bad asar header: first field ' + u1);
  if (u3 !== u2 - 4) throw new Error('bad asar header: u3 ' + u3 + ' vs u2 ' + u2);
  const padded = u2 - 8;
  const jsonStart = 16;
  const jsonEnd = jsonStart + u4;
  if (padded < u4) throw new Error('bad asar header: json length');
  const headerText = buf.subarray(jsonStart, jsonEnd).toString('utf8');
  let header;
  try {
    header = JSON.parse(headerText);
  } catch (e) {
    throw new Error('bad asar header JSON: ' + e.message);
  }
  const dataStart = jsonStart + padded;
  return { buf, header, dataStart, headerLength: padded };
}

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const path = prefix ? prefix + '/' + name : name;
    if (child.files) walk(child, path, out);
    else out.push({ path, entry: child });
  }
  return out;
}

export function listFiles(header) {
  return walk(header, '', []);
}

function payloadOf(state, entry) {
  const start = state.dataStart + Number(entry.offset);
  const end = start + Number(entry.size);
  if (start < state.dataStart || end > state.buf.length) {
    throw new Error('entry range out of bounds');
  }
  return state.buf.subarray(start, end);
}

function integrityOf(payload, blockSize, format = 'hex') {
  const enc = format === 'base64' ? 'base64' : 'hex';
  const hash = createHash('sha256').update(payload).digest(enc);
  const blocks = [];
  for (let i = 0; i < payload.length; i += blockSize) {
    blocks.push(createHash('sha256').update(payload.subarray(i, i + blockSize)).digest(enc));
  }
  return { algorithm: 'SHA256', hash, blockSize, blocks };
}

function integrityFormat(integrity) {
  const h = integrity && integrity.hash;
  if (typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h)) return 'hex';
  return 'base64';
}

/**
 * Build a patched archive in memory.
 * targetPath: inside-archive path such as 'lib/main.js'
 */
export function patchArchive(srcFile, options = {}) {
  const { port = '9223', corrupt = false } = options;
  const state = readAsar(srcFile);
  const files = listFiles(state.header);
  const targetPath = options.targetPath || resolveMain(state);
  const target = files.find((f) => f.path === targetPath);
  if (!target) throw new Error('target not found in archive: ' + targetPath);

  const pending = [];
  let already = false;
  let foreignSwitch = false;
  let patchedBytes = 0;
  for (const { path, entry } of files) {
    if (entry.unpacked) continue;
    let payload = payloadOf(state, entry);
    if (path === targetPath) {
      const original = payload.toString('utf8');
      if (original.includes(MARKER)) {
        already = true;
      } else if (FOREIGN_SWITCH.test(original)) {
        // Some other tool already opens a debugging port for this app; adding a second
        // switch would be a fight over the same flag, so leave the file alone.
        already = true;
        foreignSwitch = true;
      } else {
        const at = insertIndex(original);
        const text = original.slice(0, at) + prelude(port) + original.slice(at);
        payload = Buffer.from(corrupt ? 'this is not valid json "size": ' + text : text, 'utf8');
        patchedBytes = payload.length - Number(entry.size);
      }
    }
    pending.push({ entry, payload, isTarget: path === targetPath });
  }

  const chunks = [];
  let cursor = 0;
  for (const { entry, payload, isTarget } of pending) {
    const size = payload.length;
    entry.size = corrupt && isTarget ? 'oops' : size; // a corrupt build must be detectable
    entry.offset = String(cursor);
    // Only the patched file's integrity may change; every other entry keeps its
    // original object byte-for-byte (its content is identical, so the hash holds).
    if (isTarget && entry.integrity && !corrupt) {
      const blockSize = entry.integrity.blockSize || 4194304;
      entry.integrity = integrityOf(payload, blockSize, integrityFormat(entry.integrity));
    }
    chunks.push(payload);
    cursor += size;
  }

  const json = Buffer.from(JSON.stringify(state.header), 'utf8');
  const padded = Math.ceil(json.length / ALIGN) * ALIGN;
  const headerBuf = Buffer.alloc(16 + padded);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(8 + padded, 4);
  headerBuf.writeUInt32LE(4 + padded, 8);
  headerBuf.writeUInt32LE(json.length, 12);
  json.copy(headerBuf, 16);

  return {
    buffer: Buffer.concat([headerBuf, ...chunks]),
    headerLength: padded,
    files: files.length,
    patchedBytes,
    already,
    foreignSwitch,
    targetPath,
    integrityEntries: pending.filter((p) => p.entry.integrity).length,
  };
}

export function writeArchive(file, result) {
  writeFileSync(file, result.buffer);
}

export function verifyArchive(file, options = {}) {
  const { port = '9223' } = options;
  const state = readAsar(file);
  const files = listFiles(state.header);
  const targetPath = options.targetPath || resolveMain(state);
  const target = files.find((f) => f.path === targetPath);
  if (!target) throw new Error('verify: target missing');
  const text = payloadOf(state, target.entry).toString('utf8');
  const problems = [];
  if (!text.includes(MARKER)) {
    if (!FOREIGN_SWITCH.test(text)) problems.push('marker missing');
  }
  if (!text.includes("appendSwitch('remote-debugging-port'")) problems.push('switch missing');
  if (!text.includes(String(port))) problems.push('port missing');
  let bad = 0;
  let checked = 0;
  for (const { entry } of files) {
    if (entry.unpacked) continue;
    try {
      payloadOf(state, entry);
      checked++;
    } catch {
      bad++;
    }
  }
  return {
    ok: problems.length === 0 && bad === 0,
    problems,
    outOfBounds: bad,
    checked,
    entries: files.length,
    dataStart: state.dataStart,
    targetPath,
    targetSize: Number(target.entry.size),
  };
}

export function sampleHashes(file, count = 40) {
  const state = readAsar(file);
  const files = listFiles(state.header).filter((f) => !f.entry.unpacked && !f.entry.files);
  const out = new Map();
  const step = Math.max(1, Math.floor(files.length / count));
  for (let i = 0; i < files.length && out.size < count; i += step) {
    const f = files[i];
    out.set(f.path, createHash('sha256').update(payloadOf(state, f.entry)).digest('hex'));
  }
  return out;
}

/**
 * Compare two archives over the SAME path list (no sampling bias):
 * every packed file is hashed on both sides unless it is the patched target.
 */
export function compareArchives(fileA, fileB, { targetPath = 'lib/main.js', limit = 0 } = {}) {
  const a = readAsar(fileA);
  const b = readAsar(fileB);
  const listA = listFiles(a.header);
  const listB = new Map(listFiles(b.header).map((f) => [f.path, f.entry]));
  const pathsA = new Set(listA.map((f) => f.path));
  const missing = listA.filter((f) => !listB.has(f.path)).map((f) => f.path);
  const extra = [...listB.keys()].filter((p) => !pathsA.has(p));
  let compared = 0;
  let same = 0;
  const differ = [];
  const targets = limit > 0 ? listA.slice(0, limit) : listA;
  for (const { path, entry } of targets) {
    if (path === targetPath) continue;
    if (entry.unpacked) continue;
    const other = listB.get(path);
    if (!other) continue;
    compared++;
    try {
      const ha = createHash('sha256').update(payloadOf(a, entry)).digest('hex');
      const hb = createHash('sha256').update(payloadOf(b, other)).digest('hex');
      if (ha === hb) same++;
      else differ.push(path);
    } catch (e) {
      differ.push(path + ' :: ' + e.message);
    }
  }
  return {
    compared,
    same,
    differCount: differ.length,
    differ: differ.slice(0, 5),
    missingCount: missing.length,
    missing: missing.slice(0, 5),
    extraCount: extra.length,
    extra: extra.slice(0, 5),
    ok: differ.length === 0 && missing.length === 0 && extra.length === 0,
  };
}

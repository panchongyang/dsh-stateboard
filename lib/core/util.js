import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './errors.js';

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortValue(value[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJSON(value) {
  return JSON.stringify(sortValue(value));
}

export function resolveWorkspacePath(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('workspacePath is required');
  }
  const resolved = path.resolve(input);
  let real = resolved;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    // A missing directory is still a valid future project path; keep the resolved path.
  }
  return real;
}

export function canonicalKey(input) {
  const resolved = resolveWorkspacePath(input);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function projectIdFor(workspacePath) {
  return 'prj_' + sha256(canonicalKey(workspacePath)).slice(0, 16);
}

export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  // Only a whole `..` segment climbs out; `..cache` is an ordinary child name.
  return relative !== '..' && !relative.startsWith('..' + path.sep);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function atomicWrite(file, data, encoding = 'utf8', io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const fd = io.openSync(tmp, 'w');
  try {
    io.writeFileSync(fd, data, encoding);
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
  try {
    io.renameSync(tmp, file);
  } catch (error) {
    try { io.unlinkSync(tmp); } catch { /* best effort; the target is untouched either way */ }
    throw error;
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value, io = fs) {
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n', 'utf8', io);
}

export function appendLineSync(file, line) {
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeFileSync(fd, line + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonLines(file, { validate = null, salvage = false } = {}) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const hasNewline = text === '' || text.endsWith('\n');
  const parts = text.split('\n');
  if (hasNewline) parts.pop();
  const lines = [];
  const physicalLines = [];
  let tailIncomplete = false;
  let diagnostic = null;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;
    const context = { line: i + 1, validSeq: lines.length, validHash: lines.at(-1)?.hash || 'genesis' };
    let commit;
    try { commit = JSON.parse(parts[i]); }
    catch {
      tailIncomplete = i === parts.length - 1 && !hasNewline;
      diagnostic = new BoardError('hash-chain-broken', 'corrupt commit line ' + (i + 1), {
        status: 503, details: { ...context, reason: tailIncomplete ? 'incomplete-tail' : 'invalid-json' },
      });
      if (tailIncomplete || salvage) break;
      throw diagnostic;
    }
    try { if (validate) validate(commit, context); }
    catch (error) {
      if (!salvage) throw error;
      diagnostic = error;
      break;
    }
    lines.push(commit);
    physicalLines.push(i + 1);
  }
  // Complete JSON without LF is retained; only an unparseable final fragment
  // may be omitted by normal open. Validation always precedes normalization.
  return { lines, physicalLines, tailIncomplete, tailUnterminated: !hasNewline, diagnostic };
}

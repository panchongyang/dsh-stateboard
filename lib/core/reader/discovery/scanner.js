// Worker-local, read-only projection scanner. No writer, object history or host
// transport belongs here. All mutable state is bounded and disposable.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { compileIgnore, isIgnored } from './ignore-rules.js';
import { MAX_DOC_BYTES, previewOf, readDocument } from '../../documents/read.js';
import { classifyFsError } from '../../documents/locate.js';
import { checkProjectionLexical, inspectProjectionPath, normalizeProjectionDeny, projectionFailure, projectionRoot, throwProjectionFs } from './path-policy.js';

export const PROJECTION_LIMITS = Object.freeze({ entries: 512, bytes: 32 * 1024 * 1024,
  fileBytes: MAX_DOC_BYTES, depth: 32, outputBytes: 1024 * 1024, milliseconds: 2000,
  sliceMilliseconds: 150, metadataEntries: 16384, metadataBytes: 4 * 1024 * 1024,
  generations: 4, ignoreBytes: 64 * 1024, batchIgnoreBytes: 1024 * 1024 });
const supported = rel => /\.(md|markdown|txt)$/i.test(rel);
const stamp = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const objectId = stat => `${stat.dev}:${stat.ino}`;
const EMPTY_RULES = compileIgnore('');
const freshCounts = () => ({ enumerated: 0, read: 0, reused: 0, indexed: 0, readBytes: 0, ignoreBytes: 0, excluded: {}, rejected: {}, errors: {} });
function record(counts, error) {
  const code = error?.code || 'unstable';
  const category = ['reserved-path', 'policy-denied', 'gitignored', 'nested-workspace', 'unsupported-extension'].includes(code) ? 'excluded'
    : ['permission-denied', 'file-missing', 'root-unavailable', 'unstable'].includes(code) ? 'errors' : 'rejected';
  counts[category][code] = (counts[category][code] || 0) + 1;
}
function nested(root, rel) {
  if (!rel) return;
  try { fs.lstatSync(path.join(root, rel, '.git')); }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return; throwProjectionFs(error); }
  throw projectionFailure('nested-workspace');
}
function ignoreRules(root, rel, inherited, counts) {
  const file = rel ? rel + '/.gitignore' : '.gitignore';
  let before;
  try { before = inspectProjectionPath(root, file); }
  catch (error) { if (error.code === 'file-missing') return { rules: inherited, signature: null }; throw error; }
  if (before.stat.size > BigInt(PROJECTION_LIMITS.ignoreBytes)) throw projectionFailure('ignore-oversize');
  if (counts.ignoreBytes + Number(before.stat.size) > PROJECTION_LIMITS.batchIgnoreBytes) throw projectionFailure('ignore-budget');
  let fd;
  try {
    fd = fs.openSync(before.located.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || stamp(opened) !== before.signature) throw projectionFailure('unstable', 'ignore-replaced');
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let used = 0;
    while (used < buffer.length) {
      const amount = fs.readSync(fd, buffer, used, buffer.length - used, null);
      if (!amount) break;
      used += amount;
    }
    counts.ignoreBytes += used;
    if (used > PROJECTION_LIMITS.ignoreBytes || counts.ignoreBytes > PROJECTION_LIMITS.batchIgnoreBytes) throw projectionFailure('ignore-budget');
    const after = inspectProjectionPath(root, file);
    if (used !== Number(opened.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== before.signature || after.signature !== before.signature) throw projectionFailure('unstable', 'ignore-changed');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used)); }
    catch { throw projectionFailure('ignore-invalid', 'invalid-utf8'); }
    let own;
    try { own = compileIgnore(text, rel); }
    catch (error) { throw projectionFailure(error.code || 'ignore-invalid', error.message); }
    return { rules: [...inherited, ...own], signature: before.signature };
  } catch (error) {
    if (error?.code && !String(error.code).startsWith('E')) throw error;
    throwProjectionFs(error);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function outputPreview(text, maxBytes, overheadBytes) {
  const outputBudget = PROJECTION_LIMITS.outputBytes - overheadBytes - 256;
  const initial = previewOf(text, maxBytes);
  if (Buffer.byteLength(JSON.stringify(initial.text)) < outputBudget) return initial;
  let encoded = 2;
  let end = 0;
  for (const char of initial.text) {
    const cost = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (encoded + cost > outputBudget) break;
    encoded += cost; end += char.length;
  }
  return { text: initial.text.slice(0, end), truncated: true, totalBytes: initial.totalBytes };
}
function closeScan(scan) {
  for (const frame of scan.stack) { try { frame.dir.closeSync(); } catch {} }
  scan.stack.length = 0;
}

class ProjectionScanner {
  constructor({ root, projectId, workspaceContext, policyVersion, denyPrefixes = [], scopeKey } = {}) {
    if (!path.isAbsolute(root || '') || typeof projectId !== 'string' || !projectId || !workspaceContext || policyVersion === undefined || typeof scopeKey !== 'string' || !scopeKey) throw projectionFailure('invalid-path', 'explicit-projection-context-required');
    this.root = root;
    this.context = structuredClone(workspaceContext);
    this.policyVersion = structuredClone(policyVersion);
    if (Buffer.byteLength(JSON.stringify(this.context)) > 64 * 1024 || Buffer.byteLength(JSON.stringify(this.policyVersion)) > 1024) throw projectionFailure('invalid-path', 'projection-context-oversize');
    this.deny = normalizeProjectionDeny(denyPrefixes);
    this.metadata = new Map(); this.scans = new Map();
    this.closed = false; this.activeRoot = null; this.metadataBytes = 0;
    this.batchPolicies = new Map(); this.tick = 0; this.scanSeq = 0;
  }
  forget(rel) {
    const old = this.metadata.get(rel);
    if (old) this.metadataBytes -= old.cost;
    this.metadata.delete(rel);
  }
  invalidate() {
    for (const scan of this.scans.values()) closeScan(scan);
    this.scans.clear(); this.metadata.clear(); this.metadataBytes = 0;
  }
  close() { this.closed = true; this.invalidate(); }
  checkRoot() {
    const current = projectionRoot(this.root);
    if (this.activeRoot !== null && this.activeRoot !== current.identity) {
      this.invalidate(); this.activeRoot = current.identity;
      throw projectionFailure('restart-required', 'root-object-changed');
    }
    this.activeRoot = current.identity;
    return current;
  }
  remember(rel, value, seenAt = null) {
    const cost = 256 + 2 * (rel.length + value.signature.length + (value.formatError?.length || 0));
    // Stable admission avoids scan-pollution: an over-capacity sequential scan
    // cannot evict the entire working set before reaching it on the next pass.
    this.forget(rel);
    if (this.metadata.size >= PROJECTION_LIMITS.metadataEntries || this.metadataBytes + cost > PROJECTION_LIMITS.metadataBytes) return;
    this.metadata.set(rel, { ...value, cost, seenAt, lastTouch: this.tick }); this.metadataBytes += cost;
  }
  directoryIdentity(rel) {
    if (!rel) return this.checkRoot().identity;
    return objectId(inspectProjectionPath(this.root, rel, { denyPrefixes: this.deny, directory: true, canonical: false }).stat);
  }
  proveListing(rel, expected) {
    let probe;
    try {
      if (expected !== this.directoryIdentity(rel)) throw projectionFailure('restart-required', 'directory-object-changed');
      probe = fs.opendirSync(path.join(this.root, rel), { bufferSize: 1 });
      // A fresh enumeration handle, including its first read, proves current
      // Windows list-directory rights; access(R_OK) and an old Dir cannot.
      probe.readSync();
      if (expected !== this.directoryIdentity(rel)) throw projectionFailure('restart-required', 'directory-object-changed');
    } catch (error) {
      if (error?.code && !String(error.code).startsWith('E')) throw error;
      throwProjectionFs(error);
    } finally { if (probe) { try { probe.closeSync(); } catch {} } }
  }
  openFrame(scan, rel, inherited, counts) {
    if (rel.split('/').filter(Boolean).length > PROJECTION_LIMITS.depth) throw projectionFailure('depth-limit');
    const identity = this.directoryIdentity(rel);
    nested(this.root, rel);
    const ignored = ignoreRules(this.root, rel, inherited, counts);
    let dir;
    try { dir = fs.opendirSync(path.join(this.root, rel), { bufferSize: 1 }); }
    catch (error) { throwProjectionFs(error); }
    let retained = false;
    try {
      if (identity !== this.directoryIdentity(rel)) throw projectionFailure('unstable', 'directory-replaced');
      const frame = { rel, dir, identity, rules: ignored.rules, ignoreSignature: ignored.signature };
      scan.stack.push(frame); this.batchPolicies.set(rel, frame); retained = true;
    } finally { if (!retained) { try { dir.closeSync(); } catch {} } }
  }
  revalidateFrames(scan, counts) {
    let inherited = EMPTY_RULES;
    for (const frame of scan.stack) {
      this.proveListing(frame.rel, frame.identity);
      nested(this.root, frame.rel);
      const current = ignoreRules(this.root, frame.rel, inherited, counts);
      if (current.signature !== frame.ignoreSignature) throw projectionFailure('restart-required', 'ignore-policy-changed');
      inherited = current.rules; frame.rules = current.rules;
      this.batchPolicies.set(frame.rel, frame);
    }
  }
  checkBatchPolicies() {
    for (const frame of this.batchPolicies.values()) {
      this.proveListing(frame.rel, frame.identity);
      nested(this.root, frame.rel);
      let signature = null;
      try { signature = inspectProjectionPath(this.root, frame.rel ? frame.rel + '/.gitignore' : '.gitignore').signature; }
      catch (error) { if (error.code !== 'file-missing') throw error; }
      if (signature !== frame.ignoreSignature) throw projectionFailure('restart-required', 'ignore-policy-changed');
    }
  }
  gateFile(relPath, counts, canonical = false) {
    const rel = checkProjectionLexical(relPath, this.deny);
    const segments = rel.split('/');
    if (segments.length > PROJECTION_LIMITS.depth + 1) throw projectionFailure('depth-limit');
    if (!supported(rel)) throw projectionFailure('unsupported-format', 'extension');
    let rules = ignoreRules(this.root, '', EMPTY_RULES, counts).rules;
    let base = '';
    for (let index = 0; index < segments.length - 1; index++) {
      base = base ? base + '/' + segments[index] : segments[index];
      inspectProjectionPath(this.root, base, { denyPrefixes: this.deny, directory: true });
      if (isIgnored(rules, base, true)) throw projectionFailure('gitignored');
      nested(this.root, base);
      rules = ignoreRules(this.root, base, rules, counts).rules;
    }
    if (isIgnored(rules, rel, false)) throw projectionFailure('gitignored');
    const file = inspectProjectionPath(this.root, rel, { denyPrefixes: this.deny });
    if (!canonical && file.physicalRelPath !== rel) this.gateFile(file.physicalRelPath, counts, true);
    return file;
  }
  observe(file, counts, seenAt = null, includeBytes = false) {
    const io = Object.create(fs);
    io.realpathSync = (...args) => fs.realpathSync.native(...args);
    io.readSync = (...args) => { const amount = fs.readSync(...args); counts.readBytes += amount; return amount; };
    const remaining = PROJECTION_LIMITS.bytes - counts.readBytes;
    const result = readDocument(this.root, file.relPath, { io, attempts: 1, maxBytes: Math.min(MAX_DOC_BYTES, remaining), includeBytes });
    counts.read++;
    const after = inspectProjectionPath(this.root, file.relPath, { denyPrefixes: this.deny, canonical: false });
    if (after.signature !== file.signature) throw projectionFailure('unstable', 'source-changed-during-observation');
    const formatError = !result.ok ? result.code : !result.previewable ? 'unsupported-format' : null;
    if (!formatError || ['undecodable', 'unsupported-format'].includes(formatError)) this.remember(file.relPath, { signature: after.signature, formatError }, seenAt);
    if (formatError) throw projectionFailure(formatError, result.detail);
    return result;
  }
  envelope(counts, scan, startedAt) {
    return { workspaceContext: structuredClone(this.context), policyVersion: this.policyVersion, scanGeneration: scan?.generation || null,
      startedAt, observedAt: new Date().toISOString(), counts, excluded: counts.excluded, rejected: counts.rejected, errors: scan?.gaps || counts.errors,
      cache: { entries: this.metadata.size, estimatedBytes: this.metadataBytes } };
  }
  takeScan(cursor, counts) {
    if (cursor !== undefined && cursor !== null) {
      const scan = typeof cursor === 'string' ? this.scans.get(cursor) : null;
      if (!scan) throw projectionFailure('restart-required', 'unknown-expired-or-cross-context-cursor');
      this.scans.delete(cursor);
      try { this.revalidateFrames(scan, counts); } catch (error) { closeScan(scan); throw error; }
      return scan;
    }
    const scan = { generation: crypto.randomUUID(), number: ++this.scanSeq, startTick: this.tick, stack: [], pending: null, gaps: {}, rejectedGaps: {} };
    this.openFrame(scan, '', EMPTY_RULES, counts);
    return scan;
  }
  nextItem(scan, counts) {
    if (scan.pending) { const item = scan.pending; scan.pending = null; return item; }
    const frame = scan.stack.at(-1);
    // Frame identity/policy is checked before resume and before publication.
    // Do not stat/open a directory once per irrelevant source-code entry.
    let dirent;
    try { dirent = frame.dir.readSync(); }
    catch (error) {
      const failure = classifyFsError(error); record(counts, failure);
      try { frame.dir.closeSync(); } catch {} scan.stack.pop(); return null;
    }
    if (!dirent) { frame.dir.closeSync(); scan.stack.pop(); return null; }
    counts.enumerated++;
    return { rel: frame.rel ? frame.rel + '/' + dirent.name : dirent.name, isDirectory: dirent.isDirectory(), isFile: dirent.isFile() };
  }
  candidate(scan, item, frame, counts, outputBytes) {
    checkProjectionLexical(item.rel, this.deny);
    if (isIgnored(frame.rules, item.rel, item.isDirectory)) throw projectionFailure('gitignored');
    if (item.isDirectory) { this.openFrame(scan, item.rel, frame.rules, counts); return null; }
    if (item.isFile && !supported(item.rel)) throw projectionFailure('unsupported-extension');
    const file = inspectProjectionPath(this.root, item.rel, { denyPrefixes: this.deny, canonical: false });
    if (!supported(item.rel)) throw projectionFailure('unsupported-extension');
    if (file.stat.size > BigInt(MAX_DOC_BYTES)) throw projectionFailure('oversize');
    const previous = this.metadata.get(item.rel);
    const reused = previous?.signature === file.signature;
    if ((!reused && counts.readBytes + Number(file.stat.size) > PROJECTION_LIMITS.bytes)
      || outputBytes + Buffer.byteLength(JSON.stringify(item.rel)) + 512 > PROJECTION_LIMITS.outputBytes) {
      scan.pending = item; return false;
    }
    if (reused) {
      counts.reused++; this.remember(item.rel, previous, scan.number);
      if (previous.formatError) { record(counts, { code: previous.formatError }); return null; }
      return { relPath: item.rel, size: Number(file.stat.size), observation: 'metadata-only', bodyVerified: false, observedAt: new Date().toISOString() };
    }
    const current = this.observe(file, counts, scan.number);
    return { relPath: item.rel, size: current.size, contentHash: current.hash, observation: 'content-read', bodyVerified: true, observedAt: new Date().toISOString() };
  }
  publishScan(scan) {
    if (!scan.stack.length) {
      // A complete pass may retire unseen derived metadata, but never a newer
      // direct observation or another interleaved generation's recent work.
      for (const [rel, value] of this.metadata) {
        if (value.seenAt !== scan.number && value.lastTouch <= scan.startTick) this.forget(rel);
      }
      closeScan(scan); return null;
    }
    const cursor = crypto.randomUUID(); this.scans.set(cursor, scan);
    while (this.scans.size > PROJECTION_LIMITS.generations) {
      const oldest = this.scans.keys().next().value; closeScan(this.scans.get(oldest)); this.scans.delete(oldest);
    }
    return cursor;
  }
  discover(cursor, counts, startedAt, began) {
    let scan;
    try { scan = this.takeScan(cursor, counts); }
    catch (error) {
      if (cursor !== undefined && cursor !== null) throw error;
      record(counts, error);
      return { ...this.envelope(counts, null, startedAt), entries: [], partial: true, nextCursor: null };
    }
    const workBegan = performance.now();
    const initialDepth = scan.stack.length;
    const entries = [];
    let outputBytes = Buffer.byteLength(JSON.stringify(this.envelope(counts, scan, startedAt))) + 4096;
    try {
      while (scan.stack.length && counts.enumerated < PROJECTION_LIMITS.entries && counts.readBytes < PROJECTION_LIMITS.bytes
        && performance.now() - workBegan < PROJECTION_LIMITS.sliceMilliseconds
        && performance.now() - began < PROJECTION_LIMITS.milliseconds) {
        const frame = scan.stack.at(-1);
        const item = this.nextItem(scan, counts);
        if (!item) continue;
        try {
          const entry = this.candidate(scan, item, frame, counts, outputBytes);
          if (entry === false) break;
          if (entry) { entries.push(entry); outputBytes += Buffer.byteLength(JSON.stringify(entry)); }
        } catch (error) {
          // Stable format failures are safe negative cache records; all other
          // failures invalidate observations rather than reviving old content.
          if (!['undecodable', 'unsupported-format'].includes(error.code)) this.forget(item.rel);
          record(counts, error);
        }
      }
      this.checkRoot(); this.checkBatchPolicies();
      if (performance.now() - began >= PROJECTION_LIMITS.milliseconds) throw projectionFailure('restart-required', 'scan-time-budget');
      if (scan.stack.length && scan.stack.length === initialDepth && !counts.enumerated && !counts.read && !counts.reused) throw projectionFailure('restart-required', 'scan-no-progress');
      for (const [reason, amount] of Object.entries(counts.errors)) scan.gaps[reason] = (scan.gaps[reason] || 0) + amount;
      for (const [reason, amount] of Object.entries(counts.rejected)) {
        if (reason.startsWith('ignore-') || reason === 'depth-limit') scan.rejectedGaps[reason] = (scan.rejectedGaps[reason] || 0) + amount;
      }
      const nextCursor = this.publishScan(scan);
      const gaps = Object.keys(scan.gaps).length > 0 || Object.keys(scan.rejectedGaps).length > 0;
      const coverageGaps = {errors:{...scan.gaps},rejected:{...scan.rejectedGaps}};
      return { ...this.envelope(counts, scan, startedAt), entries, coverageGaps, partial: !!nextCursor || gaps, nextCursor };
    } catch (error) { closeScan(scan); throw error; }
  }
  readCheckedBody(relPath, counts, includeBytes = false) {
    this.checkRoot();
    try {
      const file = this.gateFile(relPath, counts);
      const current = this.observe(file, counts, null, includeBytes);
      const after = this.gateFile(relPath, counts);
      if (after.signature !== file.signature) throw projectionFailure('unstable', 'source-changed-after-observation');
      this.checkRoot();
      return {file, current};
    } catch (error) { if (typeof relPath === 'string') this.forget(relPath); throw error; }
  }
  execute({ op, relPath, cursor, maxBytes } = {}) {
    if (this.closed) throw projectionFailure('restart-required', 'scanner-closed');
    if (!['discover', 'read_current', 'refresh_current'].includes(op)) throw projectionFailure('invalid-path', 'unknown-projection-operation');
    const began = performance.now();
    const startedAt = new Date().toISOString();
    const counts = freshCounts(); this.batchPolicies = new Map(); this.tick++;
    try { this.checkRoot(); } catch (error) { this.invalidate(); throw error; }
    if (op === 'discover') return this.discover(cursor, counts, startedAt, began);
    if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > PROJECTION_LIMITS.outputBytes)) throw projectionFailure('invalid-path', 'maxBytes-between-1-and-1048576');
    const {file, current} = this.readCheckedBody(relPath, counts);
    const result = { ...this.envelope(counts, null, startedAt), relPath: file.relPath, contentHash: current.hash, size: current.size,
      observation: 'content-read', bodyVerified: true, retained: false, partial: false, nextCursor: null };
    if (op === 'read_current') {
      const preview = outputPreview(current.text, maxBytes ?? 256 * 1024, Buffer.byteLength(JSON.stringify(result)));
      Object.assign(result, { body: preview.text, totalBytes: preview.totalBytes, truncated: preview.truncated });
    }
    return result;
  }
}

export function createProjectionScanner(options = {}) {
  const scanner = new ProjectionScanner(options);
  return { execute: request => scanner.execute(request),
    readBody: relPath => {
      const {current} = scanner.readCheckedBody(relPath, freshCounts(), true);
      return { ...current, text: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(current.bytes) };
    },
    close: () => scanner.close() };
}

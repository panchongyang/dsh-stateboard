import fs from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { BoardError } from '../errors.js';
import { JsonlStore } from '../store.js';
import { replay } from '../store/format.js';
import { createReadHandle } from '../project-read-handle.js';

function failure(code, message, status = 503) { return new BoardError(code, message, { status }); }

// 用途：确认读取窗口内源文件身份稳定；不将 stat 当作内容校验的替代品。
function fingerprint(dir) {
  const directory = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!directory) throw failure('not-found', 'Project not found', 404);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw failure('project-unreadable', 'Project directory unavailable');
  return [directory.dev, directory.ino, ...['meta.json', 'commits.jsonl', 'snapshot.json'].map(name => {
    const stat = fs.lstatSync(path.join(dir, name), { bigint: true, throwIfNoEntry: false });
    if (!stat && name !== 'snapshot.json') throw failure('project-unreadable', 'Project source missing');
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw failure('project-unreadable', 'Project source unavailable');
    if (stat && stat.size > BigInt(LIMITS.logBytes)) throw failure('knowledge-resource-limit', 'Project source exceeds the knowledge read budget');
    return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : 'missing';
  })].join('|');
}

function tailBoundary(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const byte = Buffer.alloc(1);
    if (size) fs.readSync(fd, byte, 0, 1, size - 1);
    return { unterminatedTail: size > 0 && byte[0] !== 10, scope: 'validated-commit-prefix' };
  } finally { fs.closeSync(fd); }
}

// 用途：复用现有完整存储校验，读取不会补 LF、修日志、创建快照或领取 writer。
function load(query) {
  const meta = JSON.parse(fs.readFileSync(path.join(query.dir, 'meta.json'), 'utf8'));
  if (meta.projectId !== query.projectId || meta.project?.id !== query.projectId) throw failure('project-unreadable', 'Project identity mismatch');
  const store = new JsonlStore(query.dir, meta, { lock: false });
  try {
    const opened = store.open();
    let { commits, state } = opened;
    if (state.project?.id !== query.projectId || state.lastSeq !== commits.length || state.lastHash !== commits.at(-1)?.hash) {
      throw failure('project-unreadable', 'Project snapshot identity mismatch');
    }
    if (query.published) {
      const { seq, hash } = query.published;
      if (commits[seq - 1]?.hash !== hash) throw failure('read-unstable', 'Published project source changed');
      if (commits.length !== seq) {
        commits = commits.slice(0, seq);
        state = replay(meta, commits).state;
      }
    }
    return { meta, state, commits, timeline: [], logBoundary: tailBoundary(path.join(query.dir, 'commits.jsonl')) };
  } finally { store.close(); }
}

// 用途：单请求固定经过校验的日志水位；文件变化最多重试一次，冷读不信任索引缓存。
export function readKnowledgeSnapshot(query) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = fingerprint(query.dir);
    let snapshot, rejected;
    try { snapshot = load(query); } catch (error) { rejected = error; }
    if (before !== fingerprint(query.dir)) continue;
    if (rejected) throw rejected;
    const handle = createReadHandle(query, snapshot);
    handle.service.reloadBindings();
    return { ...snapshot, handle, projectId: query.projectId, seq: snapshot.state.lastSeq, hash: snapshot.state.lastHash };
  }
  throw failure('read-unstable', 'Project changed during knowledge read');
}

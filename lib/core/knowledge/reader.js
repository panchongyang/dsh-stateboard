import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { BoardError } from '../errors.js';
import { knowledgeRequest } from './request.js';

let active = 0;
function unavailable(code, message) { return new BoardError(code, message, { status: 503 }); }

function workerEnvironment() {
  // 只读 Git 使用既有执行沙箱；worker 不继承凭据、执行注入或第三方加载设置。
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive',
    'home', 'userprofile', 'temp', 'tmp', 'tmpdir', 'appdata', 'localappdata']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase()))),
    PATH: process.env.PATH || process.env.Path || '' };
}

function run(data, jobs, options, signal) {
  signal?.throwIfAborted();
  if (active >= 1) throw unavailable('knowledge-busy', 'Knowledge reads are busy; retry later');
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    workerData: data, env: workerEnvironment(), execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  active++;
  return new Promise((resolve, reject) => {
    let stopping;
    const finish = (error, result) => {
      if (stopping) return stopping;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      stopping = worker.terminate().catch(() => { error ??= unavailable('knowledge-unavailable', 'Knowledge worker could not stop'); })
        .then(() => { active--; jobs.delete(cancel); if (error != null) reject(error); else resolve(result); });
      return stopping;
    };
    const cancel = () => finish(unavailable('closed', 'Knowledge reader is closed'));
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(unavailable('knowledge-expired', 'Knowledge read exceeded its deadline')), options.timeoutMs ?? LIMITS.timeoutMs);
    jobs.add(cancel);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', ({ error, result }) => finish(error ? new BoardError(error.code, error.message, { status: error.status }) : null, result));
    worker.once('error', () => finish(unavailable('knowledge-unavailable', 'Knowledge worker failed')));
    worker.once('exit', () => finish(unavailable('knowledge-unavailable', 'Knowledge worker exited without a result')));
  });
}

// 用途：专用读取端口只传已发布提交锚点；无 writer 回调、续租、写事务或启动依赖。
// options 仅为合成测试收紧预算/禁用能力；MCP 不公开故障注入开关。
export function createKnowledgeReader(service, options = {}) {
  let closed = false;
  const jobs = new Set();
  async function request(operation, input, signal) {
    if (closed) throw unavailable('closed', 'Knowledge reader is closed');
    signal?.throwIfAborted();
    const args = knowledgeRequest(operation, input);
    const writer = service.lookupLiveWriter(args.projectId);
    const published = writer ? { seq: writer.store.state.lastSeq, hash: writer.store.state.lastHash } : null;
    const result = await run({ operation, args, projectId: args.projectId, rootDir: service.rootDir,
      dir: path.join(service.projectsDir, args.projectId), published, now: service.clock().getTime(), options }, jobs, options, signal);
    signal?.throwIfAborted();
    if (closed) throw unavailable('closed', 'Knowledge reader is closed');
    // 冷读启动后可能出现 writer；磁盘合法尾部仍可能处于 fsync/回滚窗口。
    const current = service.lookupLiveWriter(args.projectId);
    const log = result.coverage.log;
    if (current && current.store.commits[log.verifiedThrough - 1]?.hash !== log.verifiedHash) {
      throw unavailable('read-unstable', 'Project publication changed during knowledge read; retry');
    }
    return result;
  }
  // signal 是调用生命周期，不属于业务输入或可序列化 worker 参数。
  return { search: (args, { signal } = {}) => request('search', args, signal), read: (args, { signal } = {}) => request('read', args, signal),
    async close() { closed = true; await Promise.all([...jobs].map(cancel => cancel())); } };
}

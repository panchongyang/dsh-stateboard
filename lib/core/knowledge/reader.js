import { projectDataDir } from '../store/space-home.js';
import { Worker } from 'node:worker_threads';
import { KNOWLEDGE_LIMITS as LIMITS } from '../../shared/knowledge.js';
import { BoardError } from '../errors.js';
import { knowledgeRequest } from './request.js';
import { capabilities, assertAuthority, contextOf } from '../reader/projection-context.js';

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
    worker.once('message', message => {
      const { error } = message;
      finish(error ? new BoardError(error.code, error.message, { status: error.status }) : null, message);
    });
    worker.once('error', () => finish(unavailable('knowledge-unavailable', 'Knowledge worker failed')));
    worker.once('exit', () => finish(unavailable('knowledge-unavailable', 'Knowledge worker exited without a result')));
  });
}

// Hold bounded P3 metadata, not source text. A scope's P3 cursor is
// committed in memory only after the worker has consumed that page.
function createDiscoveryReplay(service) {
  const discoveries = new Map();
  const loading = new Set();
  function remember(scopeKey, state) {
    discoveries.delete(scopeKey);
    discoveries.set(scopeKey, state);
    if (discoveries.size > 4) discoveries.delete(discoveries.keys().next().value);
    return state;
  }
  async function discover(projectId, authority, workspace, check, previous) {
    const { scopeKey } = workspace;
    const cursor = previous?.cursor;
    let page;
    try {
      page = await service.queryWorkspaceProjection(projectId, { op: 'discover', ...(cursor ? { cursor } : {}) }, authority);
    } catch (error) {
      await check(); // Authorization failures must never become partial success.
      if (!['restart-required', 'projection-busy', 'projection-timeout', 'projection-unavailable'].includes(error.code)) throw error;
      return remember(scopeKey, { page: { partial: true, error: error.code, entries: [] }, pending: false,
        cursor: error.code === 'restart-required' ? undefined : cursor });
    }
    await check();
    const encoded = JSON.stringify(page);
    if (Buffer.byteLength(encoded) > 1024 * 1024) {
      // Do not consume a page we cannot retain for replay.
      return remember(scopeKey, { page: { partial: true, error: 'discovery-page-limit', entries: [] }, pending: false, cursor });
    }
    return remember(scopeKey, { page: JSON.parse(encoded), pending: true, cursor });
  }
  return {
    async select(projectId, authority, workspace, check, cursor) {
      const { scopeKey } = workspace;
      const previous = discoveries.get(scopeKey);
      if (cursor || previous?.pending) return previous;
      // Projection cursors are single-use. Do not race two loaders on a page.
      if (loading.has(scopeKey)) throw unavailable('knowledge-busy', 'Knowledge discovery is busy; retry later');
      loading.add(scopeKey);
      try { return await discover(projectId, authority, workspace, check, previous); }
      finally { loading.delete(scopeKey); }
    },
    settle(scopeKey, pageProgress, result, cursor) {
      if (!pageProgress || discoveries.get(scopeKey) !== pageProgress || pageProgress.page.error || (cursor && result.engine !== 'scan')) return;
      if (result.coverage.workspace?.pagePending === false) {
        remember(scopeKey, { ...pageProgress, pending: false, cursor: pageProgress.page.nextCursor });
      }
    },
    clear: () => discoveries.clear(),
  };
}

// 用途：专用读取端口只传已发布提交锚点；无 writer 回调、续租、写事务或启动依赖。
// options 仅为合成测试收紧预算/禁用能力；MCP 不公开故障注入开关。
export function createKnowledgeReader(service, options = {}) {
  let closed = false;
  const jobs = new Set();
  const discoveries = createDiscoveryReplay(service);
  async function request(operation, input, { signal, authority: provided, onModelMaterial } = {}) {
    if (closed) throw unavailable('closed', 'Knowledge reader is closed');
    signal?.throwIfAborted();
    const args = knowledgeRequest(operation, input);
    // Lifecycle authority is process-local, never accepted in business inputs or
    // serialized to the worker. Legacy non-scoped readers gain no default ACL.
    if (provided !== undefined && (!provided || typeof provided !== 'object' || Array.isArray(provided))) {
      throw new BoardError('project-forbidden', 'An authorized owning workspace is required', { status: 403 });
    }
    const authority = provided !== undefined || service.assertAccess ? capabilities(service, provided) : null;
    if (authority) await assertAuthority(service, authority);
    const workspace = authority ? contextOf(service, args.projectId, authority) : undefined;
    const check = async () => {
      if (authority) {
        await assertAuthority(service, authority);
        if (contextOf(service, args.projectId, authority).scopeKey !== workspace.scopeKey) {
          throw new BoardError('restart-required', 'Workspace discovery context changed; start again');
        }
      }
      signal?.throwIfAborted();
      if (closed) throw unavailable('closed', 'Knowledge reader is closed');
    };
    const discoveryState = workspace && operation === 'search'
      ? await discoveries.select(args.projectId, authority, workspace, check, args.cursor) : undefined;
    const discovery = discoveryState?.page;
    if (authority) await check();
    // Only the published value is consulted; a hot read never takes a writer.
    const live = service.publishedState?.(args.projectId) || null;
    const published = live ? { seq: live.lastSeq ?? live.state.lastSeq, hash: live.lastHash } : null;
    const collectModelMaterial = typeof onModelMaterial === 'function';
    let handoff;
    try {
      handoff = await run({ operation, args, projectId: args.projectId, rootDir: service.rootDir, fileEvidenceRoot: service.spaceHome?.root,
        dir: projectDataDir(service, args.projectId), published, now: service.clock().getTime(), options, collectModelMaterial,
        ...(workspace ? { workspace } : {}), ...(discovery ? { discovery } : {}) }, jobs, options, signal);
    } catch (error) { await check(); throw error; }
    await check();
    const { result, modelMaterial } = handoff;
    // 冷读启动后可能出现 writer；磁盘合法尾部仍可能处于 fsync/回滚窗口。
    const current = service.publishedState?.(args.projectId) || null;
    const log = result.coverage.log;
    if (current && current.commits?.[log.verifiedThrough - 1]?.hash !== log.verifiedHash) {
      throw unavailable('read-unstable', 'Project publication changed during knowledge read; retry');
    }
    discoveries.settle(workspace?.scopeKey, discoveryState, result, args.cursor);
    // An observer cannot change the public result, nor see a failed handoff.
    if (collectModelMaterial && modelMaterial) {
      try { onModelMaterial(modelMaterial); } catch { /* Presentation is optional. */ }
    }
    return result;
  }
  // Lifecycle options are not business inputs; only the opt-in boolean goes to the worker.
  return { search: (args, lifecycle) => request('search', args, lifecycle), read: (args, lifecycle) => request('read', args, lifecycle),
    async close() { closed = true; discoveries.clear(); await Promise.all([...jobs].map(cancel => cancel())); } };
}

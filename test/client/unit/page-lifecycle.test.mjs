/**
 * 测试职责：约束页面读取生命周期、写后尾读、项目定位及认证失败恢复。
 * 典型流程：受控 Promise/事件目标/定时器与 fake fetch → 重载/停止/跳转/认证拒绝 → 比较快照和请求数。
 * 覆盖边界：覆盖 异步栅栏、轮询退避、取消和能力认证分类；不覆盖真实 DOM、网络或视觉。
 * 外部前置：无；所有浏览器对象和 fetch 均为合成替身。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageRead } from '../../../src/client/api/read-lifecycle.ts';
import { mainViewCwd, locateProject } from '../../../src/client/model/project-location.ts';
import { api, command } from '../../../src/client/api/transport.ts';
import { accessSnapshot, accessRevision, accessFailed, accessSucceeded, confirmPageReload } from '../../../src/client/model/page-access.ts';
import { authFailure, checkAuth } from '../../../lib/host/auth.js';

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function rig(poll = false) {
  const document = new EventTarget(); document.visibilityState = 'visible';
  const window = new EventTarget();
  const timers = new Map(); let serial = 0;
  const calls = [];
  const reader = createPageRead(options => { const d = deferred(); calls.push({ ...d, options }); return d.promise; }, [], {
    document, window, poll,
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { reader, calls, document, window, timers };
}

// 责任：首读慢或失败须保持未就绪而非空成功，重试成功后才 ready 且清错误。
test('slow initial load and failure are not an empty success; retry is usable', async () => {
  const r = rig(); r.reader.start();
  assert.equal(r.reader.snapshot().ready, false);
  r.calls[0].reject(new Error('offline')); await flush();
  assert.equal(r.reader.snapshot().loading, false);
  assert.equal(r.reader.snapshot().ready, false);
  const retry = r.reader.reload(); r.calls[1].resolve([]); await retry;
  assert.equal(r.reader.snapshot().ready, true);
  assert.equal(r.reader.snapshot().error, null); r.reader.stop();
});

// 责任：已有数据刷新失败须保留原对象与项目身份，不能清空选中值。
test('refresh failure preserves the previously loaded value and identity', async () => {
  const r = rig(); const data = [{ id: 'chosen' }]; r.reader.start(); r.calls[0].resolve(data); await flush();
  const retry = r.reader.reload(); r.calls[1].reject(new Error('denied')); await retry;
  assert.equal(r.reader.snapshot().data, data); assert.equal(r.reader.snapshot().ready, true); r.reader.stop();
});

// 责任：普通读取须合并同 flight，写失效后须执行并等待一次尾读且不发布写前数据。
test('ordinary reads coalesce; mutation invalidation executes and awaits trailing read', async () => {
  const r = rig(); r.reader.start();
  const old = r.reader.reload(false); assert.equal(r.reader.reload(false), old); assert.equal(r.calls.length, 1);
  const changed = r.reader.reload(); assert.equal(changed, old);
  r.calls[0].resolve(['pre-write']); await flush();
  assert.equal(r.calls.length, 2); assert.deepEqual(r.reader.snapshot().data, []);
  let done = false; changed.then(() => { done = true; }); await flush(); assert.equal(done, false);
  r.calls[1].resolve(['post-write']); await changed;
  assert.deepEqual(r.reader.snapshot().data, ['post-write']); r.reader.stop();
});

// 责任：完成微任务阶段到来的写失效也必须触发尾读，原 Promise 不能过早结束。
test('write invalidation in the completion microtask still awaits a trailing read', async () => {
  const r = rig(); r.reader.start(); const pending = r.reader.reload(false);
  r.calls[0].resolve(['before-write']);
  await Promise.resolve(); // load continuation finished; its finalizer is queued.
  assert.equal(r.reader.reload(), pending);
  await flush(); assert.equal(r.calls.length, 2);
  let done = false; pending.then(() => { done = true; }); await flush(); assert.equal(done, false);
  r.calls[1].resolve(['after-write']); await pending;
  assert.deepEqual(r.reader.snapshot().data, ['after-write']); r.reader.stop();
});

// 责任：cleanup/setup 重放须新起读取，旧请求即使忽略 abort 成功也不得回写。
test('cleanup/setup replay starts a new flight and fences ignored abort completion', async () => {
  const r = rig(); r.reader.start(); const first = r.reader.reload(false);
  r.reader.stop(); assert.equal(r.calls[0].options.signal.aborted, true);
  r.reader.start(); assert.equal(r.calls.length, 2);
  r.calls[0].resolve(['old']); await first;
  assert.equal(r.reader.snapshot().ready, false);
  r.calls[1].resolve(['new']); await flush();
  assert.deepEqual(r.reader.snapshot().data, ['new']); assert.equal(r.reader.snapshot().loading, false); r.reader.stop();
});

// 责任：不同 scope reader 的旧响应不得污染新 scope 快照。
test('different scope readers cannot publish old results into new scope', async () => {
  const a = rig(), b = rig(); a.reader.start(); a.reader.stop(); b.reader.start();
  b.calls[0].resolve(['B']); await flush(); a.calls[0].resolve(['A']); await flush();
  assert.deepEqual(b.reader.snapshot().data, ['B']); assert.equal(a.reader.snapshot().ready, false); b.reader.stop();
});

// 责任：隐藏页须停计时器，focus/pageshow 合并请求，失败退避与停止清理均须有界。
test('hidden pauses timers, focus/pageshow coalesce, retry backoff and cleanup remain bounded', async () => {
  const r = rig(true); r.reader.start(); r.calls[0].reject(new Error('offline')); await flush();
  assert.equal([...r.timers.values()][0].ms, 2000);
  r.document.visibilityState = 'hidden'; r.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(r.timers.size, 0); r.window.dispatchEvent(new Event('focus')); assert.equal(r.calls.length, 1);
  r.document.visibilityState = 'visible'; r.document.dispatchEvent(new Event('visibilitychange'));
  r.window.dispatchEvent(new Event('focus')); r.window.dispatchEvent(new Event('pageshow')); assert.equal(r.calls.length, 2);
  r.calls[1].reject(new Error('offline')); await flush(); assert.equal([...r.timers.values()][0].ms, 4000);
  const retry = r.reader.reload(); r.calls[2].resolve(['ok']); await retry; assert.equal([...r.timers.values()][0].ms, 2000);
  r.reader.stop(); assert.equal(r.timers.size, 0); r.window.dispatchEvent(new Event('focus')); assert.equal(r.calls.length, 3);
});

// 责任：定位须等待列表成功且只用唯一 mainView cwd，不能取首项目或其他旧会话。
test('location waits for a successful list and only uses one explicit main-view cwd', () => {
  const projects = [{ id: 'p', workspacePath: 'D:\\work' }];
  assert.equal(locateProject({ projects, ready: false, loading: true }, 'D:\\work').phase, 'loading');
  assert.equal(locateProject({ projects: [], ready: false, error: 'offline' }, 'D:\\work').phase, 'failed');
  assert.equal(locateProject({ projects, ready: true }, '').phase, 'unknown');
  assert.equal(locateProject({ projects, ready: true }, 'D:\\work').project.id, 'p');
  assert.equal(locateProject({ projects, ready: true }, 'D:\\other').phase, 'unmatched');
  assert.equal(mainViewCwd({ byId: { old: { cwd: 'old', updatedAt: 999 } } }), '');
  assert.equal(mainViewCwd({ byId: { a: { cwd: 'a', retainedBy: { mainView: 1 } } } }), 'a');
  assert.equal(mainViewCwd({ byId: { a: { cwd: 'a', retainedBy: { mainView: 1 } }, b: { cwd: 'b', retainedBy: { mainView: 1 } } } }), '');
});

// 责任：认证须区分 token mismatch 与来源拒绝，分类不能放宽任一安全检查。
test('auth separates token mismatch from source rejection without relaxing checks', () => {
  const req = headers => ({ headers: { host: 'localhost:3080', ...headers } });
  assert.equal(authFailure(req({}), 'abc'), 'token-mismatch');
  assert.equal(checkAuth(req({ 'x-project-board-token': 'abc', origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin' }), 'abc'), true);
  for (const token of ['abc', 'bad']) {
    assert.equal(authFailure(req({ 'x-project-board-token': token, origin: 'http://evil.example' }), 'abc'), 'origin-rejected');
    assert.equal(authFailure(req({ 'x-project-board-token': token, 'sec-fetch-site': 'cross-site' }), 'abc'), 'fetch-site-rejected');
  }
});

// 责任：仅能力认证 403 才标恢复状态，任何被拒写请求都绝不能自动重放。
test('transport classifies only capability 403 and NEVER replays a rejected write', async t => {
  const original = globalThis.fetch, config = globalThis.__PROJECT_BOARD__;
  t.after(() => { globalThis.fetch = original; globalThis.__PROJECT_BOARD__ = config; });
  globalThis.__PROJECT_BOARD__ = { base: '/test', token: 'page' };
  accessSucceeded(accessSnapshot()?.token, accessRevision());
  for (const code of ['forbidden', 'origin-rejected', 'fetch-site-rejected']) {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { code } }), { status: 403 });
    await assert.rejects(api('/projects'), e => e.code === code); assert.equal(accessSnapshot(), null);
  }
  let calls = 0;
  globalThis.fetch = async (_url, init) => { calls++; assert.equal(init.method, 'POST'); return new Response(JSON.stringify({ ok: false, error: { code: 'token-mismatch' } }), { status: 403 }); };
  await assert.rejects(command('p', { op: 'task.create' }), e => e.code === 'token-mismatch');
  assert.equal(calls, 1); assert.equal(accessSnapshot().code, 'token-mismatch');
});

// 责任：读取 body 超时和外部 abort 须有界，并清理外部 signal 监听器。
test('body timeout and external abort are bounded; external listeners are removed', async t => {
  const original = globalThis.fetch, config = globalThis.__PROJECT_BOARD__;
  t.after(() => { globalThis.fetch = original; globalThis.__PROJECT_BOARD__ = config; });
  globalThis.__PROJECT_BOARD__ = { base: '/test', token: 'page' };
  globalThis.fetch = async (_url, init) => ({ text: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')), { once: true })) });
  const external = new AbortController(); let added = 0, removed = 0;
  const add = external.signal.addEventListener.bind(external.signal), remove = external.signal.removeEventListener.bind(external.signal);
  external.signal.addEventListener = (...args) => { added++; add(...args); };
  external.signal.removeEventListener = (...args) => { removed++; remove(...args); };
  await assert.rejects(api('/projects', { signal: external.signal, timeoutMs: 10 }), /超时/);
  assert.equal(added, removed);
  const pending = api('/projects', { signal: external.signal }); await flush(); external.abort(); await assert.rejects(pending, /取消/);
  assert.equal(added, removed);
});

// 责任：缺注入配置须有可恢复提示，旧成功结果不能抹掉更新的拒绝状态。
test('missing injection has a recoverable notice; stale success cannot erase later denial', async t => {
  const config = globalThis.__PROJECT_BOARD__; t.after(() => { globalThis.__PROJECT_BOARD__ = config; });
  delete globalThis.__PROJECT_BOARD__; await assert.rejects(api('/projects'), e => e.code === 'page-config-missing');
  assert.equal(accessSnapshot().code, 'page-config-missing');
  const revision = accessRevision(); accessFailed({ code: 'token-mismatch' }, 'page'); accessSucceeded('page', revision);
  assert.equal(accessSnapshot().code, 'token-mismatch');
});

// 责任：取消页面 reload 须保留状态且不导航，显式同意后只刷新一次。
test('reload cancellation preserves state and does not navigate; approval reloads once', () => {
  let reloaded = 0; const draft = { text: 'unsaved' };
  const win = { confirm: () => false, location: { reload() { reloaded++; } } };
  assert.equal(confirmPageReload(win), false); assert.equal(reloaded, 0); assert.equal(draft.text, 'unsaved');
  win.confirm = message => { assert.match(message, /未保存/); return true; };
  assert.equal(confirmPageReload(win), true); assert.equal(reloaded, 1);
});

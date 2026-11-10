/**
 * 测试职责：限制请求竞态、轮询退避及页面停止后的迟到数据写回。
 * 典型流程：构造请求 gate 和可控 Promise → 发新请求/停止 reader → 对照 token、signal 与快照。
 * 覆盖边界：覆盖 请求栅栏、退避上限、抽屉 key 和源码接线；不覆盖浏览器网络与视觉。
 * 外部前置：无；纯逻辑及 transport 源码检查。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { POLL_INTERVAL_MS, REQUEST_TIMEOUT_MS, backoffDelay, drawerKey } from '../../src/client/model/races.ts';
import { createRequestGate } from '../../src/client/api/request-gate.ts';
import { createPageRead } from '../../src/client/api/read-lifecycle.ts';

// 责任：连续发起请求后仅最新 id 可提交，abortAll 须取消信号并使当前 id 失效。
test('a late response loses to a newer request', () => {
  const gate = createRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first.id), false, 'the first request is stale');
  assert.equal(gate.isCurrent(second.id), true, 'the newest request may commit');
  assert.equal(first.signal.aborted, false, 'beginning a request does not abort its siblings');
  first.abort();
  assert.equal(first.signal.aborted, true);
  gate.abortAll();
  assert.equal(second.signal.aborted, true, 'unmount aborts everything in flight');
  assert.equal(gate.isCurrent(second.id), false, 'and nothing may commit after that');
});

// 责任：增加失败次数须指数退避至 30 秒封顶，负次数回到基础轮询间隔。
test('polling backs off after failures and caps the delay', () => {
  assert.equal(backoffDelay(0), POLL_INTERVAL_MS);
  assert.equal(backoffDelay(1), 4000);
  assert.equal(backoffDelay(2), 8000);
  assert.equal(backoffDelay(3), 16000);
  assert.equal(backoffDelay(10), 30000, 'the cap holds');
  assert.equal(backoffDelay(-1), POLL_INTERVAL_MS, 'a bad attempt resets to the base');
  assert.equal(backoffDelay(0, 500, 3000), 500);
});

// 责任：切换项目或任务须生成不同抽屉 key，空任务应有稳定 none 标识。
test('the drawer key changes with the task so switching tasks remounts it', () => {
  assert.equal(drawerKey('prj_a', 'tsk_1'), 'drawer:prj_a:tsk_1');
  assert.notEqual(drawerKey('prj_a', 'tsk_1'), drawerKey('prj_a', 'tsk_2'));
  assert.notEqual(drawerKey('prj_a', 'tsk_1'), drawerKey('prj_b', 'tsk_1'));
  assert.equal(drawerKey('prj_a', null), 'drawer:prj_a:none');
});

// 责任：读取 transport 源码须保留超时控制、AbortController 和外部 signal，超时常量不超过 30 秒。
test('transport honours a request timeout and an external abort signal', () => {
  const source = readFileSync(new URL('../../src/client/api/transport.ts', import.meta.url), 'utf8');
  assert.match(source, /REQUEST_TIMEOUT_MS|timeoutMs/, 'a request timeout exists');
  assert.match(source, /AbortController/, 'requests can be aborted');
  assert.match(source, /options\.signal/, 'an external signal is respected');
  assert.ok(REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS <= 30000);
});

// 责任：停止 reader 后即使旧轮询成功返回，信号须已取消且快照仍未就绪、无旧数据。
test('the page reader aborts and fences a late poll completion', async () => {
  let finish, signal;
  const reader = createPageRead(options => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  }, null, { poll: true });
  reader.start();
  const pending = reader.reload(false);
  reader.stop();
  assert.equal(signal.aborted, true);
  finish({ stale: true });
  await pending;
  assert.equal(reader.snapshot().data, null);
  assert.equal(reader.snapshot().ready, false);
});

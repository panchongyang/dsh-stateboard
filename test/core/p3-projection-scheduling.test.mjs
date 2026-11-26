/**
 * 测试职责：验证宿主共享扫描槽、缓存复用边界以及监听降级补扫。
 * 典型流程：两个独立空间提交分页请求；丢失监听、撤销权限或关闭时检查在途工作。
 * 覆盖边界：覆盖调度协议与降级；不覆盖实际文件扫描或宿主注册链路。
 * 外部前置：仅用 Node 内建组件，不启动 DSH 或连接真实工作区。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createProjectionPool } from '../../lib/core/reader/projection-pool.js';
import { createProjectionHints } from '../../lib/core/reader/projection-hints.js';

// 分段职责：手动完成 worker 回包，以观察共享槽而不依赖磁盘运行时间。
class SampleWorker extends EventEmitter {
  sent = [];
  ref() {}
  unref() {}
  postMessage(msg) { this.sent.push(msg); if (msg.forget) queueMicrotask(() => this.emit('message',{released:msg.id,empty:true})); }
  answer(value) { this.emit('message',{id:this.sent.at(-1).id,result:value}); }
  async terminate() { this.terminated = true; }
}
const context = owner => ({owner,scopeKey:owner});

// 责任：相同刷新复用一项工作；另一工作区串行排队，后台不挤占前台，排队后撤权不派工。
test('scopes share a single scan lane; queued authority is checked at dispatch', async () => {
  const workers = [], pool = createProjectionPool({makeWorker:() => {const w = new SampleWorker(); workers.push(w); return w;}});
  const first = pool.submit(context('A'),{op:'refresh_current',relPath:'one.md'});
  const same = pool.submit(context('A'),{op:'refresh_current',relPath:'one.md'});
  assert.equal(first,same);
  const revoked = pool.submit(context('B'),{op:'discover'},{check:() => { throw Error('revoked'); }});
  const denied = assert.rejects(revoked,/revoked/);
  const third = pool.submit(context('C'),{op:'discover'});
  await assert.rejects(pool.submit(context('D'),{op:'discover'},{background:true}),{code:'projection-busy'});
  assert.equal(workers.length,1); assert.equal(workers[0].sent.length,1);
  workers[0].answer('first'); assert.equal(await first,'first');
  await denied; await yieldTurn();
  assert.deepEqual(workers[0].sent.map(m => m.context.owner),['A','C']);
  workers[0].answer('third'); assert.equal(await third,'third');
  await pool.release('C'); await pool.release('A');
});

// 责任：超过批预算必须结束请求，即使 worker 仍在退出也不能启动第二个扫描线程。
test('hard timeout does not create parallel replacement workers', async () => {
  const stopped = Promise.withResolvers(), workers = [];
  const pool = createProjectionPool({timeoutMs:40,makeWorker:() => {
    const w = new SampleWorker(); w.terminate = () => stopped.promise; workers.push(w); return w;
  }});
  await assert.rejects(pool.submit(context('A'),{op:'discover'}),{code:'projection-timeout'});
  await assert.rejects(pool.submit(context('B'),{op:'discover'}),{code:'projection-busy'});
  assert.equal(workers.length,1); stopped.resolve();
});

// 责任：监听失败仍补扫；连续提示合并；续扫让出间隙；撤销权限后停止，不靠旧定时器继续读。
test('watch failure falls back to bounded compensation and reauthorizes each page', async () => {
  const future = [], calls = [];
  const scheduler = createProjectionHints({watchRoot:() => {throw Error('unsupported');},timer:(cb,delay) => {
    future.push({cb,delay}); return {unref(){return this;}};
  }});
  let current = true;
  const row = {owner:'A',key:'scope',root:'synthetic',check:() => {if (!current) throw Object.assign(Error(),{code:'project-forbidden'});},
    scan:cursor => {calls.push(cursor); return {partial:!cursor,nextCursor:cursor ? null : 'page2'};}};
  scheduler.hint(row); scheduler.hint(row); assert.equal(future.length,1); assert.deepEqual(calls,[]);
  await future.shift().cb(); assert.equal(scheduler.status('scope'),'unavailable');
  const page = future.shift(); assert.ok(page.delay > 0); await page.cb();
  assert.deepEqual(calls,[null,'page2']);
  const next = future.shift(); assert.ok(next.delay > page.delay); current = false; await next.cb();
  assert.equal(scheduler.status('scope'),'not-attached'); assert.equal(future.length,0); assert.equal(calls.length,2);
});

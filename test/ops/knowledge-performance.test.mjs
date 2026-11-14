/**
 * 测试职责：配对测量知识检索关闭/并发开启时的任务操作、事件循环、查询与 RSS。
 * 典型流程：同一合成历史先冷建/热查，再交替执行带检索与不带检索的完整任务周期。
 * 覆盖边界：覆盖本机合成负载及严重性能回归；不覆盖真实规模 SLA。
 * 外部前置：本地文件系统；不要求向量服务、模型或真实项目。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import test from 'node:test';
import { knowledgeFixture, addTask, cmd } from '../helpers/knowledge-fixture.mjs';

const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const round = value => Math.round(value * 100) / 100;

async function cycle(f, i) {
  const start = performance.now();
  const taskId = await addTask(f.h, 'paired task ' + i);
  const expected = () => ({ entityRev: f.h.state.tasks[taskId].rev });
  await f.h.command(cmd('task.claim', { taskId, expected: expected() }));
  const fencingToken = f.h.leases.get(taskId).token;
  await f.h.command(cmd('task.begin', { taskId, expected: expected(), fencingToken, summary: 'Paired fixture work' }));
  await f.h.command(cmd('task.submit', { taskId, expected: expected(), fencingToken,
    evidence: [{ kind: 'note', ref: 'Synthetic complete evidence', acceptanceId: f.h.state.tasks[taskId].acceptance[0].id }] }));
  await f.h.command(cmd('task.verify', { taskId, expected: expected() }));
  assert.equal(f.h.state.tasks[taskId].state, 'done');
  return performance.now() - start;
}

// 责任：配对任务周期全部成功，独立检索不在主线程执行，响应与运行成本受预算限制。
test('knowledge search stays outside paired task writes and reports bounded synthetic costs', { timeout: 120000 }, async t => {
  const f = await knowledgeFixture(t);
  await f.h.command(cmd('plan.publish', { title: 'Synthetic history corpus', steps: [
    { id: 's1', title: 'Independent tasks', tasks: Array.from({ length: 250 }, (_, i) => ({
      key: 'k' + i, title: 'perfhistory ' + i, description: '约束恢复不能等同于事实权威性。'.repeat(12), acceptance: [{ text: 'Check recorded boundary' }],
    })) },
  ] }));
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let peakRss = process.memoryUsage().rss;
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  t.after(() => { clearInterval(sample); delay.disable(); });
  const start = performance.now();
  const first = await f.search('perfhistory', { limit: 20 });
  const coldMs = performance.now() - start;
  assert.ok(first.hits.length);
  const warm = [];
  for (let i = 0; i < 4; i++) { const at = performance.now(); await f.search('perfhistory', { limit: 20 }); warm.push(performance.now() - at); }
  const off = [], on = [], query = [];
  for (let i = 0; i < 12; i++) {
    const enabled = i % 2 === 1;
    const at = performance.now();
    const searching = enabled ? f.search('perfhistory').then(result => { query.push(performance.now() - at); return result; }, error => ({ error: error.code })) : null;
    (enabled ? on : off).push(await cycle(f, i));
    const result = searching ? await searching : null;
    assert.ok(!result?.error || result.error === 'read-unstable', JSON.stringify(result?.error));
  }
  const cache = path.join(f.stateDir, 'knowledge-cache');
  const cacheBytes = fs.existsSync(cache) ? fs.readdirSync(cache).reduce((sum, name) => sum + fs.statSync(path.join(cache, name)).size, 0) : 0;
  const report = { engine: first.engine, seedTasks: 250, successfulTaskCycles: 12, coldMs: round(coldMs), warmP50Ms: round(quantile(warm, .5)),
    offP50Ms: round(quantile(off, .5)), offP95Ms: round(quantile(off, .95)), onP50Ms: round(quantile(on, .5)), onP95Ms: round(quantile(on, .95)),
    queryP95Ms: query.length ? round(quantile(query, .95)) : null, eventLoopP95Ms: round(delay.percentile(95) / 1e6), peakRssMiB: round(peakRss / 1048576),
    cacheBytes, responseBytes: Buffer.byteLength(JSON.stringify(first)), logBytes: fs.statSync(f.h.store.commitsFile).size };
  t.diagnostic(JSON.stringify(report));
  assert.ok(coldMs < 30000);
  assert.ok(report.onP95Ms < Math.max(5000, report.offP95Ms * 10), 'paired writes should not wait on indexing');
  assert.ok(report.eventLoopP95Ms < 2000, 'worker work must not run synchronously on the host event loop');
  assert.ok(report.responseBytes < 256 * 1024);
});

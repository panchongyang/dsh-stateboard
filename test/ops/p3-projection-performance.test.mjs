/**
 * 测试职责：约束 P3 工作区投影在合成大仓上的发现预算、正文复用、单项变更增量与宿主任务延迟。
 * 典型流程：建两个独立 owning space 和混合夹具 → 冷/热分页 discover → 单改扫描 → 在续页真实在途时交错执行 task.create。
 * 覆盖边界：覆盖 P3 契约态、真实任务命令 p95、readBytes 与事件循环间隙；不覆盖真实仓库、权限、gitignore 组合语义或索引正确性。
 * 外部前置：需要可写临时目录和已实现的 `ProjectService#queryWorkspaceProjection`；不使用 legacy rootDir；合成夹具保留不删。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { command } from '../helpers/service-fixture.mjs';

const repoRoot = fs.realpathSync.native(path.resolve(import.meta.dirname, '../..'));

function containsPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
// 正文数保持在元数据缓存上限（PROJECTION_LIMITS.metadataEntries=16384，4MiB）以内，热扫描复用才有意义。
const MAIN = { sections: 30, perSection: 200 };
const SECOND = { sections: 20, perSection: 60 };
const SOURCE = { js: 300, ts: 150, py: 50 };
const MAX_PAGES = 1200;
const PROBE = 'P3 projection scan marker';
const COLD_EXPECTED_MS = 60_000, COLD_HARD_MS = 180_000;

function coldScanTier(ms) {
  assert.ok(Number.isFinite(ms) && ms >= 0, 'missing or invalid cold-scan measurement');
  if (ms <= COLD_EXPECTED_MS) return 'expected';
  return ms <= COLD_HARD_MS ? 'optimize-later' : 'blocked';
}

// 责任：期待值和硬边界都含等号，超过期待仅提示，超过硬边界才阻塞。
test('6000-document cold scan uses inclusive expected and hard limits', () => {
  assert.deepEqual([59_999, 60_000, 60_000.001, 180_000, 180_000.001].map(coldScanTier),
    ['expected', 'expected', 'optimize-later', 'optimize-later', 'blocked']);
});

const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const round = value => Math.round(value * 100) / 100;
const p95 = values => round(quantile(values, 0.95));

// 分段职责：写入确定大小的合成正文，返回相对路径与字节数；每个文件内容唯一，避免索引按 hash 去重。
function writeCorpus(root, sections, perSection, tag) {
  const files = [];
  let bytes = 0;
  for (let s = 0; s < sections; s += 1) {
    const dirName = tag + '-sec-' + String(s).padStart(2, '0');
    fs.mkdirSync(path.join(root, dirName), { recursive: true });
    for (let f = 0; f < perSection; f += 1) {
      const rel = dirName + '/' + tag + '-doc-' + s + '-' + f + '.md';
      const body = '# ' + tag + ' ' + s + '/' + f + '\n\n' + ('合成工作区正文用于测量发现与索引成本，不代表真实文档。' + s + '/' + f + ' ').repeat(40) + '\n';
      fs.writeFileSync(path.join(root, rel), body);
      files.push(rel);
      bytes += Buffer.byteLength(body);
    }
  }
  return { files, bytes };
}

// 分段职责：写入被扫描策略排除的目录与文件，作为“大仓但不应读取”的负例。
function writeExcluded(root) {
  const seeded = [];
  for (const dir of ['node_modules/pkg', 'dist/assets', '.evidence/tmp', 'private', 'secrets']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (let i = 0; i < 80; i += 1) {
      const file = path.join(root, dir, 'excluded-' + i + '.md');
      fs.writeFileSync(file, '# excluded ' + dir + ' ' + i + '\n' + '不应进入发现范围。'.repeat(20) + '\n');
      seeded.push(file);
    }
  }
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=synthetic-not-a-credential\n');
  fs.writeFileSync(path.join(root, 'secrets', 'id_rsa'), 'synthetic key material\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
  fs.mkdirSync(path.join(root, 'ignored'));
  for (let i = 0; i < 40; i += 1) fs.writeFileSync(path.join(root, 'ignored', 'ignored-' + i + '.md'), '# gitignored ' + i + '\n');
  return seeded;
}

// 分段职责：写入普通非文本源码夹具；它们可被枚举但不得被当作正文读取或生成 entries。
function writeSource(root) {
  let files = 0;
  for (const [ext, count] of Object.entries(SOURCE)) {
    const dir = path.join(root, 'src', ext);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i += 1) {
      fs.writeFileSync(path.join(dir, 'module-' + i + '.' + ext), 'export const value' + i + ' = ' + i + ';\n');
      files += 1;
    }
  }
  return files;
}

// 分段职责：在测试进程内同步遍历并读取整棵树，仅用于得到“同步全树扫描会阻塞多久”的机器相关基线。
function syncTreeWalkMs(root) {
  const started = performance.now();
  let files = 0;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { fs.readFileSync(full); files += 1; }
    }
  };
  walk(root);
  return { ms: round(performance.now() - started), files };
}

// 分段职责：用 5ms 心跳记录事件循环最大间隙；同步全树扫描会把这个值抬到接近扫描耗时。
function gapMeter() {
  const state = { maxMs: 0, ticks: 0 };
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    state.maxMs = Math.max(state.maxMs, now - previous);
    previous = now;
    state.ticks += 1;
  }, 5);
  return { stop() { clearInterval(timer); return state; } };
}

// 分段职责：按契约消费 discover 分页并校验每页 counts 形状，累加计数与正文字节数。
async function discoverAll(svc, projectId) {
  const totals = { enumerated: 0, read: 0, reused: 0, indexed: 0, readBytes: 0, entries: 0, pages: 0 };
  let cursor = null;
  let partial = false;
  for (let pageNo = 0; pageNo < MAX_PAGES; pageNo += 1) {
    const page = await svc.queryWorkspaceProjection(projectId, cursor === null ? { op: 'discover' } : { op: 'discover', cursor });
    assert.ok(page && typeof page === 'object', 'discover must return a page object');
    assert.ok(Array.isArray(page.entries), 'discover page must expose entries[]');
    assert.ok(page.counts && typeof page.counts === 'object', 'discover page must expose counts');
    for (const field of ['enumerated', 'read', 'reused', 'indexed', 'readBytes']) {
      assert.equal(typeof page.counts[field], 'number', 'counts.' + field + ' must be a number');
      totals[field] += page.counts[field];
    }
    totals.entries += page.entries.length;
    totals.pages += 1;
    partial = page.partial === true;
    if (!page.nextCursor) return { ...totals, partial };
    assert.notEqual(page.nextCursor, cursor, 'discover cursor must advance');
    cursor = page.nextCursor;
  }
  throw new Error('discover did not terminate within ' + MAX_PAGES + ' pages');
}

// 分段职责：顺序执行真实 task.create 命令并返回毫秒样本；热身由调用方在扫描前统一完成。
async function runTaskCommands(handle, count, tag) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const started = performance.now();
    await handle.command(command('task.create', { title: 'p3 perf ' + tag + ' ' + i, acceptance: [{ text: 'Synthetic acceptance' }] }));
    samples.push(performance.now() - started);
  }
  return samples;
}

// 分段职责：从合成相对路径还原正文标题，供 read_current 用独立期望值复验正文。
function headingOf(rel) {
  const match = /main-doc-(\d+)-(\d+)\.md$/.exec(rel);
  return match ? '# main ' + match[1] + '/' + match[2] : rel;
}

// 分段职责：建立独立 owning space、项目与混合语料；spaceRoot 同时承载正文和该空间的 store。
async function makeSpace(t, base, name, shape, tag) {
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  const svc = new ProjectService({ spaceRoot: root });
  await svc.init();
  const h = await svc.createProject({ workspacePath: root, name: 'P3 ' + tag + ' performance' });
  const corpus = writeCorpus(root, shape.sections, shape.perSection, tag);
  const excluded = tag === 'main' ? writeExcluded(root) : [];
  const sources = tag === 'main' ? writeSource(root) : 0;
  return { root, svc, h, corpus, excluded, sources };
}

// 分段职责：扫描并累加分页计数；调用方已取得一页并保留续页游标时，任务命令与下一页请求真实并发。
async function scanWithCommands(svc, projectId, handle, tag) {
  const samples = [];
  const totals = { enumerated: 0, read: 0, reused: 0, indexed: 0, readBytes: 0, entries: 0, pages: 0 };
  let cursor = null;
  let overlap = 0;
  const startedAt = performance.now();
  for (;;) {
    const pagePromise = svc.queryWorkspaceProjection(projectId, cursor === null ? { op: 'discover' } : { op: 'discover', cursor });
    let settled = false;
    pagePromise.then(() => { settled = true; }, () => { settled = true; });
    // 第一页用于建立扫描；其余页在请求在途时执行任务，命令结束仍在途才算真实重叠。
    if (totals.pages > 0) {
      const cmdStarted = performance.now();
      await handle.command(command('task.create', { title: 'p3 perf ' + tag + '-' + totals.pages, acceptance: [{ text: 'Synthetic acceptance' }] }));
      samples.push(performance.now() - cmdStarted);
      if (!settled) overlap += 1;
    }
    const page = await pagePromise;
    for (const field of ['enumerated', 'read', 'reused', 'indexed', 'readBytes']) totals[field] += page.counts[field];
    totals.entries += page.entries.length;
    totals.pages += 1;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { ...totals, ms: round(performance.now() - startedAt), samples, overlap };
}

// 分段职责：单 space 冷/热/单改后，在续页在途时执行任务并与同命令数的 off 基线比较。
async function measureSingle(main) {
  await runTaskCommands(main.h, 5, 'warmup');
  const first = await scanWithCommands(main.svc, main.h.id, main.h, 'on-a');
  const second = await scanWithCommands(main.svc, main.h.id, main.h, 'on-b');
  const onSamples = [...first.samples, ...second.samples];
  const offSamples = await runTaskCommands(main.h, onSamples.length, 'off');
  const overlap = first.overlap + second.overlap;
  assert.equal(first.read, 0, 'first interleaved scan must stay hot');
  assert.equal(second.read, 0, 'second interleaved scan must stay hot');
  assert.equal(first.readBytes, 0, 'hot scan must not spend body bytes');
  assert.equal(second.readBytes, 0, 'hot scan must not spend body bytes');
  assert.ok(overlap >= 1, 'at least one task sample must complete while its continuation page is still in flight');
  return { onSamples, offSamples, first, second, overlap };
}

// 分段职责：两个独立 space 同时续页，任务命令与两个在途页请求并发，断言真实重叠。
async function measureConcurrent(main, second) {
  const samples = [];
  const totals = new Map();
  let overlap = 0;
  let cursorA = null;
  let cursorB = null;
  let pagesA = 0;
  let pagesB = 0;
  const startedAt = performance.now();
  for (;;) {
    const a = main.svc.queryWorkspaceProjection(main.h.id, cursorA === null ? { op: 'discover' } : { op: 'discover', cursor: cursorA });
    const b = second.svc.queryWorkspaceProjection(second.h.id, cursorB === null ? { op: 'discover' } : { op: 'discover', cursor: cursorB });
    let settledA = false;
    let settledB = false;
    a.then(() => { settledA = true; }, () => { settledA = true; });
    b.then(() => { settledB = true; }, () => { settledB = true; });
    if (pagesA > 0 || pagesB > 0) {
      const cmdStarted = performance.now();
      await main.h.command(command('task.create', { title: 'p3 perf multi-' + (pagesA + pagesB), acceptance: [{ text: 'Synthetic acceptance' }] }));
      samples.push(performance.now() - cmdStarted);
      if (!settledA || !settledB) overlap += 1;
    }
    const pageA = await a;
    const pageB = await b;
    for (const [key, page] of [['main', pageA], ['second', pageB]]) {
      const total = totals.get(key) || { enumerated: 0, read: 0, reused: 0, indexed: 0, readBytes: 0, entries: 0, pages: 0 };
      for (const field of ['enumerated', 'read', 'reused', 'indexed', 'readBytes']) total[field] += page.counts[field];
      total.entries += page.entries.length;
      total.pages += 1;
      totals.set(key, total);
    }
    pagesA += 1;
    pagesB += 1;
    cursorA = pageA.nextCursor;
    cursorB = pageB.nextCursor;
    if (!cursorA && !cursorB) break;
    if (!cursorA) { // A 已结束：继续消费 B 的续页，命令仍与 B 的在途页重叠。
      while (cursorB) {
        const page = await second.svc.queryWorkspaceProjection(second.h.id, { op: 'discover', cursor: cursorB });
        const total = totals.get('second');
        for (const field of ['enumerated', 'read', 'reused', 'indexed', 'readBytes']) total[field] += page.counts[field];
        total.entries += page.entries.length;
        total.pages += 1;
        cursorB = page.nextCursor;
      }
      break;
    }
    if (!cursorB) { // B 已结束：继续消费 A 的续页，命令仍与 A 的在途页重叠。
      while (cursorA) {
        const page = await main.svc.queryWorkspaceProjection(main.h.id, { op: 'discover', cursor: cursorA });
        const total = totals.get('main');
        for (const field of ['enumerated', 'read', 'reused', 'indexed', 'readBytes']) total[field] += page.counts[field];
        total.entries += page.entries.length;
        total.pages += 1;
        cursorA = page.nextCursor;
      }
      break;
    }
  }
  return { main: totals.get('main'), second: totals.get('second'), samples, overlap, ms: round(performance.now() - startedAt) };
}

// 责任：续页真实在途时任务命令不受扫描阻塞，冷/热/单改计数确定，双 space 并发也不拖累宿主。
test('P3 workspace projection keeps discovery bounded and off the task hot path', { timeout: 600000 }, async t => {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot, 'pb-p3-perf-')));
  assert.ok(containsPath(tempRoot, base) && !containsPath(repoRoot, base), 'performance fixtures must stay outside the repository');
  t.diagnostic('Synthetic fixture preserved: ' + base);
  const services = [];
  t.after(async () => {
    for (const svc of services.toReversed()) { try { await svc.close(); } catch {} }
  });
  const main = await makeSpace(t, base, 'main-space', MAIN, 'main');
  const second = await makeSpace(t, base, 'second-space', SECOND, 'second');
  services.push(main.svc, second.svc);
  const eligible = main.corpus.files.length;
  const secondEligible = second.corpus.files.length;

  // 责任：API 与夹具必须真实存在；主/第二空间各有独立 store，且都不在仓库内。
  assert.equal(typeof main.svc.queryWorkspaceProjection, 'function', 'P3 core must expose queryWorkspaceProjection');
  assert.equal(typeof second.svc.queryWorkspaceProjection, 'function', 'each owning space must expose queryWorkspaceProjection');
  assert.equal(main.svc.spaceHome?.root, main.root);
  assert.equal(second.svc.spaceHome?.root, second.root);
  for (const { root } of [main, second]) {
    assert.ok(containsPath(base, root) && !containsPath(repoRoot, root), 'space fixtures must remain in their temporary directory');
  }
  assert.equal(eligible, MAIN.sections * MAIN.perSection);
  assert.ok(main.corpus.bytes > 10 * 1024 * 1024);
  assert.ok(main.sources > 0 && main.excluded.length > 0);

  const sync = syncTreeWalkMs(main.root);
  const blockBudgetMs = Math.max(150, sync.ms * 0.5);
  const coldMeter = gapMeter();
  const coldStarted = performance.now();
  const cold = await discoverAll(main.svc, main.h.id);
  const elapsedCold = performance.now() - coldStarted;
  const coldMs = round(elapsedCold), tier = coldScanTier(elapsedCold);
  const coldGap = coldMeter.stop();
  t.diagnostic(JSON.stringify({ stage: 'cold', ms: coldMs, tier, expectedMs: COLD_EXPECTED_MS, hardMs: COLD_HARD_MS, maxGapMs: round(coldGap.maxMs), ...cold }));
  if (tier === 'optimize-later') t.diagnostic('Cold discovery above expectation but within hard limit: record for later optimization; not blocking.');
  assert.notEqual(tier, 'blocked', 'cold scan exceeded the hard limit of ' + COLD_HARD_MS + 'ms: ' + elapsedCold + 'ms');

  const hotStarted = performance.now();
  const hot = await discoverAll(main.svc, main.h.id);
  const hotMs = round(performance.now() - hotStarted);
  t.diagnostic(JSON.stringify({ stage: 'hot', ms: hotMs, ...hot }));

  // 三个互不干扰场景：冷扫 → 热扫 → 单改扫描；read_current 只验独立目标，不预热待测变更。
  const changedRel = main.corpus.files[Math.floor(eligible / 2)];
  fs.appendFileSync(path.join(main.root, changedRel), '\n' + PROBE + ' changed one\n');
  const changedStarted = performance.now();
  const changed = await discoverAll(main.svc, main.h.id);
  const changedMs = round(performance.now() - changedStarted);
  t.diagnostic(JSON.stringify({ stage: 'changedOne', ms: changedMs, ...changed }));

  const probeRel = main.corpus.files[Math.floor(eligible / 4)];
  const readStarted = performance.now();
  const current = await main.svc.queryWorkspaceProjection(main.h.id, { op: 'read_current', relPath: probeRel });
  const currentMs = round(performance.now() - readStarted);
  const currentHasBody = typeof current?.body === 'string' && current.body.includes(headingOf(probeRel));
  t.diagnostic(JSON.stringify({ stage: 'readCurrent', ms: currentMs, hasBody: currentHasBody, target: probeRel }));

  const refreshStarted = performance.now();
  const refreshed = await main.svc.queryWorkspaceProjection(main.h.id, { op: 'refresh_current', relPath: probeRel });
  const refreshMs = round(performance.now() - refreshStarted);

  const secondCold = await discoverAll(second.svc, second.h.id);
  const secondHot = await discoverAll(second.svc, second.h.id);
  const single = await measureSingle(main);
  const concurrentMeter = gapMeter();
  const concurrent = await measureConcurrent(main, second);
  const concurrentGap = concurrentMeter.stop();

  const report = {
    fixture: { eligible, bytes: main.corpus.bytes, sources: main.sources, excludedSeeded: main.excluded.length,
      secondEligible, syncWalkMs: sync.ms, blockBudgetMs: round(blockBudgetMs) },
    cold: { ...cold, ms: coldMs, maxGapMs: round(coldGap.maxMs) },
    hot: { ...hot, ms: hotMs },
    changedOne: { ...changed, ms: changedMs },
    readCurrent: { ms: currentMs, hasBody: currentHasBody },
    refreshCurrent: { ms: refreshMs, ok: refreshed !== null && typeof refreshed === 'object' },
    second: { cold: secondCold, hot: secondHot },
    commands: { offP50: round(quantile(single.offSamples, 0.5)), offP95: p95(single.offSamples),
      onP50: round(quantile(single.onSamples, 0.5)), onP95: p95(single.onSamples),
      samples: single.onSamples.length, overlap: single.overlap,
      onScans: [single.first.readBytes, single.second.readBytes] },
    multiWorkspace: { ...concurrent, commandP95: p95(concurrent.samples), samples: concurrent.samples.length, maxGapMs: round(concurrentGap.maxMs) },
    ratios: { hotOverCold: coldMs ? round(hotMs / coldMs) : null },
  };
  t.diagnostic(JSON.stringify(report));

  // 责任：冷扫描恰好读取每篇正文一次、零复用；普通源码可枚举但不得被读取或生成 entries。
  assert.ok(cold.enumerated >= eligible * 0.9, 'cold enumerated ' + cold.enumerated + ' of ' + eligible);
  assert.ok(cold.enumerated <= eligible * 1.1, 'cold enumerated ' + cold.enumerated + ' overshoots eligible ' + eligible);
  assert.equal(cold.read, eligible, 'cold scan must read every eligible body exactly once');
  assert.equal(cold.reused, 0, 'the first pass has no cached body to reuse');
  assert.equal(cold.entries, eligible, 'only supported bodies may produce entries');
  assert.ok(cold.readBytes >= main.corpus.bytes * 0.9, 'cold readBytes ' + cold.readBytes + ' must cover the corpus');
  assert.ok(cold.pages < MAX_PAGES, 'discovery must terminate by cursor');

  // 责任：热扫描零正文读取与零正文字节，全部复用；延迟只与冷扫相对比较。
  assert.equal(hot.read, 0, 'hot scan must reuse every unchanged body');
  assert.equal(hot.reused, eligible, 'hot scan must reuse the whole eligible set');
  assert.equal(hot.readBytes, 0, 'hot scan must not read body bytes');
  assert.ok(hotMs < coldMs, 'hot scan ' + hotMs + 'ms must stay below cold ' + coldMs + 'ms');
  assert.equal(secondCold.read, secondEligible, 'second space cold read must equal its corpus');
  assert.equal(secondHot.readBytes, 0, 'second space hot scan must not read body bytes');

  // 责任：只改一项后正文读取增量恰好为一，正文字节只覆盖该文件，其余继续复用。
  assert.equal(changed.read, 1, 'changing one file must read exactly one body');
  assert.equal(changed.reused, eligible - 1, 'every unchanged body must be reused after a single change');
  assert.ok(changed.readBytes > 0 && changed.readBytes < 64 * 1024, 'single change readBytes ' + changed.readBytes);
  assert.ok(currentHasBody, 'read_current must expose the independent target body');
  assert.ok(refreshed !== null && typeof refreshed === 'object', 'refresh_current must return a projection result');
  assert.ok(refreshMs < Math.max(500, coldMs), 'refresh ' + refreshMs + 'ms should stay below a cold pass ' + coldMs + 'ms');

  // 责任：任务命令与在途续页真实重叠时，p95 只允许加性噪声增量；两个 space 并发同样断言。
  const offP95 = report.commands.offP95;
  const onBudget = offP95 + Math.max(50, offP95 * 2);
  assert.ok(report.commands.onP95 <= onBudget, 'task p95 ' + report.commands.onP95 + 'ms exceeds ' + round(onBudget) + 'ms (off ' + offP95 + 'ms, +' + round(report.commands.onP95 - offP95) + 'ms)');
  assert.ok(single.overlap >= 1, 'single-space task samples must complete while a continuation page is in flight');
  assert.ok(concurrent.overlap >= 1, 'concurrent task samples must complete while a scan page is in flight');
  assert.ok(coldGap.maxMs < blockBudgetMs, 'cold event-loop gap ' + round(coldGap.maxMs) + 'ms vs budget ' + round(blockBudgetMs) + 'ms');
  assert.ok(concurrentGap.maxMs < blockBudgetMs, 'concurrent event-loop gap ' + round(concurrentGap.maxMs) + 'ms vs budget ' + round(blockBudgetMs) + 'ms');
  const multiBudget = offP95 + Math.max(75, offP95 * 3);
  const multiP95 = report.multiWorkspace.commandP95;
  assert.ok(Number.isFinite(multiP95) && multiP95 <= multiBudget, 'concurrent task p95 ' + multiP95 + 'ms exceeds ' + round(multiBudget) + 'ms (off ' + offP95 + 'ms, +' + round(multiP95 - offP95) + 'ms)');
  assert.equal(concurrent.main.readBytes, 0, 'concurrent main scan must not read bodies');
  assert.equal(concurrent.second.readBytes, 0, 'concurrent second scan must not read bodies');
  assert.ok(concurrent.main.enumerated >= eligible * 0.9);
  assert.ok(concurrent.second.enumerated >= secondEligible * 0.9);
  assert.ok(concurrent.ms < 60000, 'concurrent scans took ' + concurrent.ms + 'ms');
});

/**
 * 测试职责：通过实际空间服务和扫描 worker 验证根隔离、权限代和当前回读。
 * 典型流程：复制空间、外部改名与改写；在分页、撤权、恢复权限和策略变化时复验。
 * 覆盖边界：覆盖服务授权与无写副作用；不覆盖端点凭据注册与目录规则。
 * 外部前置：Node 与可写合成临时目录，不连接宿主或真实项目。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { BoardError } from '../../lib/core/errors.js';
import { EventEmitter } from 'node:events';
import { workspaceProjectionPool } from '../../lib/core/reader/projection-pool.js';
import { createProjectionHints } from '../../lib/core/reader/projection-hints.js';

// 分段职责：在同一项目信息的两个独立空间中使用真实服务，不以原根填补副本。
async function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'pb-p3-space-')));
  const a = path.join(base,'A'), b = path.join(base,'B'); fs.mkdirSync(a);
  const seed = new ProjectService({spaceRoot:a}); let id;
  try { await seed.init(); id = (await seed.createProject({workspacePath:a,actor:{kind:'human'}})).id; } finally { await seed.close(); }
  fs.cpSync(a,b,{recursive:true});
  let deny = [];
  const left = new ProjectService({spaceRoot:a,projectionDenyPrefixes:() => deny}), right = new ProjectService({spaceRoot:b});
  await Promise.all([left.init(),right.init()]);
  t.after(() => Promise.all([left.close(),right.close()]));
  const ask = (service,req,authority) => service.queryWorkspaceProjection(id,req,authority);
  return {a,b,ask,left,right,policy:rows => {deny=rows;}};
}
async function paths(service,ask) {
  const names = []; let cursor;
  do {
    const page = await ask(service,cursor ? {op:'discover',cursor} : {op:'discover'});
    names.push(...page.entries.map(e => e.relPath)); cursor = page.nextCursor;
    if (page.partial) assert.ok(cursor,'incomplete scan must have a reason and a continuation in this fixture');
  } while (cursor);
  return names.sort();
}

// 责任：相同项目与文件名/内容不能跨根解析；当前文件外部改名或变化无需登记；无历史补读。
test('same project copied to another owning space never aliases files or coverage',async t => {
  const {a,b,left,right,ask} = await fixture(t);
  fs.writeFileSync(path.join(a,'notes.md'),'same'); fs.writeFileSync(path.join(b,'notes.md'),'same');
  const ledger = root => fs.readFileSync(path.join(root,'.projectboard','state','commits.jsonl'));
  const original = ledger(b);
  assert.deepEqual(await paths(left,ask),['notes.md']); assert.deepEqual(await paths(right,ask),['notes.md']);
  fs.writeFileSync(path.join(a,'notes.md'),'left');
  fs.renameSync(path.join(b,'notes.md'),path.join(b,'renamed.md'));
  assert.deepEqual(await paths(left,ask),['notes.md']); assert.deepEqual(await paths(right,ask),['renamed.md']);
  await assert.rejects(ask(right,{op:'read_current',relPath:'notes.md'}),{code:'file-missing'});
  assert.equal((await ask(right,{op:'read_current',relPath:'renamed.md'})).body,'same');
  assert.equal((await ask(left,{op:'read_current',relPath:'notes.md'})).body,'left');
  assert.deepEqual(ledger(b),original); assert.deepEqual(ledger(a),original);
});

// 责任：权限过期既不能读本次结果，也不能在恢复后用旧游标继续；策略改变不返旧投影。
test('revocation and policy changes invalidate observation generations',async t => {
  const {a,left,ask,policy} = await fixture(t);
  const file = 'secret-note.md'; fs.writeFileSync(path.join(a,file),'confidential');
  for (let i=0; i<550; i++) fs.writeFileSync(path.join(a,`file-${i}.txt`),'sample');
  let allowed = true;
  const grant = {scopeKey:'fixture-grant',assertCurrent() { if (!allowed) throw new BoardError('project-forbidden','revoked',{status:403}); }};
  const first = await ask(left,{op:'discover'},grant); assert.ok(first.partial && first.nextCursor);
  allowed = false;
  await assert.rejects(ask(left,{op:'read_current',relPath:file},grant),{code:'project-forbidden'});
  allowed = true;
  await assert.rejects(ask(left,{op:'discover',cursor:first.nextCursor},grant),{code:'restart-required'});
  const second = await ask(left,{op:'discover'},grant); assert.ok(second.nextCursor);
  policy([file]);
  await assert.rejects(ask(left,{op:'discover',cursor:second.nextCursor},grant),{code:'restart-required'});
  await assert.rejects(ask(left,{op:'read_current',relPath:file},grant),{code:'policy-denied'});
  // The grant changes during the read, after dispatch but before publication.
  let checks = 0;
  const untilReturned = {scopeKey:'separate-grant',assertCurrent() { if (++checks === 3) throw new BoardError('project-forbidden','revoked',{status:403}); }};
  await assert.rejects(ask(left,{op:'read_current',relPath:'file-1.txt'},untilReturned),{code:'project-forbidden'});
});

// 责任：没有 Git 的普通目录也能后台预热，首个显式发现复用真实 worker 的结果而不重读。
test('authorized background hint warms a fresh unregistered document without Git or a writer',async t => {
  const {left,a,ask} = await fixture(t);
  fs.writeFileSync(path.join(a,'new.md'),'external document');
  const id = left.metas.keys().next().value;
  const done = Promise.withResolvers(); let checks = 0;
  const grant = {scopeKey:'background-owner',assertCurrent() { if (++checks === 3) done.resolve(); }};
  const deadline = setTimeout(() => done.reject(Error('bounded warmup did not finish')),10_000);
  try {
    left.hintWorkspaceProjection(id,grant);
    await done.promise;
    const page = await ask(left,{op:'discover'},grant);
    assert.equal(page.git,'not-required'); assert.equal(page.counts.read,0); assert.equal(page.counts.reused,1);
    assert.equal(page.entries[0].relPath,'new.md'); assert.equal(page.entries[0].bodyVerified,false);
    assert.equal(fs.existsSync(path.join(a,'.projectboard','state','lock.json')),false);
  } finally { clearTimeout(deadline); }
});

// 责任：底层读线程退出迟迟不返回时，关闭服务仍释放已打开的 writer，不为前一空间另开扫描线程。
test('slow read termination cannot retain a service writer lock', {timeout:4000}, async t => {
  const {left,a,ask} = await fixture(t);
  const id = left.metas.keys().next().value; await left.open(id);
  const lock = path.join(a,'.projectboard','state','lock.json'); assert.ok(fs.existsSync(lock));
  const started = Promise.withResolvers(), terminated = Promise.withResolvers(); let created = 0;
  t.mock.method(workspaceProjectionPool,'makeWorker',() => {
    created++;
    return Object.assign(new EventEmitter(),{ref(){},unref(){},postMessage(){started.resolve();},terminate:() => terminated.promise});
  });
  try {
    const rejected = assert.rejects(ask(left,{op:'discover'})); await started.promise;
    await left.close(); await rejected;
    assert.equal(fs.existsSync(lock),false); assert.equal(created,1);
  } finally { terminated.resolve(); }
});

// 责任：真实扫描的旧游标被淘汰时，无监听的后台任务也能在同一权限下重新发现后来新增的文件。
test('compensation restarts an invalid cursor and finds a new file without a watcher', async t => {
  const {left,a,ask} = await fixture(t);
  for (let i=0;i<525;i++) fs.writeFileSync(path.join(a,`skip-${i}.js`),'');
  const ticks = [], seen = new Set(), generations = new Set();
  const scheduler = createProjectionHints({watchRoot:() => {throw Error('unavailable');},timer:cb => {ticks.push(cb); return {unref(){return this;}};}});
  const run = cursor => ask(left,cursor ? {op:'discover',cursor} : {op:'discover'});
  scheduler.hint({owner:'owner',key:'test',root:a,check:()=>{},scan:async cursor => {
    const page = await run(cursor); generations.add(page.scanGeneration); for (const e of page.entries) seen.add(e.relPath); return page;
  }});
  try {
    await ticks.shift()(); assert.equal(generations.size,1);
    for (let i=0;i<4;i++) assert.ok((await run()).nextCursor);
    fs.writeFileSync(path.join(a,'new.md'),'external');
    for (let i=0;i<30 && !seen.has('new.md');i++) {assert.equal(ticks.length,1); await ticks.shift()();}
    assert.ok(seen.has('new.md')); assert.ok(generations.size > 1); assert.equal(scheduler.status('test'),'unavailable');
  } finally { scheduler.close('owner'); }
});

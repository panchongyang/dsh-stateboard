/**
 * 测试职责：确保 store 门禁验证完整日志、准确诊断拒绝并保护源数据和基准。
 * 典型流程：合成项目与快照 → 隔离 CLI 回放和只读诊断 → 核对分类、退出码和源字节。
 * 覆盖边界：覆盖 事件兼容、源哈希、基线模式和副本链接拒绝；不覆盖真实用户 store。
 * 外部前置：无；CLI 明确指向临时 projects 和 baseline。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareReports, hashStore, hashTree, invariantProblems, isDataFile, sameHashes } from '../../scripts/stores-replay.mjs';
import { ProjectService } from '../../lib/core/service.js';
import { makeCommit, replay } from '../../lib/core/store/format.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts', 'stores-replay.mjs');
const salvage = path.join(root, 'scripts', 'salvage-log.mjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-stores-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = path.join(dir, 'projects');
  const id = 'prj_fixture';
  const projectDir = path.join(projects, id);
  fs.mkdirSync(projectDir, { recursive: true });
  const project = { id, name: 'synthetic', phase: 'active', workspacePath: dir, rev: 0, schemaVersion: 3 };
  const meta = { projectId: id, project, schemaVersion: 3 };
  fs.writeFileSync(path.join(projectDir, 'meta.json'), JSON.stringify(meta));
  const first = makeCommit(1, 'genesis', { kind: 'system' }, 'cmd_fixture', 0, [{ type: 'project/created', data: project }]);
  const log = path.join(projectDir, 'commits.jsonl');
  const baseline = path.join(dir, 'baseline.json');
  return { dir, projects, id, projectDir, log, baseline,
    commit(type, { snapshot = false } = {}) {
      const next = makeCommit(2, first.hash, { kind: 'system' }, 'cmd_event', 1, [{ type, data: {} }]);
      fs.writeFileSync(log, [first, next].map((commit) => JSON.stringify(commit)).join('\n'));
      if (snapshot) {
        const { state } = replay(meta, [first]);
        state.lastSeq = next.seq;
        state.lastHash = next.hash;
        fs.writeFileSync(path.join(projectDir, 'snapshot.json'), JSON.stringify({ seq: next.seq, hash: next.hash, state }));
      }
    },
    run(args, flags = []) {
      return spawnSync(process.execPath, [...flags, script, '--root', projects, '--baseline', baseline, ...args], { encoding: 'utf8' });
    },
  };
}

function registerMigration(dir, type) {
  const events = pathToFileURL(path.join(root, 'lib', 'shared', 'events.js')).href;
  const original = JSON.stringify(events + '?original');
  const asModule = (code) => 'data:text/javascript,' + encodeURIComponent(code);
  const replacement = asModule(`
    import * as original from ${original};
    export const EVENT_REGISTRY = { ...original.EVENT_REGISTRY, [${JSON.stringify(type)}]: 'migration' };
    export const eventClass = (type, registry = EVENT_REGISTRY) => original.eventClass(type, registry);
  `);
  const loader = asModule(`
    export async function resolve(specifier, context, nextResolve) {
      const found = await nextResolve(specifier, context);
      return found.url === ${JSON.stringify(events)} ? { url: ${JSON.stringify(replacement)}, shortCircuit: true } : found;
    }
  `);
  const entry = path.join(dir, 'register-migration.mjs');
  fs.writeFileSync(entry, "import { register } from 'node:module'; register(" + JSON.stringify(loader) + ");");
  return ['--import', pathToFileURL(entry).href];
}

// 责任：meta/commits/blob 须计入数据哈希，锁、心跳和快照必须排除。
test('only data files are hashed; locks, heartbeats and snapshots are operational', () => {
  assert.equal(isDataFile('meta.json'), true);
  assert.equal(isDataFile('commits.jsonl'), true);
  assert.equal(isDataFile('blobs/ab/cdef'), true);
  assert.equal(isDataFile('lock.json'), false);
  assert.equal(isDataFile('lock.json.hb.1234'), false);
  assert.equal(isDataFile('lock.json.claim/owner.json'), false);
  assert.equal(isDataFile('snapshot.json'), false);
});

// 责任：报告比较须点名具体项目和漂移字段，也须识别新增项目。
test('compareReports names the project and the field that drifted', () => {
  const expected = { projects: { a: { tasks: 1, docs: 0, review: 0, plans: 0, warnings: 0 } } };
  const actual = {
    a: { tasks: 2, docs: 0, review: 0, plans: 0, warnings: 0 },
    b: { tasks: 0, docs: 0, review: 0, plans: 0, warnings: 0 },
  };
  const problems = compareReports(expected, actual);
  assert.equal(problems.some((line) => line.startsWith('a: tasks 1 -> 2')), true);
  assert.equal(problems.some((line) => line.startsWith('b: new project')), true);
});

// 责任：日志创建实体数与重放投影数量不符时必须报不变量错误。
test('log-derived invariants catch entities the replay dropped', () => {
  assert.deepEqual(invariantProblems('p', { tasks: 2, taskCreated: 1, docs: 0, docCreated: 0 }), [
    'p: tasks=2 but task/created=1',
  ]);
  assert.deepEqual(invariantProblems('p', { tasks: 1, taskCreated: 1, docs: 1, docCreated: 1 }), []);
});

// 责任：改变 lock/heartbeat 不算数据漂移，改变 meta 字节才须哈希不一致。
test('lock/heartbeat churn is not data drift', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-stores-hash-'));
  try {
    fs.writeFileSync(path.join(dir, 'meta.json'), '{}');
    fs.writeFileSync(path.join(dir, 'lock.json'), 'live');
    const first = hashTree(dir);
    assert.deepEqual(Object.keys(first), ['meta.json']);
    fs.writeFileSync(path.join(dir, 'lock.json'), 'changed');
    assert.equal(sameHashes(first, hashTree(dir)).same, true);
    fs.writeFileSync(path.join(dir, 'meta.json'), '{"a":1}');
    assert.equal(sameHashes(first, hashTree(dir)).same, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 责任：CLI update 须写合成 baseline，普通运行发现基线漂移须失败，gate 模式只检不变量。
test('CLI: --update writes the baseline, plain runs compare, --gate ignores it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-stores-cli-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-stores-ws-'));
  try {
    const svc = new ProjectService({ rootDir: tmp });
    await svc.init();
    const handle = await svc.createProject({ workspacePath: ws, name: 'compat' });
    await handle.close();
    await svc.close();

    const projects = path.join(tmp, 'projects');
    const baseline = path.join(tmp, 'baseline.json');
    const run = (args) => spawnSync(process.execPath, [script, '--root', projects, '--baseline', baseline, ...args], { encoding: 'utf8' });

    const updated = run(['--update']);
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.equal(fs.existsSync(baseline), true, 'baseline written');

    const compared = run([]);
    assert.equal(compared.status, 0, compared.stdout + compared.stderr);

    const data = JSON.parse(fs.readFileSync(baseline, 'utf8'));
    const id = Object.keys(data.projects)[0];
    data.projects[id].tasks += 1;
    fs.writeFileSync(baseline, JSON.stringify(data, null, 2) + '\n');
    const failed = run([]);
    assert.equal(failed.status, 1, 'baseline drift must fail');
    assert.match(failed.stderr, new RegExp(id + ': tasks'));

    const gate = run(['--gate']);
    assert.equal(gate.status, 0, 'gate mode checks replay, not the baseline');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// 责任：快照覆盖的 applied/additive 均计入，复制回放可修副本缺 LF，源日志不变。
test('store gate reports coverage for events before a snapshot without writing the source', (t) => {
  const f = fixture(t);
  f.commit('task/meta-edited', { snapshot: true });
  const before = hashStore(f.projects);
  assert.deepEqual(Object.keys(before).sort(), [f.id + '/commits.jsonl', f.id + '/meta.json']);
  const result = f.run(['--gate']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /prj_fixture .*warnings=0 applied=1 additive=1/);
  assert.deepEqual(hashStore(f.projects), before);
  assert.equal(fs.existsSync(path.join(f.projectDir, 'lock.json')), false);
  fs.appendFileSync(f.log, '\n');
  assert.deepEqual(sameHashes(before, hashStore(f.projects)), { same: false, changed: [f.id + '/commits.jsonl'] });
});

// 责任：排除副本恢复新增的事件，源锁认领不影响回放，也不能被清除。
test('coverage reflects source commits even when the copy recovers a lease', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-stores-recover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = path.join(dir, 'projects');
  const svc = new ProjectService({ rootDir: dir });
  await svc.init();
  const handle = await svc.createProject({ workspacePath: dir, name: 'synthetic recovery' });
  const id = handle.id;
  const actor = { kind: 'agent', sessionId: 'synthetic-session' };
  const created = await handle.command({
    op: 'task.create', cmdId: 'cmd_create', actor, title: 'Work', acceptance: [{ text: 'done' }],
  });
  const taskId = created.events[0].taskId;
  await handle.command({ op: 'task.claim', cmdId: 'cmd_claim', taskId, actor, expected: { entityRev: 1 } });
  await svc.close();
  const claim = path.join(projects, id, 'lock.json.claim');
  fs.mkdirSync(claim);
  const owner = path.join(claim, 'owner.json');
  const ownerBytes = JSON.stringify({ hostname: 'offline-synthetic-source', pid: 123, at: Date.now() });
  fs.writeFileSync(owner, ownerBytes);
  const before = hashStore(projects);
  const result = spawnSync(process.execPath, [script, '--root', projects, '--gate', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { report } = JSON.parse(result.stdout.split('\nPASS ')[0]);
  assert.deepEqual(report[id].events, { applied: 4, additive: 0 });
  assert.equal(report[id].warnings, 0, 'the temporary writer recovered the stale lease');
  assert.equal(fs.readFileSync(owner, 'utf8'), ownerBytes);
  assert.deepEqual(hashStore(projects), before);
});

for (const [label, type, classification] of [
  ['unknown event', 'task/future', 'refuse'],
  ['malformed event', { toString: 'invalid' }, 'refuse'],
  ['migration event', 'task/requires-migration', 'migration'],
]) {
  // 责任：未知、损坏类型或需迁移事件在快照覆盖时也拒绝，门禁和只读诊断定位一致。
  test(label + ' refuses the store gate and read-only prefix at the same commit', (t) => {
    const f = fixture(t);
    f.commit(type, { snapshot: true });
    const flags = classification === 'migration' ? registerMigration(f.dir, type) : [];
    const before = hashStore(f.projects);
    fs.writeFileSync(f.baseline, 'unchanged baseline');
    const failed = f.run(['--update', '--json'], flags);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.notEqual(failed.stdout, '', failed.stderr);
    assert.doesNotMatch(failed.stdout, /PASS|baseline updated/);
    const report = JSON.parse(failed.stdout);
    assert.deepEqual(report.report, {});
    const prefix = spawnSync(process.execPath, [...flags, salvage, '--root', f.dir, '--project', f.id, '--view', 'events'], { encoding: 'utf8' });
    assert.equal(prefix.status, 2, prefix.stdout + prefix.stderr);
    const { diagnostic, validSeq } = JSON.parse(prefix.stdout);
    assert.equal(validSeq, 1);
    assert.equal(diagnostic.projectId, f.id);
    assert.equal(diagnostic.type, typeof type === 'string' ? type : '<invalid>');
    assert.equal(diagnostic.seq, 2);
    assert.equal(diagnostic.reason, 'unknown-event');
    assert.equal(diagnostic.compatibility, classification);
    assert.equal(report.problems[0], f.id + ': open failed: incompatible-event: '
      + diagnostic.message.replace(/ at line 2$/, '') + ' — ' + diagnostic.hint);
    assert.equal(fs.readFileSync(f.baseline, 'utf8'), 'unchanged baseline');
    assert.deepEqual(hashStore(f.projects), before);
  });
}

// 责任：显式根、项目登记或日志缺失时不能给出零覆盖 PASS。
test('explicit gate rejects absent or unvalidated samples', (t) => {
  const f = fixture(t);
  const noLog = f.run(['--gate']);
  assert.equal(noLog.status, 1, noLog.stdout + noLog.stderr);
  assert.match(noLog.stderr, /prj_fixture: no log commits to validate/);
  const missingMeta = path.join(f.projects, 'prj_missing_meta');
  fs.mkdirSync(missingMeta);
  const invalid = f.run(['--gate']);
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /prj_missing_meta: missing or invalid project metadata/);
  const empty = path.join(f.dir, 'empty');
  fs.mkdirSync(empty);
  for (const candidate of [empty, path.join(f.dir, 'absent')]) {
    const result = f.run(['--gate', '--root', candidate]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /PASS|SKIP/);
  }
  const malformed = f.run(['--gate', '--root=']);
  assert.equal(malformed.status, 1, malformed.stdout + malformed.stderr);
  assert.match(malformed.stderr, /--root requires a path/);
});

// 责任：合法的空事件提交不能冒充已覆盖事件的源日志。
test('explicit gate rejects a valid log with zero source events', (t) => {
  const f = fixture(t);
  const empty = makeCommit(1, 'genesis', { kind: 'system' }, 'cmd_empty', 0, []);
  fs.writeFileSync(f.log, JSON.stringify(empty) + '\n');
  const before = hashStore(f.projects);
  const result = f.run(['--gate']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /prj_fixture: no source events to validate/);
  assert.doesNotMatch(result.stdout, /PASS|SKIP/);
  assert.deepEqual(hashStore(f.projects), before);
});

// 责任：复制目录链接不得被当作项目打开；基准路径不得经链接写回源日志。
test('gate refuses a linked project and baseline updates into the source store', (t) => {
  const f = fixture(t);
  f.commit('task/meta-edited');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  const alias = path.join(f.dir, 'alias');
  fs.symlinkSync(f.projectDir, alias, type);
  const before = hashStore(f.projects);
  const baseline = f.run(['--update', '--baseline', path.join(alias, 'commits.jsonl')]);
  assert.equal(baseline.status, 1, baseline.stdout + baseline.stderr);
  assert.match(baseline.stderr, /baseline must be outside the source store root/);
  assert.deepEqual(hashStore(f.projects), before);
  fs.writeFileSync(path.join(f.projectDir, 'lock.json'), 'source lock');
  fs.symlinkSync(f.projectDir, path.join(f.projects, 'prj_alias'), type);
  const linked = f.run(['--gate']);
  assert.equal(linked.status, 1, linked.stdout + linked.stderr);
  assert.match(linked.stderr, /store link refused: prj_alias/);
  assert.equal(fs.readFileSync(path.join(f.projectDir, 'lock.json'), 'utf8'), 'source lock');
  assert.deepEqual(hashStore(f.projects), before);
});

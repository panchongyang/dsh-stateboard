/**
 * 测试职责：保证损坏日志的只读有效前缀显式标非当前，修复必须备份并人工确认数据丢失。
 * 典型流程：隔离合成坏链 → 普通 open/只读 CLI → 显式 prefix repair → 冷开并继续业务写入。
 * 覆盖边界：覆盖 格式/链/未知事件拒绝、修复授权与后缀校验；不覆盖真实用户 store 或自动丢弃数据。
 * 外部前置：必须由 salvage launcher 隔离运行；需要 Node permission 保证只读 CLI，不能跳过沙箱。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertIsolation } from '../helpers/fault-isolation.mjs';
import { JsonlStore, makeCommit } from '../../lib/core/store.js';
import { ProjectService } from '../../lib/core/service.js';
import { nodePermissionFlag } from '../../scripts/guards.mjs';

assertIsolation();
const repo = path.resolve(import.meta.dirname, '../..');
const actor = { kind: 'human' };
const cmd = (op, extra = {}) => ({ op, actor, cmdId: 'cmd_' + crypto.randomUUID(), ...extra });

function tree(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    out[name] = stat.isDirectory() ? tree(file) : { bytes: fs.readFileSync(file).toString('hex'), mtime: stat.mtimeMs };
  }
  return out;
}

function cli(script, args, { readOnly = false } = {}) {
  const flags = readOnly ? [nodePermissionFlag(), '--allow-fs-read=*'] : [];
  const result = spawnSync(process.execPath, [...flags, path.join(repo, 'scripts', script + '.mjs'), ...args], {
    cwd: repo, env: process.env, encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(result.error);
  return result;
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-store-'));
  const ws = path.join(root, 'workspace');
  fs.mkdirSync(ws);
  const svc = new ProjectService({ rootDir: path.join(root, 'data') });
  await svc.init();
  const h = await svc.createProject({ workspacePath: ws, name: 'Synthetic prefix' });
  await h.command(cmd('task.create', { title: 'Kept task', acceptance: [{ text: 'fixture only' }] }));
  await h.command(cmd('project.update', { name: 'Lost suffix name' }));
  await h.command(cmd('task.create', { title: 'Lost suffix task', acceptance: [{ text: 'fixture only' }] }));
  h.store.saveSnapshot();
  const dir = h.meta.dir;
  const meta = h.meta;
  const file = path.join(dir, 'commits.jsonl');
  const commits = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(JSON.parse);
  await svc.close();
  return { root, data: path.join(root, 'data'), dir, meta, file, commits, id: h.id };
}

function args(f) { return ['--root', f.data, '--project', f.id]; }
function write(f, commits) { fs.writeFileSync(f.file, commits.map((c) => typeof c === 'string' ? c : JSON.stringify(c)).join('\n') + '\n'); }

function rejectedOpen(f, expected) {
  for (const lock of [false, true]) {
    const before = fs.readFileSync(f.file);
    const store = new JsonlStore(f.dir, f.meta, { lock });
    assert.throws(() => store.open(), (error) => {
      assert.equal(error.code, expected.code || 'hash-chain-broken');
      assert.equal(error.status, expected.code === 'unsupported-version' ? 409 : 503);
      assert.deepEqual(error.details, { ...error.details, validSeq: 2, validHash: f.commits[1].hash, line: 4, reason: expected.reason });
      return true;
    });
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(fs.readdirSync(f.dir).some((name) => /\.tmp-|^lock\.json/.test(name)), false);
  }
}

for (const variant of ['invalid-json', 'hash-mismatch', 'seq-mismatch', 'prev-mismatch', 'unsupported-version']) {
  // 责任：坏 JSON/hash/seq/prev/版本必须在物理行处拒绝，普通打开或旧 repair 不得改源树。
  test('default writable/readonly open rejects ' + variant + ' at physical line before normalization', async () => {
    const f = await fixture();
    const bad = structuredClone(f.commits[2]);
    if (variant === 'hash-mismatch') bad.hash = 'sha256:bad';
    if (variant === 'seq-mismatch') bad.seq = 30;
    if (variant === 'prev-mismatch') bad.prev = 'wrong';
    if (variant === 'unsupported-version') bad.v = 99;
    write(f, [f.commits[0], '', f.commits[1], variant === 'invalid-json' ? '{bad json}' : bad, '{later bad json}']);
    rejectedOpen(f, { reason: variant, code: variant === 'unsupported-version' ? variant : undefined });
    const before = tree(f.root);
    const result = cli('repair-log', [...args(f), '--apply']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(tree(f.root), before, 'legacy repair refuses without side effects');
    if (variant === 'unsupported-version') {
      assert.equal(cli('repair-log', [...args(f), '--truncate-to-valid-prefix', '--apply', '--confirm-data-loss', f.commits[1].hash]).status, 1);
      assert.deepEqual(tree(f.root), before);
    }
  });
}

// 责任：只读前缀查询须标非当前且零写，显式确认并备份后修复才能冷开继续创建任务。
test('end to end: reject -> read-only prefix views -> backup/explicit repair -> fresh open and business write', async () => {
  const f = await fixture();
  write(f, [f.commits[0], '', f.commits[1], '{bad json}', f.commits[3]]);
  rejectedOpen(f, { reason: 'invalid-json' });
  const original = fs.readFileSync(f.file);
  const before = tree(f.root);
  for (const view of ['board', 'health', 'events']) {
    const result = cli('salvage-log', [...args(f), '--view', view], { readOnly: true });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.current, false);
    assert.equal(out.readOnly, true);
    assert.match(out.warning, /只读前缀，非当前状态/);
    assert.equal(out.validSeq, 2);
    assert.equal(out.validHash, f.commits[1].hash);
    assert.equal(out.diagnostic.line, 4);
    if (view === 'board') {
      assert.equal(out.result.counts.total, 1);
      assert.equal(out.result.project.name, 'Synthetic prefix');
    }
    if (view === 'health') assert.equal(out.result.ok, true);
    if (view === 'events') assert.equal(out.result.rev, 2);
    assert.deepEqual(tree(f.root), before, 'salvage denied all fs writes by Node permission model');
  }
  const repair = [...args(f), '--truncate-to-valid-prefix'];
  const dry = cli('repair-log', repair, { readOnly: true });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DATA LOSS: discard physical lines 4\.\.5/);
  assert.match(dry.stdout, /RPO: validSeq=2/);
  assert.deepEqual(tree(f.root), before);
  assert.equal(cli('repair-log', [...repair, '--apply']).status, 1);
  assert.deepEqual(tree(f.root), before, 'no confirmation means zero writes');
  for (const name of ['lock.json', 'lock.json.claim']) {
    const file = path.join(f.dir, name);
    if (name.endsWith('claim')) fs.mkdirSync(file); else fs.writeFileSync(file, '{"pid":0}');
    const locked = tree(f.root);
    assert.equal(cli('repair-log', [...repair, '--apply', '--confirm-data-loss', f.commits[1].hash]).status, 1);
    assert.deepEqual(tree(f.root), locked, 'even stale lock/claim is never removed');
    if (name.endsWith('claim')) fs.rmdirSync(file); else fs.unlinkSync(file);
  }
  const apply = cli('repair-log', [...repair, '--apply', '--confirm-data-loss', f.commits[1].hash]);
  assert.equal(apply.status, 0, apply.stderr);
  const backups = fs.readdirSync(f.dir).filter((name) => name.startsWith('commits.jsonl.bak-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, backups[0])), original);
  const fresh = new ProjectService({ rootDir: f.data });
  await fresh.init();
  const h = await fresh.open(f.id);
  assert.equal(h.rev, 2);
  assert.equal(h.query('board').counts.total, 1);
  const written = await h.command(cmd('task.create', { title: 'After repair', acceptance: [{ text: 'business continues' }] }));
  assert.equal(written.committed, true);
  assert.equal(h.rev, 3);
  assert.equal(h.query('board').counts.total, 2);
  await fresh.close();
  console.log('E2E PASS: default rejected; all 3 salvage views permission-denied writes; backup exact; repair applied; fresh business command committed');
});

// 责任：未知事件须阻断整个提交，后缀含未知/版本事件时即使前面坏 JSON 也不得强制裁切。
test('unknown event stops before its entire commit; prefix repair refuses even when unknown/version follows bad JSON', async () => {
  for (const version of [false, true]) {
    const f = await fixture();
    const event = { type: 'future/unknown', data: {} };
    const bad = makeCommit(3, f.commits[1].hash, actor, 'future', 2, [event]);
    if (version) bad.v = 99;
    write(f, [...f.commits.slice(0, 2), bad]);
    const before = tree(f.root);
    const out = cli('salvage-log', [...args(f), '--view', 'events'], { readOnly: true });
    assert.equal(out.status, 2, out.stderr);
    assert.equal(JSON.parse(out.stdout).validSeq, 2);
    assert.equal(JSON.parse(out.stdout).diagnostic.reason, version ? 'unsupported-version' : 'unknown-event');
    for (const apply of [[], ['--apply', '--confirm-data-loss', f.commits[1].hash]]) {
      assert.equal(cli('repair-log', [...args(f), '--truncate-to-valid-prefix', ...apply]).status, 1);
      assert.deepEqual(tree(f.root), before);
    }
    write(f, [...f.commits.slice(0, 2), '{bad}', bad]);
    const suffixBefore = tree(f.root);
    assert.equal(cli('repair-log', [...args(f), '--truncate-to-valid-prefix', '--apply', '--confirm-data-loss', f.commits[1].hash]).status, 1);
    assert.deepEqual(tree(f.root), suffixBefore);
  }
});

// 责任：修复预检须先校验提交/事件并扫描被丢后缀，只有纯 seq 分叉仍可按规则修复。
test('repair preflight refuses invalid commit/events before seq and throughout discarded suffix; seq-only stays repairable', async () => {
  const cases = [
    { reason: 'invalid-events', build: (f) => makeCommit(99, f.commits[1].hash, actor, 'invalid-events', 2, {}) },
    { reason: 'invalid-commit', build: () => null },
    { reason: 'invalid-events', build: (f) => makeCommit(99, f.commits[1].hash, actor, 'invalid-event', 2, [null]) },
  ];
  for (const item of cases) {
    for (const preceding of ['none', 'invalid-json', 'hash-mismatch']) {
      const f = await fixture();
      const lead = preceding === 'none' ? [] : preceding === 'invalid-json' ? ['{bad json}'] : [{ ...f.commits[2], hash: 'sha256:bad' }];
      write(f, [...f.commits.slice(0, 2), ...lead, item.build(f)]);
      const before = tree(f.root);
      const base = [...args(f), '--truncate-to-valid-prefix'];
      for (const apply of [[], ['--apply', '--confirm-data-loss', f.commits[1].hash]]) {
        const result = cli('repair-log', [...base, ...apply]);
        assert.equal(result.status, 1, item.reason + '/' + preceding + ': ' + result.stdout + result.stderr);
        assert.equal(JSON.parse(result.stderr).error.details.reason, item.reason);
        assert.deepEqual(tree(f.root), before, 'structural refusal must not write log, backup, lock, snapshot or meta');
      }
    }
  }
  const f = await fixture();
  write(f, [...f.commits.slice(0, 2), makeCommit(99, f.commits[1].hash, actor, 'seq-only', 2, [{ type: 'session/checkpoint', data: { note: 'known structure' } }])]);
  const before = tree(f.root);
  const base = [...args(f), '--truncate-to-valid-prefix'];
  assert.equal(cli('repair-log', base, { readOnly: true }).status, 0);
  assert.deepEqual(tree(f.root), before);
  assert.equal(cli('repair-log', [...base, '--apply', '--confirm-data-loss', f.commits[1].hash]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8').trim().split('\n').at(-1)).seq, 2);
});

// 责任：抢救必须显式指定路径，完整但无 LF 的末提交须保留在只读有效前缀。
test('explicit paths required; valid complete no-LF record stays in readonly prefix', async () => {
  const f = await fixture();
  fs.writeFileSync(f.file, f.commits.slice(0, 2).map(JSON.stringify).join('\n'));
  const before = tree(f.root);
  const out = cli('salvage-log', [...args(f), '--view', 'board'], { readOnly: true });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).validSeq, 2);
  assert.deepEqual(tree(f.root), before);
  assert.equal(cli('salvage-log', ['--project', f.id, '--view', 'board']).status, 1);
  assert.equal(cli('repair-log', ['--project', f.id]).status, 1);
});

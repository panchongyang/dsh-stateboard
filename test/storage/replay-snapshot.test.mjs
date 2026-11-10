/**
 * 测试职责：兼容缺 planHeads/currentPlans 的旧快照，使后续计划事件仍可正确重放。
 * 典型流程：发布计划及草案 → 写入剥去新索引的旧快照 → 冷开 → 检查版本和尾部草案 head。
 * 覆盖边界：覆盖 旧快照规范化与尾部计划事件；不覆盖损坏快照或所有旧 schema 迁移。
 * 外部前置：无；临时磁盘 fixture。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { applyEvent, emptyState } from '../../lib/core/model.js';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function readCommits(dir) {
  return fs.readFileSync(path.join(dir, 'commits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function stateThrough(commits, meta, seq) {
  const state = emptyState(meta.project);
  for (const commit of commits.slice(0, seq)) {
    for (const event of commit.events) applyEvent(state, event, commit);
    state.lastSeq = commit.seq;
    state.lastHash = commit.hash;
    state.project.rev = commit.seq;
  }
  return state;
}

// 责任：从无 planHeads 的 seq=2 快照冷开须重放尾部 plan/created，得到 rev=3 和草案 head。
test('replay from a pre-planHeads snapshot does not throw on plan events', async () => {
  const stateDir = tmp('pb-snap-state');
  const ws = tmp('pb-snap-ws');
  const svc = new ProjectService({ rootDir: stateDir });
  await svc.init();
  const handle = await svc.createProject({ workspacePath: ws, name: 'Snap' });
  const dir = handle.meta.dir;
  const meta = { ...handle.meta };
  const cmd = (op, extra = {}) => ({ cmdId: 'cmd_' + Math.random().toString(36).slice(2), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra });
  await handle.command(cmd('plan.publish', { title: 'Published', goal: 'g', steps: [{ id: 's', title: 'S', tasks: [{ key: 'a', title: 'A', acceptance: [{ text: 'x' }] }] }] }));
  const draft = await handle.command(cmd('plan.create', { title: 'Draft', goal: 'g' }));
  await svc.close();

  const commits = readCommits(dir);
  assert.equal(commits.length, 3, 'create + publish + draft');
  // Simulate the snapshot an older build wrote: no planHeads, no currentPlans.
  const legacy = stateThrough(commits, meta, 2);
  delete legacy.planHeads;
  delete legacy.currentPlans;
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ v: 1, seq: 2, hash: commits[1].hash, state: legacy }));

  const reopened = new ProjectService({ rootDir: stateDir });
  await reopened.init();
  const again = await reopened.open(handle.id);
  const draftId = commits[2].events.find((event) => event.type === 'plan/created').data.id;
  assert.equal(again.rev, 3);
  assert.ok(again.state.planHeads, 'planHeads must exist after replay');
  assert.ok(again.state.planHeads[draftId], 'the tail plan/created event must be replayed into planHeads');
  assert.ok(draftId.length > 0);
  await reopened.close();
});

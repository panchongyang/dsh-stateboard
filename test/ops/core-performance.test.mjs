/**
 * 测试职责：约束大看板摘要体积及项目枚举的零 handle/锁预算。
 * 典型流程：构造合成临时项目或状态 → 执行领域操作 → 比较原始断言与副作用。
 * 覆盖边界：覆盖 两千任务 brief 和项目枚举结构性性能；不覆盖 状态机生命周期或宿主界面。
 * 外部前置：需要可写临时目录；不需要真实项目数据或宿主服务。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';

import test from 'node:test';
import { briefView } from '../../lib/core/views.js';
import { tmp } from '../helpers/core-lifecycle-fixture.mjs';


// 责任：构造两千任务看板后 brief 仍须保持有界小摘要，不能复制整个 board。
test('the brief stays small on a board with 2000 tasks', async () => {
  const tasks = {};
  for (let i = 0; i < 2000; i += 1) {
    const tid = 'tsk_bulk' + i;
    tasks[tid] = {
      id: tid,
      rev: 1,
      title: 'Bulk task number ' + i + ' with a fairly long title to make payloads realistic',
      state: i % 3 === 0 ? 'ready' : (i % 3 === 1 ? 'blocked' : 'done'),
      priority: 100 + i,
      labels: [],
      deps: [],
      acceptance: [{ id: 'acc_' + i, text: 'ok', met: false, evidenceIds: [], requiredKinds: [] }],
      evidence: [],
      planRef: { planId: 'pln_x', version: 1, stepId: 's1' },
      owner: null,
      assignee: null,
      blocked: i % 3 === 1 ? { code: 'waiting', reason: 'upstream' } : null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
  }
  const fake = {
    state: {
      project: { id: 'prj_x', name: 'Bulk', phase: 'active', rev: 1, focusPlanId: null, updatedAt: '2026-10-01T00:00:00.000Z', policy: { maxInProgress: 2, maxPerSession: 1, leaseTtlSec: 900, verification: 'auto' } },
      tasks,
      planHeads: {},
      plans: {},
      docs: {},
      bindings: {},
      intents: {},
    },
    leases: new Map(),
    rev: 1,
    health: () => { throw new Error('brief must not request a full audit'); },
    healthSummary: () => ({ ok: false, total: 60, evidenceAudit: 'unchecked',
      warnings: Array.from({ length: 60 }, (_, i) => 'warning number ' + i + ' with a long explanatory sentence') }),
  };
  const brief = briefView(fake, null);
  const size = JSON.stringify(brief).length;
  assert.ok(size < 10 * 1024, 'brief is ' + size + ' bytes');
  assert.equal(brief.attention.length, 5);
  assert.equal(brief.health.total, 60);
  assert.equal(brief.health.evidenceAudit, 'unchecked');
  assert.equal(brief.health.warnings.length, 5);
});

// 责任：listProjects 不得打开 handle 或获取锁，项目枚举不能成为写入入口。
test('listProjects does not open handles or take locks', async () => {
  const stateDir = tmp('pb-list-state');
  const svc = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc.init();
  const a = await svc.createProject({ workspacePath: tmp('pb-list-a'), name: 'A' });
  const b = await svc.createProject({ workspacePath: tmp('pb-list-b'), name: 'B' });
  a.close();
  await svc.close();
  const svc2 = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc2.init();
  const projects = await svc2.listProjects();
  assert.equal(projects.length, 2);
  assert.equal(svc2.handles.size, 0, 'a listing leaves no open handles');
  for (const project of projects) {
    const lock = path.join(stateDir, 'projects', project.id, 'lock.json');
    assert.equal(fs.existsSync(lock), false, 'no lock file for ' + project.id);
  }
  await svc2.close();
});

#!/usr/bin/env node
// Synthetic fixtures only. The lifecycle guard refuses live/unknown instances.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectService } from '../lib/core/service.js';
import { createEnvironment, withStoppedEnvironment } from './test-env/environment.mjs';

const ACTOR = { kind: 'human', sessionId: 'test-env-fixture', via: 'system' };
let sequence = 0;

function command(handle, op, payload = {}) {
  return handle.command({ cmdId: `cmd_test_fixture_${Date.now()}_${++sequence}`, actor: ACTOR, op, ...payload });
}

async function populate(env, service) {
  const handle = await service.createProject({
    workspacePath: env.workspace,
    name: '🧪 TEST · ProjectBoard 隔离验收',
    actor: ACTOR,
  });
  const published = await command(handle, 'plan.publish', {
    title: '测试环境入门（仅合成数据）',
    goal: '验证打开、编辑、验收、重启持久化；不是 RFC-5 已实施的证明。',
    steps: [{ id: 'smoke', title: '手动验收', tasks: [
      { key: 'edit', title: '① 编辑测试任务', requiresAudit: true, acceptance: [{ text: '能编辑说明、查看历史且刷新后保留', requiredKinds: ['doc'] }] },
      { key: 'review', title: '② 验收已有证据的样例', requiresAudit: true, acceptance: [{ text: '阅读测试说明后，可由用户人工验收', requiredKinds: ['doc'] }] },
      { key: 'document', title: '③ 创建测试文档', requiresAudit: true, acceptance: [{ text: '能创建及编辑文档，查看版本', requiredKinds: ['doc'] }] },
    ] }],
  });
  const tasks = published.events.filter((event) => event.type === 'task/created').map((event) => event.taskId);
  const reviewId = tasks[1];
  const docResult = await command(handle, 'doc.put', {
    title: '🧪 测试环境说明（不是生产数据）',
    kind: 'runbook',
    body: '# 独立测试环境\n\n这里只包含合成项目、任务与文档，不复制生产会话、凭据或历史。\n\n'
      + '- 开发分支：work/reliability-followup-20261029。精确代码版本以 env:test:status 和本次启动记录为准。\n'
      + '- 两个 ready 任务可试编辑；一个 review 样例可试人工验收。\n'
      + '- 刷新页面、停止再启动后，改动应保留。需要恢复初始数据时先停止，再 reset、seed。\n'
      + '- 不启动模型会话也可以验证看板 UI。未复制生产身份；模型调用需以后明确配置。\n'
      + '- 这不是 OS 沙箱，请勿打开真实项目工作区、粘贴生产密钥或执行不熟悉的命令。\n'
      + '- RFC-5 证据刷新/固定历史版本等业务逻辑尚未在本轮实施，不应期待新增入口。\n',
    links: { taskIds: tasks },
  });
  const docId = docResult.events.find((event) => event.type === 'doc/created').docId;
  await handle.attach({ sessionId: ACTOR.sessionId, agentId: ACTOR.sessionId, source: 'test-env-fixture', role: 'worker' });
  await command(handle, 'task.claim', { taskId: reviewId, expected: { entityRev: handle.state.tasks[reviewId].rev } });
  const token = handle.leases.get(reviewId).token;
  await command(handle, 'task.begin', { taskId: reviewId, expected: { entityRev: handle.state.tasks[reviewId].rev }, fencingToken: token, summary: '准备可人工验收的合成样例' });
  const task = handle.state.tasks[reviewId];
  await command(handle, 'task.submit', {
    taskId: reviewId, expected: { entityRev: task.rev }, fencingToken: token,
    evidence: [{ kind: 'doc', ref: `${docId}@1`, acceptanceId: task.acceptance[0].id, summary: '仅本测试环境的入门说明' }],
  });
  return { projectId: handle.id, planId: published.events.find((event) => event.type === 'plan/created').data.id, taskIds: tasks, reviewTaskId: reviewId, docId };
}

export async function seedEnvironment(env = createEnvironment()) {
  return withStoppedEnvironment(env, async (owned) => {
    const service = new ProjectService({ rootDir: owned.board, privilegedInlineWrites: true });
    try {
      await service.init();
      const existing = service.listProjects();
      if (existing.length > 0) return { seeded: false, reason: 'existing-test-data-preserved', projectIds: existing.map((project) => project.id) };
      fs.writeFileSync(path.join(owned.workspace, 'TEST-ENV.txt'), 'TEST ONLY — disposable workspace; do not put production files or credentials here.\n', { flag: 'wx' });
      const instructions = path.join(owned.workspace, 'AGENTS.md');
      if (!fs.existsSync(instructions)) fs.writeFileSync(instructions, '# Isolated test workspace\n\nSynthetic data only. Do not access production services, projects, or credentials.\n', { flag: 'wx' });
      const fixture = await populate(owned, service);
      fs.writeFileSync(path.join(owned.root, 'fixture.json'), JSON.stringify({ schema: 1, createdAt: new Date().toISOString(), workspace: owned.workspace, ...fixture }, null, 2) + '\n');
      return { seeded: true, ...fixture };
    } finally {
      await service.close();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await seedEnvironment(), null, 2)); }
  catch (error) { console.error('[test-env:seed] ' + error.message); process.exitCode = 1; }
}

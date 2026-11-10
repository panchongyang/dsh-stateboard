import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function cmd(op, extra = {}) {
  return { cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'agent', sessionId: 's1' }, op, ...extra };
}

function humanCmd(op, extra = {}) {
  return { cmdId: 'cmd_' + crypto.randomUUID(), actor: { kind: 'human', via: 'web' }, op, ...extra };
}

const PLAN = {
  title: 'Demo plan',
  goal: 'exercise the state machine',
  steps: [
    {
      id: 's1',
      title: 'first',
      tasks: [
        { key: 't1', title: 'T1', acceptance: [{ text: 'artifact exists' }] },
      ],
    },
    {
      id: 's2',
      title: 'second',
      tasks: [
        { key: 't2', title: 'T2', deps: ['t1'], acceptance: [{ text: 'second artifact' }] },
      ],
    },
  ],
};

async function setup() {
  const stateDir = tmp('pb-state');
  const wsDir = tmp('pb-ws');
  const svc = new ProjectService({ rootDir: stateDir, privilegedInlineWrites: true });
  await svc.init();
  const h = await svc.createProject({ workspacePath: wsDir, name: 'Demo' });
  return { stateDir, wsDir, svc, h };
}

async function publish(h, plan = PLAN, cmdId = 'plan-1') {
  const result = await h.command({ ...cmd('plan.publish', { title: plan.title, goal: plan.goal, steps: plan.steps }), cmdId });
  return result;
}

function taskByTitle(h, title) {
  const task = Object.values(h.state.tasks).find((item) => item.title === title);
  assert.ok(task, 'task ' + title);
  return task;
}

function tokenOf(h, taskId) {
  const lease = h.leases.get(taskId);
  assert.ok(lease, 'lease ' + taskId);
  return lease.token;
}

async function openSubmittable() {
  const { h, wsDir, svc, stateDir } = await setup();
  await publish(h);
  // A third commit: the prev-skip case needs a middle link to jump over.
  await h.command(cmd('task.create', { title: 'Extra', acceptance: [{ text: 'x' }] }));
  return { h, wsDir, svc, stateDir };
}

export { tmp, cmd, humanCmd, PLAN, setup, publish, taskByTitle, tokenOf, openSubmittable };

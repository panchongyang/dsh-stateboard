// Synthetic historical logs only: writer CLOSED before appending a valid hash
// envelope, then reopened through normal replay. Never an active model write port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCommit } from '../../lib/core/domain/commit-envelope.js';

export async function seedStageHistory(handle, events) {
  const service = handle.service;
  const projectId = handle.id;
  const relative = path.relative(os.tmpdir(), handle.store.dir);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'history fixture is confined to synthetic temp storage');
  assert.equal(handle.leases.size, 0, 'history seeding never transfers live runtime authority');
  const file = handle.store.commitsFile;
  const prefix = fs.readFileSync(file);
  const record = makeCommit(handle.rev + 1, handle.lastHash,
    { kind: 'human', via: 'synthetic-stage-history' }, 'synthetic_stage_' + (handle.rev + 1), handle.rev,
    structuredClone(events), handle.clock().toISOString());
  handle.close();
  assert.equal(handle.closed, true);
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  assert.deepEqual(fs.readFileSync(file).subarray(0, prefix.length), prefix);
  const reopened = await service.open(projectId);
  assert.equal(reopened.rev, record.seq);
  return reopened;
}

export async function seedStageMembership(handle, planId, steps) {
  const previous = handle.state.plans[planId + '@' + handle.state.currentPlans[planId]];
  const head = handle.state.planHeads[planId];
  const version = previous.version + 1;
  const at = handle.clock().toISOString();
  const next = { ...structuredClone(previous), version, steps, status: 'published', supersedes: previous.version, publishedAt: at };
  const superseded = { ...structuredClone(previous), status: 'superseded', supersededBy: { planId, version } };
  const events = [{ type: 'plan/superseded', data: superseded },
    { type: 'plan/revised', data: next, head: { ...head, currentVersion: version, rev: head.rev + 1, updatedAt: at } }];
  const members = new Map(steps.flatMap((step) => step.taskIds.map((taskId) => [taskId, step.id])));
  const previousIds = new Set(previous.steps.flatMap((step) => step.taskIds));
  for (const [taskId, stepId] of members) {
    const task = handle.state.tasks[taskId];
    // A legacy foreign reference is a ghost membership, not a transfer of its owner.
    if (task.planRef?.planId !== planId) continue;
    const data = { ...structuredClone(task), rev: task.rev + 1, planRef: { planId, version, stepId }, updatedAt: at };
    events.push({ type: 'task/updated', taskId, rev: data.rev, data });
  }
  for (const taskId of previousIds) if (!members.has(taskId)) {
    const task = handle.state.tasks[taskId];
    if (task.planRef?.planId !== planId) continue;
    const data = { ...structuredClone(task), rev: task.rev + 1, orphaned: true, updatedAt: at };
    events.push({ type: 'task/orphaned', taskId, rev: data.rev, data });
  }
  return seedStageHistory(handle, events);
}

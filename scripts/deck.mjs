#!/usr/bin/env node
/**
 * ProjectBoard CLI harness. Drives the core without starting DSH; useful for
 * dogfooding, fixtures, and debugging. Not a product API.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProjectService } from '../lib/core/service.js';

const args = process.argv.slice(2);
const command = args[0];
const jsonOut = args.includes('--json');

function arg(name, fallback) {
  const index = args.indexOf('--' + name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}
function has(name) {
  return args.includes('--' + name);
}
function repeat(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--' + name && i + 1 < args.length) out.push(args[i + 1]);
  }
  return out;
}
function rootDir() {
  if (arg('root')) return path.resolve(arg('root'));
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh');
  return path.join(home, 'project-board');
}
function workspace() {
  const value = arg('workspace', process.cwd());
  if (!fs.existsSync(value)) throw new Error('workspace does not exist: ' + value);
  return path.resolve(value);
}
function cmdId(prefix) {
  return 'cmd_' + prefix + '_' + crypto.randomBytes(6).toString('hex');
}
function out(value) {
  if (jsonOut) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function open(service, create) {
  const ws = workspace();
  let handle = await service.openByWorkspace(ws);
  if (!handle && create) {
    handle = await service.createProject({ workspacePath: ws, name: arg('name', path.basename(ws)), actor: { kind: 'system', via: 'system' } });
  }
  if (!handle) throw new Error('no ProjectBoard project for ' + ws + ' (run init first)');
  return handle;
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log([
      'ProjectBoard CLI (development harness)',
      '',
      '  node scripts/deck.mjs init   --workspace <path> [--root <stateDir>] [--name <name>] [--json]',
      '  node scripts/deck.mjs plan   --workspace <path> --file <plan.json> [--json]',
      '  node scripts/deck.mjs board  --workspace <path> [--json]',
      '  node scripts/deck.mjs brief  --workspace <path> [--json]',
      '  node scripts/deck.mjs health --workspace <path> [--json]',
      '  node scripts/deck.mjs claim  --workspace <path> --task <taskId> [--json]',
      '  node scripts/deck.mjs begin  --workspace <path> --task <taskId> --summary <text> [--json]',
      '  node scripts/deck.mjs submit --workspace <path> --task <taskId> --evidence file:<path> [--acceptance <accId>] [--json]',
      '  node scripts/deck.mjs verify --workspace <path> --task <taskId> --human [--json]',
      '',
      'State defaults to ~/.dsh/project-board (or $DSH_HOME/project-board); use --root to isolate.',
    ].join('\n'));
    return;
  }
  const service = new ProjectService({ rootDir: rootDir() });
  await service.init();

  if (command === 'init') {
    const handle = await open(service, true);
    out({ ok: true, projectId: handle.id, workspacePath: handle.workspacePath, name: handle.name });
    return;
  }

  if (command === 'plan') {
    const file = arg('file');
    if (!file) throw new Error('plan requires --file <plan.json>');
    const plan = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const handle = await open(service, true);
    const result = await handle.command({
      cmdId: cmdId('plan'), actor: { kind: 'agent', sessionId: 'cli' },
      op: 'plan.publish', title: plan.title, goal: plan.goal,
      assumptions: plan.assumptions, risks: plan.risks, steps: plan.steps,
    });
    out({ ok: true, projectId: handle.id, result, plan: handle.query('plan', {}) });
    return;
  }

  const handle = await open(service, false);

  if (command === 'board') {
    out({ ok: true, projectId: handle.id, ...handle.query('board', {}) });
    return;
  }
  if (command === 'brief') {
    out({ ok: true, projectId: handle.id, digest: handle.digest('cli'), ...handle.query('brief', { sessionId: 'cli' }) });
    return;
  }
  if (command === 'health') {
    out({ ok: true, projectId: handle.id, health: handle.health() });
    return;
  }

  const taskId = arg('task');
  if (!taskId) throw new Error(command + ' requires --task <taskId>');
  const task = handle.state.tasks[taskId];
  if (!task) throw new Error('task not found: ' + taskId);
  const actor = has('human') ? { kind: 'human', via: 'web' } : { kind: 'agent', sessionId: 'cli' };
  const base = {
    cmdId: cmdId(command),
    actor,
    taskId,
    expected: { entityRev: task.rev },
  };

  if (command === 'claim') {
    const result = await handle.command({ ...base, op: 'task.claim' });
    out({ ok: true, projectId: handle.id, result, lease: handle.leases.get(taskId) || null, task: handle.query('task', { taskId }) });
    return;
  }
  if (command === 'begin') {
    const lease = handle.leases.get(taskId);
    if (!lease) throw new Error('claim the task first');
    const result = await handle.command({ ...base, op: 'task.begin', fencingToken: lease.token, summary: arg('summary', 'work') });
    out({ ok: true, projectId: handle.id, result, task: handle.query('task', { taskId }) });
    return;
  }
  if (command === 'submit') {
    const lease = handle.leases.get(taskId);
    if (!lease) throw new Error('claim/begin the task first');
    const acceptanceId = arg('acceptance', task.acceptance && task.acceptance[0] ? task.acceptance[0].id : undefined);
    const evidence = repeat('evidence').map((entry) => {
      const colon = entry.indexOf(':');
      if (colon <= 0) throw new Error('evidence must be kind:ref');
      return { kind: entry.slice(0, colon), ref: entry.slice(colon + 1), summary: arg('note', 'cli evidence'), acceptanceId };
    });
    const result = await handle.command({ ...base, op: 'task.submit', fencingToken: lease.token, note: arg('note', ''), evidence });
    out({ ok: true, projectId: handle.id, result, task: handle.query('task', { taskId }) });
    return;
  }
  if (command === 'verify') {
    if (!has('human')) throw new Error('verify requires --human');
    const result = await handle.command({ ...base, op: 'task.verify' });
    out({ ok: true, projectId: handle.id, result, task: handle.query('task', { taskId }) });
    return;
  }

  throw new Error('unknown command: ' + command);
}

try {
  await main();
} catch (error) {
  console.error('[deck] ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

#!/usr/bin/env node
/**
 * Relocate one ProjectBoard project to another workspace path.
 *
 * This appends a normal project/updated commit (hash chain preserved) and
 * rewrites meta.json, so the same project id, tasks, plans, docs and history
 * follow the workspace. It does NOT move files.
 *
 * The DSH host must not hold the project lock while this runs. Stop the host
 * using the board and start it again afterwards. Otherwise the open
 * host handle will keep serving the old path until a restart.
 *
 * Usage:
 *   node scripts/relocate-project.mjs --from "OLD_WORKSPACE" --to "NEW_WORKSPACE"
 *   node scripts/relocate-project.mjs --project PROJECT_ID --to "NEW_WORKSPACE"
 *   node scripts/relocate-project.mjs --from ... --to ... --dry-run
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../lib/core/service.js';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
function rootDir() {
  if (arg('root')) return path.resolve(arg('root'));
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh');
  return path.join(home, 'project-board');
}
function log(value) { console.log(JSON.stringify(value, null, 2)); }

async function main() {
  const from = arg('from');
  const projectId = arg('project');
  const to = arg('to');
  const dryRun = args.includes('--dry-run');
  if (!to) throw new Error('--to <workspace> is required');
  if (!from && !projectId) throw new Error('either --from <workspace> or --project <projectId> is required');
  if (!fs.existsSync(to) || !fs.statSync(to).isDirectory()) throw new Error('target workspace does not exist: ' + to);

  const service = new ProjectService({ rootDir: rootDir() });
  await service.init();
  const handle = from ? await service.openByWorkspace(from) : await service.open(projectId);
  if (!handle) throw new Error('project not found for workspace: ' + from);
  const current = {
    projectId: handle.id,
    name: handle.name,
    from: handle.workspacePath,
    to: path.resolve(to),
    rev: handle.rev,
    readOnly: handle.readOnly,
  };
  if (dryRun) {
    log({ ok: true, dryRun: true, current });
    handle.close();
    await service.close();
    return;
  }
  if (handle.readOnly) {
    throw new Error('project is read-only (another process holds the lock). Stop dsh-web first, then retry.');
  }
  const result = await handle.command({
    cmdId: 'cmd_relocate_' + crypto.randomBytes(6).toString('hex'),
    actor: { kind: 'system', via: 'system' },
    op: 'project.relocate',
    workspacePath: path.resolve(to),
  });
  log({
    ok: true,
    projectId: handle.id,
    from: current.from,
    to: handle.workspacePath,
    rev: result.projectRev,
    events: result.events.map((event) => event.type),
  });
  handle.close();
  await service.close();
}

try {
  await main();
} catch (error) {
  console.error('[relocate] ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

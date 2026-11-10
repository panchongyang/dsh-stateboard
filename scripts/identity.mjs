#!/usr/bin/env node
/**
 * Local identity operations for ProjectBoard (docs/IDENTITY.md).
 *
 *   node scripts/identity.mjs resolve  --cwd <dir>
 *   node scripts/identity.mjs plan                                   (dry-run, writes nothing)
 *   node scripts/identity.mjs migrate  --confirm <planHash>
 *   node scripts/identity.mjs bind     --project <prj_…> --path <worktree dir>
 *   node scripts/identity.mjs unbind   --binding <bnd_…> [--reason text]
 *   node scripts/identity.mjs relocate --project <prj_…> --path <new main dir>
 *   node scripts/identity.mjs fork     --path <marked copy> [--name text]
 *   node scripts/identity.mjs import   --from <exported projects/prj_… dir> --path <local dir>
 *   node scripts/identity.mjs mark     --project <prj_…>               (writes .dsh-project.json at the main root)
 *
 * --root <board root> overrides DSH_HOME/.dsh/project-board. Every write needs
 * the DSH host stopped (it holds project locks) except bind/unbind/mark.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../lib/core/service.js';
import { writeMarker } from '../lib/core/identity/discover.js';
import { bindWorktree, forkWorkspace, importProject, migrate, planMigration, unbind } from '../lib/core/identity/ops.js';

const args = process.argv.slice(2);
const command = args[0];
const arg = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const need = (name) => {
  const value = arg(name);
  if (!value) throw new Error('--' + name + ' is required');
  return value;
};
const actor = { kind: 'system', via: 'system' };

function rootDir() {
  if (arg('root')) return path.resolve(arg('root'));
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh');
  return path.join(home, 'project-board');
}

async function writable(service, projectId) {
  const handle = await service.open(projectId);
  if (handle.readOnly) throw new Error('project is read-only (another process holds the lock); stop the DSH host first');
  return handle;
}

const COMMANDS = {
  resolve: (s) => s.resolveWorkspace(need('cwd')),
  plan: (s) => planMigration(s),
  migrate: (s) => migrate(s, { confirm: need('confirm'), actor }),
  bind: (s) => bindWorktree(s, { projectId: need('project'), workspacePath: need('path'), actor }),
  unbind: (s) => unbind(s, { bindingId: need('binding'), reason: arg('reason'), actor }),
  async relocate(s) {
    const handle = await writable(s, need('project'));
    const result = await handle.command({ cmdId: 'cmd_relocate_' + crypto.randomBytes(6).toString('hex'), actor, op: 'project.relocate', workspacePath: path.resolve(need('path')) });
    return { projectId: handle.id, workspacePath: handle.workspacePath, rev: result.projectRev, warnings: result.warnings || [] };
  },
  async fork(s) {
    const { handle, forkedFrom } = await forkWorkspace(s, { workspacePath: need('path'), name: arg('name'), actor });
    return { projectId: handle.id, forkedFrom, workspacePath: handle.workspacePath };
  },
  import: (s) => importProject(s, { sourceDir: need('from'), workspacePath: need('path'), actor }),
  mark(s) {
    const projectId = need('project');
    const main = s.bindings().mainOf(projectId);
    if (!main) throw new Error('project has no main binding on this machine: ' + projectId);
    return { file: writeMarker(main.root, projectId) };
  },
};

async function main() {
  const run = COMMANDS[command];
  if (!run) throw new Error('unknown command: ' + String(command) + ' (resolve|plan|migrate|bind|unbind|relocate|fork|import|mark)');
  const service = new ProjectService({ rootDir: rootDir() });
  await service.init();
  try {
    const value = await run(service);
    console.log(JSON.stringify({ ok: true, command, root: service.rootDir, value }, null, 2));
  } finally {
    await service.close();
  }
}

try {
  await main();
} catch (error) {
  console.log(JSON.stringify({ ok: false, command, code: error && error.code ? error.code : 'error', message: error instanceof Error ? error.message : String(error), details: error && error.details ? error.details : null }, null, 2));
  process.exitCode = 1;
}

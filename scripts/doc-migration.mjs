#!/usr/bin/env node
// Default = synthetic dry-run, JSON to stdout only. No implicit home/store discovery.
import fs from 'node:fs';
import path from 'node:path';
import { JsonlStore } from '../lib/core/store.js';
import { inventoryInlineDocuments } from '../lib/core/documents/migration-inventory.js';
import { migrationFixture } from '../lib/core/documents/migration-fixture.js';
import { ProjectService } from '../lib/core/service.js';
import { migrateInlineDocuments } from '../lib/core/documents/migration.js';
import { checkMigrationBackup } from '../lib/core/documents/migration-backup.js';
import { migrationBlobReader } from '../lib/core/documents/migration-blob.js';

async function main(args) {
  const allowed = new Set(['--store', '--authorized-read', '--export-bodies', '--destinations', '--fixture',
    '--apply', '--board', '--project', '--backup', '--restore-tested', '--authorized-migrate', '--mappings', '--check-backup']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error('unknown argument: ' + args[i]);
    if (['--store', '--destinations', '--board', '--project', '--backup', '--mappings'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('missing value: ' + args[i]);
      i++;
    }
  }
  const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  if (args.includes('--apply')) {
    await apply(args, value);
    return;
  }
  const dir = value('--store');
  if (dir && !args.includes('--authorized-read')) throw new Error('explicit --authorized-read is required; see migration runbook before reading real data');
  const store = dir ? new JsonlStore(dir, { project: {} }, { lock: false }) : migrationFixture();
  if (dir) store.open(); // lock:false never repairs, snapshots, or starts a heartbeat
  if (args.includes('--check-backup')) {
    if (!dir) throw new Error('--check-backup requires explicit --store');
    const checked = checkMigrationBackup({ id: store.state.project.id, state: store.state, store },
      { directory: value('--backup'), restoreTested: args.includes('--restore-tested') });
    process.stdout.write(JSON.stringify(checked, null, 2) + '\n');
    return;
  }
  const destinations = value('--destinations') ? JSON.parse(fs.readFileSync(value('--destinations'), 'utf8')) : [];
  const report = inventoryInlineDocuments({ state: store.state, commits: store.commits,
    readBlob: migrationBlobReader(store), destinations, includeBodies: args.includes('--export-bodies') });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

async function apply(args, value) {
  if (!args.includes('--authorized-read') || !args.includes('--authorized-migrate') || !args.includes('--restore-tested')) throw new Error('--apply requires --authorized-read, --authorized-migrate and --restore-tested');
  for (const flag of ['--board', '--project', '--backup', '--mappings']) if (!value(flag)) throw new Error('--apply requires ' + flag);
  if (!path.isAbsolute(value('--board')) || !path.isAbsolute(value('--backup'))) throw new Error('board/backup paths must be absolute');
  if (!/^prj_[a-zA-Z0-9_-]+$/.test(value('--project'))) throw new Error('invalid project id');
  if (!fs.existsSync(path.join(value('--board'), 'projects', value('--project'), 'meta.json'))) throw new Error('explicit project store must already exist');
  const mappings = JSON.parse(fs.readFileSync(value('--mappings'), 'utf8'));
  const service = new ProjectService({ rootDir: value('--board') });
  try {
    await service.init();
    const handle = await service.open(value('--project'));
    const result = await migrateInlineDocuments(handle, { mappings, authorized: true,
      backup: { directory: value('--backup'), restoreTested: true } });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.problems.length) process.exitCode = 2;
  } finally {
    await service.close();
  }
}

try { await main(process.argv.slice(2)); } catch (error) {
  process.stderr.write((error.code || 'migration-error') + ': ' + error.message + '\n');
  process.exitCode = 1;
}

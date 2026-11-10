#!/usr/bin/env node
// Explicit offline inspection only: no ProjectService/ProjectHandle or write API.
import fs from 'node:fs';
import path from 'node:path';
import { scanPrefix } from '../lib/core/repair.js';
import { replay } from '../lib/core/store/format.js';
import { normalizePlanHeads } from '../lib/core/model.js';
import { boardView, eventsView } from '../lib/core/views.js';
import { checkState } from '../lib/core/fsck.js';

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--root', '--project', '--view'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('usage: salvage-log --root <absolute dir> --project <id> --view board|health|events');
    }
    if (args[argv[i]]) throw new Error('duplicate argument ' + argv[i]);
    args[argv[i]] = argv[i + 1];
  }
  const root = args['--root'];
  const project = args['--project'];
  const view = args['--view'];
  if (!root || !path.isAbsolute(root) || !/^[a-zA-Z0-9_-]+$/.test(project || '') || !['board', 'health', 'events'].includes(view)) {
    throw new Error('explicit absolute --root, --project and --view board|health|events are required');
  }
  const dir = path.join(root, 'projects', project);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  if (meta.projectId !== project || !meta.project) throw new Error('project metadata mismatch');
  const file = path.join(dir, 'commits.jsonl');
  if (!fs.existsSync(file)) throw new Error('missing commits.jsonl');
  const scan = scanPrefix(file, { projectId: project });
  const { state, timeline } = replay(meta, scan.lines);
  normalizePlanHeads(state);
  const handle = { state, timeline, rev: state.lastSeq };
  const result = view === 'board' ? boardView(handle) : view === 'events' ? eventsView(handle, 0, Number.MAX_SAFE_INTEGER) : checkState(state);
  const diagnostic = scan.diagnostic ? { code: scan.diagnostic.code, ...scan.diagnostic.details, message: scan.diagnostic.message } : null;
  process.stdout.write(JSON.stringify({
    mode: 'read-only-prefix', current: false, readOnly: true,
    warning: '只读前缀，非当前状态 / READ-ONLY PREFIX, NOT CURRENT STATE',
    status: diagnostic ? 'partial' : 'validated-prefix',
    validSeq: state.lastSeq, validHash: state.lastHash, diagnostic, view, result,
  }, null, 2) + '\n');
  // Partial output is useful, but is never an unqualified successful read.
  if (diagnostic) process.exitCode = 2;
}

try { main(process.argv.slice(2)); }
catch (error) {
  process.stderr.write(JSON.stringify({ error: { code: error.code || 'salvage-failed', message: error.message, details: error.details || null } }) + '\n');
  process.exitCode = 1;
}

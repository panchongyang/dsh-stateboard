#!/usr/bin/env node
// Context-cost meter for the ProjectBoard model surface.
//
// The 2026-10-26 repeat audit put ProjectBoard on the list of tools whose output
// is mostly fixed text repeated on every call: a 439-char RULES block shipped
// with each brief, and a whole-board reprint with no "same as last time" check.
// This script re-measures that surface offline by driving the real registered
// tools in memory and printing per-view character counts.
//
//   before = the same fixture rendered the old way (brief carries RULES, every
//            board read prints in full)
//   after  = today's surface (brief drops the rules when the system prompt
//            already carries them, identical board reads collapse to one line)
//
// Nothing outside os.tmpdir() is touched: the project lives in a throwaway state
// dir, the workspace is an empty throwaway dir, and both are removed in
// `finally`. No HTTP, no network, no reads of the user's real store.
//
// Usage: node scripts/measure-context-cost.mjs [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

const asJson = process.argv.includes('--json');
const TASKS = 12;
const GATE_LINE = 'humanReview: off';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percent(part, whole) {
  if (!whole) return '0%';
  return Math.round((part / whole) * 100) + '%';
}

async function main() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cost-state-'));
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cost-ws-'));
  const tools = new Map();
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 9000; } },
    agents: { list() { return []; } },
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    get() { return undefined; },
  };
  const exec = { agent: { id: 'measure-plain', session: { header: { cwd: wsDir } } }, callId: 'measure-call' };

  try {
    apply(ctx, { rootDir: stateDir });
    await sleep(50);

    const planTool = tools.get('project_plan');
    const taskTool = tools.get('project_task');
    const boardTool = tools.get('project_board');

    await planTool.execute({
      op: 'publish',
      title: 'Cost fixture',
      goal: 'measure the context cost of one read round',
      steps: [{
        id: 's1',
        title: 'seeded step',
        tasks: Array.from({ length: TASKS }, (_, index) => ({
          key: 'k' + index,
          title: 'Fixture task ' + index,
          acceptance: [{ text: 'acceptance ' + index }],
        })),
      }],
    }, exec);

    const withSection = {
      id: 'measure-with-section',
      session: { header: { cwd: wsDir } },
      ctx: { inject() { return { dispose() {} }; } },
    };
    for (const handler of handlers.get('agent/created') || []) await handler({ agent: withSection, source: 'measure' });

    const fullBrief = (await boardTool.execute({ view: 'brief' }, exec)).digest;
    const leanBrief = (await boardTool.execute({ view: 'brief' }, { agent: withSection, callId: 'measure-lean' })).digest;
    // The block is a constant, so measure it inside the full brief instead of
    // subtracting two digests (their SESSION lines differ by session id).
    const marker = fullBrief.indexOf('\nRULES\n');
    const rulesChars = marker >= 0 ? fullBrief.slice(marker + 1).length : 0;
    const rulesWithSeparator = rulesChars > 0 ? rulesChars + 1 : 0;

    const firstBoardValue = await boardTool.execute({ view: 'board' }, exec);
    const firstBoard = boardTool.output.render({ view: 'board' }, firstBoardValue)[0].text;
    const secondBoardValue = await boardTool.execute({ view: 'board' }, exec);
    const secondBoard = boardTool.output.render({ view: 'board' }, secondBoardValue)[0].text;
    const freshBoardValue = await boardTool.execute({ view: 'board', fresh: true }, exec);
    const freshBoard = boardTool.output.render({ view: 'board', fresh: true }, freshBoardValue)[0].text;

    const created = await taskTool.execute({ op: 'create', title: 'Un-gated task', acceptance: [{ text: 'x' }] }, exec);
    const taskRender = taskTool.output.render({ op: 'create' }, created)[0].text;
    const gateLine = taskRender.split('\n').find((line) => line.startsWith('humanReview:')) || '';

    const rows = [
      {
        metric: 'brief, rules block (chars)',
        before: rulesWithSeparator,
        after: 0,
        note: 'constant per call; RULES text = ' + rulesChars + ' chars (' + percent(rulesChars, fullBrief.length)
          + ' of the full brief, CONTRACT §3.4.1)',
      },
      {
        metric: 'brief total (chars)',
        before: leanBrief.length + rulesWithSeparator,
        after: leanBrief.length,
        note: 'before is reconstructed: today’s brief + the block it no longer re-sends',
      },
      {
        metric: 'board, 2nd identical read (chars)',
        before: firstBoard.length,
        after: secondBoard.length,
        note: 'collapsed line: ' + JSON.stringify(secondBoard),
      },
      {
        metric: 'board, fresh=true read (chars)',
        before: firstBoard.length,
        after: freshBoard.length,
        note: 'escape hatch always reprints the full view',
      },
      {
        metric: 'task render, gate line (chars)',
        before: GATE_LINE.length + 1,
        after: gateLine.length,
        note: gateLine === '' ? '"humanReview: off" is no longer printed by default' : 'gate still prints: ' + gateLine,
      },
    ];

    for (const row of rows) {
      row.saved = Math.max(0, row.before - row.after);
      row.savedPercent = percent(row.saved, row.before);
    }

    const projection = {
      auditCalls: 263,
      rulesCharsPerCall: rulesWithSeparator,
      projectedSavedChars: rulesWithSeparator * 263,
      note: '2026-10-26 audit saw 263 project_board calls; this is a projection, not a measurement',
    };

    if (asJson) {
      process.stdout.write(JSON.stringify({ tasks: TASKS, rows, projection }, null, 2) + '\n');
      return;
    }

    const header = ['metric', 'before', 'after', 'saved'];
    const body = rows.map((row) => [row.metric, String(row.before), String(row.after), row.saved + ' (' + row.savedPercent + ')']);
    const widths = header.map((cell, index) => Math.max(cell.length, ...body.map((row) => row[index].length)));
    const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd();

    process.stdout.write('fixture: ' + TASKS + ' tasks, temp state + temp workspace\n\n');
    process.stdout.write(line(header) + '\n');
    process.stdout.write(widths.map((width) => '-'.repeat(width)).join('  ') + '\n');
    for (const row of body) process.stdout.write(line(row) + '\n');
    process.stdout.write('\n');
    for (const row of rows) process.stdout.write('- ' + row.metric + ': ' + row.note + '\n');
    process.stdout.write('\nprojection: ' + projection.auditCalls + ' calls x ' + projection.rulesCharsPerCall
      + ' chars = ' + projection.projectedSavedChars + ' chars not re-sent (' + projection.note + ')\n');
    process.stdout.write('\nbefore = the same fixture rendered the old way; after = today (CONTRACT §3.4.1/§3.4.2).\n');
  } finally {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* ignore */ }
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write('measure-context-cost failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exit(1);
});

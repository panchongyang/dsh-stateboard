/**
 * 测试职责：校验宿主安装元数据、审计载荷翻译与 project:brief 字面文本注入边界。
 * 典型流程：真实 peer API 配合隔离 HOME/profile 或合成 runtime → 工具/HTTP/Prompt 渲染 → 比较载荷与文本。
 * 覆盖边界：覆盖 审计 schema、角色诊断、安装幂等与 Prompt 字面模式；不覆盖真实 profile 改装或部署。
 * 外部前置：需要 DSH app-boot/home-paths 等宿主 peer；安装只使用临时 profile。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../../lib/core/service.js';
import { register as registerPlan } from '../../lib/host/tools/plan.js';
import { register } from '../../lib/host/tools/task.js';
import { BoardError } from '../../lib/core/errors.js';
import { fail, boardSummary, taskSummary } from '../../lib/host/tools/shared.js';
import { buildDigest } from '../../lib/core/digest.js';
import { commandsRoute } from '../../lib/host/routes/commands.js';
import { authorizeWebRequest } from '../../lib/host/auth.js';
import { projectsRoute } from '../../lib/host/routes/projects.js';
import { externalDocsRoute } from '../../lib/host/routes/docs.js';
import { installPrompt } from '../../lib/host/prompt.js';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadOverlayPatches, resolveProfileDir } from '@deepseek-ai/dsh-app-boot';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { discoverHost } from '../../scripts/install.mjs';
import { command } from '../helpers/fixed-fixture.mjs';

const { authority: webAuthority } = authorizeWebRequest({ headers: { 'x-project-board-token': 'fixture-token' } }, 'fixture-token');

// 责任：宿主解析 bundle/patch 后须识别插件且不新增产品 CLI，D6 路径解析必须尊重隔离根。
test('install bundle and D6 metadata resolve through the real host without adding a product CLI', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url)));
  assert.equal(pkg.bin, undefined);
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-client-runtime'], undefined);
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-runtime']);
  assert.equal(pkg.dsh.bundle.patch, './lib/cordis.patch.yml');
  const patch = loadOverlayPatches('project-board-test', fileURLToPath(new URL('../../lib/cordis.patch.yml', import.meta.url)));
  assert.deepEqual(patch[0].insert.map(row => ({id: row.id, name: row.name})), [{ id: 'project-board', name: 'dsh-stateboard' }]);
  const host = discoverHost();
  assert.ok(fs.existsSync(host.manifest));
  const isolatedHome = path.join(os.tmpdir(), 'synthetic-home');
  assert.equal(resolveDshHome(undefined, { DSH_HOME: isolatedHome }), path.resolve(isolatedHome));
  assert.equal(resolveProfileDir('custom-profile', isolatedHome), path.join(isolatedHome, 'profiles', 'custom-profile'));
});

// 责任：安装 CLI 须尊重隔离 HOME/DSH_HOME，自定义 profile dry-run 零写、重复安装幂等且可卸载。
test('installer CLI honors isolated HOME and DSH_HOME and is idempotent for a custom profile', (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'pb-install-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const profile = path.join(home, 'profiles', 'custom-profile');
  fs.mkdirSync(profile, {recursive:true});
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
  const env = { ...process.env, HOME: root, USERPROFILE: root, DSH_HOME: home, DSH_AGENTS_HOME: path.join(root,'agents') };
  delete env.DSH_PROFILE;
  const entry = new URL('../../scripts/install.mjs', import.meta.url);
  const run = (...args) => {
    const result = spawnSync(process.execPath, [fileURLToPath(entry), ...args], {env, encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const before = fs.readFileSync(path.join(profile, 'package.json'),'utf8');
  assert.match(run('--dry-run'), /preview only; no writes/);
  assert.equal(fs.readFileSync(path.join(profile, 'package.json'),'utf8'),before);
  run();
  assert.match(run(), /already installed; no writes/);
  assert.equal(fs.existsSync(path.join(root,'.dsh')),false, 'DSH_HOME wins over HOME');
  run('--uninstall');
  assert.equal(fs.existsSync(path.join(profile,'node_modules','dsh-stateboard')),false);
});

const audit = { report: 'Independent review of submitted material; command results remain self-declared.', checklist: [{ item: 'Content and scope reviewed', ok: true, note: 'No command executed by board' }] };
function fixture() {
  let tool;
  const commands = [];
  const handle = { id: 'prj_synthetic', touch() {}, command: async cmd => { commands.push(cmd); return { events: [] }; }, query: () => ({ task: { id: 'tsk_synthetic', rev: 3, acceptance: [] } }) };
  register({ tools: { register(value) { tool = value; } } }, { ready: Promise.resolve(), service: { openByWorkspace: async () => handle }, sessionProjects: new Map() });
  return { tool, commands, exec: { agent: { id: 'auditor-session', session: { header: { cwd: process.cwd() } } }, callId: 'call_synthetic' } };
}

// 责任：verify/reject 工具须完整转发 audit/flags 和 agent 身份，审计门字段不能回退旧命名。
test('tool audit schema and verify/reject forwarding preserve payload and actor', async () => {
  const { tool, commands, exec } = fixture();
  assert.ok(tool.parameters.properties.requiresAudit);
  assert.ok(tool.parameters.properties.audit.properties.checklist.items.properties.ok);
  assert.equal(tool.parameters.properties.requiresHumanReview, undefined);
  for (const op of ['verify', 'reject']) {
    await tool.execute({ op, taskId: 'tsk_synthetic', expectedRev: 3, reason: 'reviewed material', audit, unassign: true, acknowledgeDrift: false, refreshDrift: false }, exec);
    const cmd = commands.at(-1);
    assert.deepEqual(cmd.audit, audit);
    assert.equal(cmd.actor.kind, 'agent');
    assert.equal(cmd.actor.sessionId, 'auditor-session');
    if (op === 'reject') assert.equal(cmd.unassign, true, 'forward forbidden flag, never silently discard');
    else assert.equal(cmd.refreshDrift, false);
  }
  for (const op of ['create', 'update', 'gate']) {
    await tool.execute({ op, taskId: 'tsk_synthetic', expectedRev: 3, requiresAudit: true }, exec);
    assert.equal(commands.at(-1).requiresAudit, true);
  }
});

// 责任：原始工具输入含废弃或未知审计意图字段时，须在创建项目或写入前拒绝。
test('raw intake tools reject obsolete and unknown gate intent before project creation or writes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-surface-intake-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const service = new ProjectService({ rootDir: path.join(root, 'board') });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.init();
  const tools = new Map();
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); } } };
  const runtime = { ready: Promise.resolve(), service, sessionProjects: new Map() };
  register(ctx, runtime); registerPlan(ctx, runtime);
  const exec = { agent: { id: 'intake-worker', session: { header: { cwd: workspace } } }, callId: 'intake-call' };
  const taskTool = tools.get('project_task');
  const planTool = tools.get('project_plan');
  const definition = { key: 'k', title: 'draft task', acceptance: [{ text: 'record', requiredKinds: ['file'] }] };
  const steps = task => [{ id: 's', title: 'step', tasks: [task] }];
  const badCreates = [
    [taskTool, { op: 'create', title: 'bad', acceptance: [{ text: 'record' }], requiresHumanReview: true }],
    [taskTool, { op: 'create', title: 'bad', acceptance: [{ text: 'record' }], labels: ['gate:human'] }],
    [taskTool, { op: 'create', title: 'bad', acceptance: [{ text: 'record' }], requiresAudit: 'true' }, 'INVALID_ARGS'],
    [taskTool, { op: 'create', title: 'bad', acceptance: [{ text: 'record' }], unexpectedGate: true }],
    [planTool, { op: 'create', title: 'bad', requiresHumanReview: true, steps: steps(definition) }],
    [planTool, { op: 'create', title: 'bad', steps: steps({ ...definition, requiresHumanReview: true }) }, 'INVALID_ARGS'],
    [planTool, { op: 'create', title: 'bad', steps: steps({ ...definition, labels: ['gate:human'] }) }],
    [planTool, { op: 'publish', title: 'bad', steps: steps({ ...definition, requiresAudit: 'true' }) }, 'INVALID_ARGS'],
  ];
  for (const [tool, args, sdkCode] of badCreates) {
    await assert.rejects(tool.execute(args, exec), error => {
      if (sdkCode) {
        assert.equal(error.name, 'ToolArgsError'); assert.equal(error.code, sdkCode);
        assert.ok(error.violations.length > 0); return true;
      }
      const value = JSON.parse(error.message);
      assert.equal(value.code, 'invalid-command'); assert.equal(value.status, 400); return true;
    });
    assert.equal(service.listProjects().length, 0, 'raw rejection precedes resolveHandle/createProject');
    assert.equal(fs.existsSync(path.join(workspace, '.dsh-project.json')), false);
  }
  const created = await taskTool.execute({ op: 'create', title: 'valid gate', acceptance: [{ text: 'record' }], requiresAudit: true }, exec);
  assert.equal(created.task.task.requiresAudit, true);
  assert.ok(created.task.task.labels.includes('gate:audit'));
  const handle = await service.open(created.projectId);
  const draft = await planTool.execute({ op: 'create', title: 'valid draft', steps: steps({ ...definition, requiresAudit: true }) }, exec);
  const head = handle.state.planHeads[draft.plan.id];
  assert.equal(head.draft.steps[0].tasks[0].requiresAudit, true);
  const before = fs.readFileSync(handle.store.commitsFile);
  const rev = handle.rev;
  const badExisting = [
    [taskTool, { op: 'update', taskId: created.task.task.id, expectedRev: created.task.task.rev, requiresHumanReview: false }],
    [taskTool, { op: 'gate', taskId: created.task.task.id, expectedRev: created.task.task.rev, requiresHumanReview: true }],
    [planTool, { op: 'revise', planId: head.id, expectedRev: head.rev, requiresHumanReview: false }],
    [planTool, { op: 'revise', planId: head.id, expectedRev: head.rev, steps: steps({ ...definition, labels: ['gate:unknown'] }) }],
    [planTool, { op: 'publish', planId: head.id, expectedRev: head.rev, requiresHumanReview: true }],
  ];
  for (const [tool, args] of badExisting) {
    await assert.rejects(tool.execute(args, exec), error => JSON.parse(error.message).status === 400);
    assert.equal(handle.rev, rev);
    assert.deepEqual(fs.readFileSync(handle.store.commitsFile), before, 'invalid raw args leave the log byte-identical');
  }
  const response = { writeHead() {}, end() {} };
  for (const patch of [{ requiresHumanReview: true }, { labels: ['gate:human'] }]) {
    const body = { op: 'task.create', title: 'bad HTTP', acceptance: [{ text: 'record' }], ...patch };
    await assert.rejects(commandsRoute(Readable.from([Buffer.from(JSON.stringify(body))]), response, handle.id, service, webAuthority), { code: 'invalid-command', status: 400 });
    assert.equal(handle.rev, rev);
    assert.deepEqual(fs.readFileSync(handle.store.commitsFile), before, 'HTTP preserves unknown intent for core rejection');
  }
});

// 责任：角色错误须保留子错误码及可执行 NEXT，服务端给出的 NEXT 优先。
test('role errors preserve subcodes and actionable NEXT; server NEXT takes precedence', () => {
  for (const reason of ['auditor-required', 'not-independent', 'worker-unknown', 'review-gate-locked', 'unassign-human-only', 'drift-human-only']) {
    const value = JSON.parse(fail(new BoardError('forbidden-role', reason, { status: 403, details: { reason } })).message);
    assert.equal(value.details.reason, reason);
    assert.ok(value.next.length > 30);
    assert.doesNotMatch(value.next, /human or verifier/);
  }
  assert.equal(JSON.parse(fail(new BoardError('forbidden-role', 'x', { details: { next: 'explicit next' } })).message).next, 'explicit next');
});

// 责任：摘要须区分 agent 自述验收与人工验收，同输入渲染保持确定性。
test('audit summaries distinguish self-declared agent and human acceptance, deterministically', () => {
  const task = { id: 'tsk_synthetic', rev: 3, title: 'fixture', state: 'done', requiresAudit: true, acceptance: [], lastAudit: { by: { kind: 'agent', sessionId: 'auditor' }, at: '2026-01-01T00:00:00Z', verdict: 'pass', report: audit.report, checklist: audit.checklist, evidence: { count: 1, digest: 'sha256:fixture' }, warnings: [{ code: 'git-unavailable', message: 'not observable' }] } };
  const text = taskSummary({ task });
  assert.match(text, /audit=1/); assert.match(text, /by.kind=agent/); assert.match(text, /AI审计（自述）/); assert.match(text, /sha256:fixture/); assert.match(text, /not observable/);
  assert.doesNotMatch(text, /已人审|已核验/);
  const card = { ...task, acceptance: { total: 1, met: 1 } };
  assert.match(boardSummary({ project: { name: 'fixture' }, columns: { done: [card] } }), /AI审计（自述）/);
  const brief = { project: { name: 'fixture' }, rev: 3, next: [card], delivery: { verified: [{ ...card, taskId: task.id, seq: 3 }] } };
  assert.equal(buildDigest(brief, 's'), buildDigest(brief, 's'));
  assert.match(buildDigest(brief, 's'), /lastAudit=pass by.kind=agent AI审计（自述）/);
});

// 责任：HTTP 命令身份来自已鉴权能力，伪造 actor 不影响归因，可选审计字段仍被转发。
test('HTTP commands use the authenticated web actor and keep optional report/flags', async () => {
  const payload = { op: 'task.verify', taskId: 'tsk_synthetic', expected: { entityRev: 3 }, audit, actor: { kind: 'agent', sessionId: 'spoof' }, refreshDrift: true, reason: 'human-reviewed' };
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  let captured;
  const res = { writeHead() {}, end() {} };
  await commandsRoute(req, res, 'prj_synthetic', { command: async (projectId, cmd) => {
    assert.equal(projectId, 'prj_synthetic');
    captured = cmd;
    return { ok: true };
  } }, webAuthority);
  assert.deepEqual(captured.audit, audit);
  assert.deepEqual(captured.actor, { kind: 'human', via: 'web' });
  assert.equal(captured.refreshDrift, true);
  const noReport = Readable.from([Buffer.from(JSON.stringify({ op: 'task.verify', taskId: 'tsk_synthetic' }))]);
  await commandsRoute(noReport, res, 'prj_synthetic', { command: async (_projectId, cmd) => { assert.equal(cmd.audit, undefined); return { ok: true }; } }, webAuthority);
});

// 责任：没有已鉴权的能力或只传身份形状时，任一网页写处理器都须拒绝。
test('web writes reject absent or forged in-process authority before dispatch', async () => {
  const denied = { code: 'forbidden-role', status: 403 };
  const req = { method: 'POST', on() { assert.fail('body parsing requires authority'); } };
  const service = {
    command() { assert.fail('no command without authority'); },
    createProject() { assert.fail('no project creation without authority'); },
  };
  const prepared = { action: 'register', body: { title: 'Test', relPath: 'spec.md' } };
  for (const authority of [undefined, { kind: 'human', via: 'web' }, Symbol('ProjectBoard web authority')]) {
    await assert.rejects(commandsRoute(req, {}, 'prj_synthetic', service, authority), denied);
    await assert.rejects(projectsRoute(req, {}, { service }, 'POST', authority), denied);
    await assert.rejects(externalDocsRoute(req, {}, null, [], service, { prepared, authority }), denied);
  }
  const emptyToken = authorizeWebRequest({ headers: { 'x-project-board-token': '' } }, '');
  assert.deepEqual(emptyToken, { denial: 'token-mismatch' });
});

// Load the host prompt implementation through the same discovery path the
// installer uses, so this stays a real compatibility check without hardcoding
// a machine-specific installation directory.
async function hostPrompt() {
  const host = discoverHost();
  const require = createRequire(host.manifest);
  const [cordis, systemPrompt] = await Promise.all([
    import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href),
  ]);
  return { Context: cordis.Context, SystemPrompt: systemPrompt.default, renderPrompt: systemPrompt.renderPrompt };
}

const HOST_SENTINEL = 'HOST-VAR-SECRET-3d7a';
const templateText = '{{unknown_var}} {{sentinel}} {{Bad-Name}} {{}} {{name}} {{unclosed';
const boardText = '{{unknown_var}} {{sentinel}} {{Bad-Name}} {{}} {{name}} 中文示例 `{{name}}`';

// 责任：真实宿主组装 Prompt 时 project:brief 必须保持字面文本，其他模板段仍正常求值。
test('real host assemble/render keeps project:brief literal while other sections stay templates', async (t) => {
  const { Context, SystemPrompt, renderPrompt } = await hostPrompt();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-host-prompt-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const service = new ProjectService({ rootDir: path.join(root, 'board') });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.init();

  const name = 'Board ' + templateText + '\u0007' + 'x'.repeat(120);
  const h = await service.createProject({ workspacePath: workspace, name });
  await h.command(command('task.create', { title: 'Task ' + boardText, acceptance: [{ text: 'record' }] }));
  await h.command(command('session.checkpoint', { note: 'checkpoint ' + boardText }));

  const ctx = new Context();
  const prompt = new SystemPrompt(ctx, { includeHarnessIdentity: true, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' });
  prompt.variable('sentinel', () => HOST_SENTINEL);
  prompt.section({ name: 'fixture:other', order: 8999, text: 'HOST SECTION {{sentinel}}' });
  const runtime = { promptFibers: new Map(), sessionProjects: new Map([['agent-1', h]]), ctx: { logger: { warn() {} } } };
  installPrompt(runtime, { id: 'agent-1', ctx });
  assert.ok(runtime.promptFibers.has('agent-1'), 'installPrompt registered a prompt fiber');

  // The host injects the section when the service becomes available, so poll
  // the public assembly surface instead of sleeping for a guessed duration.
  async function assembleWithProject() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const assembly = await prompt.assemble({});
      if (assembly.sections.some((section) => section.name === 'project:brief')) return assembly;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('project:brief was never registered through installPrompt');
  }

  const first = await assembleWithProject();
  const brief = first.sections.find((section) => section.name === 'project:brief');
  assert.ok(brief, 'real host assembly contains project:brief');
  assert.equal(brief.interpolate, false, 'assemble must preserve the literal-text declaration');
  for (const token of ['{{unknown_var}}', '{{sentinel}}', '{{Bad-Name}}', '{{}}', '{{name}}', '{{unclosed', '中文示例', '`{{name}}`']) {
    assert.ok(brief.text.includes(token), 'project brief lost literal token ' + token);
  }
  assert.match(brief.text, /Task \{\{unknown_var\}\} \{\{sentinel\}\}/);
  assert.match(brief.text, /checkpoint \{\{unknown_var\}\} \{\{sentinel\}\}/);
  assert.ok(!brief.text.includes(HOST_SENTINEL), 'a registered host variable value leaked into the project brief');
  assert.doesNotMatch(brief.text, /\u0007/, 'control characters are still cleaned');
  assert.match(brief.text, /…/, 'the project name is still length-limited');

  const rendered = renderPrompt(first);
  assert.match(rendered, /## Project: Board \{\{unknown_var\}\} \{\{sentinel\}\}/);
  assert.doesNotMatch(rendered, new RegExp('Board[^\n]*' + HOST_SENTINEL));
  assert.ok(rendered.includes('HOST SECTION ' + HOST_SENTINEL), 'other sections still interpolate their variables');

  const strict = new SystemPrompt(new Context(), { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' });
  strict.section({ name: 'strict:probe', order: 1, text: '{{unknown_var}}' });
  const strictAssembly = await strict.assemble({});
  assert.throws(() => renderPrompt(strictAssembly), /unknown prompt variable "\{\{unknown_var\}\}"/, 'the host keeps its original template contract for other sections');

  await h.command(command('task.create', { title: 'second task appears', acceptance: [{ text: 'record' }] }));
  const second = await prompt.assemble({});
  const secondBrief = second.sections.find((section) => section.name === 'project:brief');
  assert.notEqual(secondBrief.text, brief.text, 'the digest stays dynamic across assemblies');
  assert.match(secondBrief.text, /second task appears/);
  assert.match(secondBrief.text, /ready 2/);

  h.closed = true;
  const closed = await prompt.assemble({});
  assert.equal(closed.sections.find((section) => section.name === 'project:brief').text, '');
  assert.doesNotMatch(renderPrompt(closed), /## Project:/);
  h.closed = false;

  runtime.sessionProjects.delete('agent-1');
  const empty = await prompt.assemble({});
  assert.equal(empty.sections.find((section) => section.name === 'project:brief').text, '', 'no project yields empty text');
});

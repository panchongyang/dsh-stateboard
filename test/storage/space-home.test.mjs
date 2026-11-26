/**
 * 测试职责：用真实存储和普通业务命令验证按 space 根选库、已留存正文及写入互斥。
 * 典型流程：打开合成 A 写任务和归档正文，冷复制全树到 B，再分别打开和写入。
 * 覆盖边界：覆盖冷开、复制点、命令去重和同根写入保护；不覆盖入口身份签发、外置当前文件或真实迁移。
 * 外部前置：Node、隔离临时目录，不需要宿主、网络或真实看板。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { JsonlStore } from '../../lib/core/store.js';

const human = { kind: 'human', userId: 'synthetic-owner' };
const cmd = (title, cmdId = randomUUID()) => ({ op: 'task.create', title, cmdId, actor: human, acceptance: [{ text: '核对领域回执' }] });
const data = root => path.join(root, '.projectboard', 'state');
const bytes = root => fs.readFileSync(path.join(data(root), 'commits.jsonl'));
const titles = async (board, id) => Object.values((await board.query(id, 'board')).columns).flat().map(t => t.title);
function fixture(t) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-space-store-'))), opened = [];
  const root = name => { const dir = path.join(tmp, name); fs.mkdirSync(dir); return dir; };
  const open = async spaceRoot => { const board = new ProjectService({ spaceRoot }); opened.push(board); await board.init(); return board; };
  t.after(async () => { for (const board of opened.reverse()) await board.close(); });
  return { tmp, root, open };
}

// 责任：完整复制保留日志、历史 ID 和正文，两边同一命令 ID 在各自日志中独立生效。
test('cold copies have the same retained history and separate ordinary writers', async t => {
  const f = fixture(t), A = f.root('A'), B = path.join(f.tmp, 'B');
  const first = await f.open(A); assert.deepEqual(fs.readdirSync(A), []);
  const id = (await first.createProject({ workspacePath: A, actor: human })).id;
  assert.equal((await first.command(id, cmd('common'))).committed, true);
  const rev = (await first.query(id, 'board')).projectRev;
  await first.command(id, { op: 'doc.inline_policy', cmdId: randomUUID(), actor: human, authorized: true, disabled: false, expected: { projectRev: rev } });
  const stored = await first.command(id, { op: 'doc.put', cmdId: randomUUID(), actor: human, title: 'saved', kind: 'note', body: 'saved before copy' });
  const docId = stored.events.find(e => e.type.startsWith('doc/') && e.data?.id).data.id;
  await first.close(); const ancestor = bytes(A); fs.cpSync(A, B, { recursive: true, errorOnExist: true, force: false });
  const a = await f.open(A), b = await f.open(B); assert.equal(b.resolveWorkspace(B)?.projectId, id);
  assert.deepEqual(bytes(B), ancestor); assert.deepEqual(await titles(b, id), ['common']);
  assert.equal((await b.query(id, 'doc', { docId })).body, 'saved before copy');
  assert.equal(fs.existsSync(path.join(data(B), 'lock.json')), false);
  const key = randomUUID(); assert.equal((await a.command(id, cmd('only-A', key))).committed, true);
  assert.deepEqual(bytes(B), ancestor); const afterA = bytes(A);
  assert.equal((await b.command(id, cmd('only-B', key))).committed, true); assert.deepEqual(bytes(A), afterA);
  assert.deepEqual(new Set(await titles(a, id)), new Set(['common', 'only-A']));
  await b.close(); const cold = await f.open(B); assert.deepEqual(new Set(await titles(cold, id)), new Set(['common', 'only-B']));
  assert.deepEqual(fs.readdirSync(path.join(B, '.projectboard')), ['state']);
});

// 责任：第二个调用方按所属 space 而非外部工作目录开库；复用同一模型和原介质写锁。
test('two callers of the same space share its writer, not the checkout directory', async t => {
  const f = fixture(t), A = f.root('home'), W = f.root('external-worktree');
  fs.writeFileSync(path.join(W, '.git'), 'gitdir: ./untrusted', { flag: 'wx' });
  const a = await f.open(A), id = (await a.createProject({ workspacePath: A, actor: human })).id;
  const fromWorktree = await f.open(A), key = randomUUID();
  await Promise.all([a.command(id, cmd('one', key)), fromWorktree.command(id, cmd('one', key))]);
  assert.equal(a.lookupLiveWriter(id).model, fromWorktree.lookupLiveWriter(id).model);
  assert.deepEqual(await titles(fromWorktree, id), ['one']); assert.deepEqual(fs.readdirSync(W), ['.git']);
  const rival = new JsonlStore(data(A), a.metas.get(id));
  try { assert.throws(() => rival.open({ requireCommitted: true }), { code: 'log-busy' }); } finally { rival.close(); }
  await a.close(); assert.equal((await fromWorktree.command(id, cmd('after close'))).committed, true);
});

// 责任：另一个进程从外部工作目录分别向 A、B 写同一个命令，A 已占用必须拒绝，而 B 独立提交。
test('a separate process in a worktree cannot bypass the home lock but can write its full copy', async t => {
  const f = fixture(t), A = f.root('A'), B = path.join(f.tmp, 'B'), W = f.root('outside');
  const first = await f.open(A), firstCommand = { ...cmd('common'), actor: { kind: 'agent', sessionId: 'native-owner' } };
  const { projectId: id, result } = await first.commandInWorkspace(A, firstCommand, { agentSessionSource: 'tool' });
  assert.equal(result.committed, true); await first.close();
  fs.cpSync(A, B, { recursive: true, force: false, errorOnExist: true });
  const beforeB = bytes(B), holder = await f.open(A);
  await holder.command(id, cmd('A holds the writer')); const beforeA = bytes(A);
  const command = cmd('independent ordinary write');
  const child =     `const { ProjectService } = await import(process.argv[1]);
    const result = [];
    for (const spaceRoot of process.argv.slice(2, 4)) {
      const board = new ProjectService({ spaceRoot });
      try { await board.init(); const receipt = await board.command(process.argv[4], JSON.parse(process.argv[5])); result.push({ committed: receipt.committed }); }
      catch (error) { result.push({ code: error.code }); }
      finally { await board.close(); }
    }
    process.stdout.write(JSON.stringify(result));`;
  const env = { HOME: f.tmp, USERPROFILE: f.tmp, DSH_HOME: f.tmp, DSH_AGENTS_HOME: f.tmp, TEMP: f.tmp, TMP: f.tmp, TMPDIR: f.tmp };
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive']) if (process.env[key]) env[key] = process.env[key];
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', child,
    new URL('../../lib/core/service.js', import.meta.url).href, A, B, id, JSON.stringify(command)], { cwd: W, env, timeout: 15000, encoding: 'utf8' });
  assert.ifError(p.error); assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout), [{ code: 'read-only' }, { committed: true }]);
  assert.deepEqual(bytes(A), beforeA); assert.ok(bytes(B).subarray(0, beforeB.length).equals(beforeB)); assert.deepEqual(fs.readdirSync(W), []);
  const b = await f.open(B); assert.deepEqual(new Set(await titles(b, id)), new Set(['common', command.title]));
  assert.equal((await holder.command(id, command)).committed, true, '拒绝写入不消耗 A 的命令 ID');
});

// 责任：只有源码没有库时读取不能造历史；缺了日志的已占用空间和错项目请求均须失败且保留字节。
test('reading an uninitialized checkout or incomplete home cannot create or select other history', async t => {
  const f = fixture(t), empty = f.root('checkout'), partial = f.root('partial'), A = f.root('actual');
  const a = await f.open(A), id = (await a.createProject({ workspacePath: A, actor: human })).id;
  fs.writeFileSync(path.join(empty, 'README.txt'), 'synthetic checkout without state', { flag: 'wx' });
  const noBoard = await f.open(empty); assert.deepEqual(await noBoard.listProjectsAsync(), []);
  assert.equal(noBoard.resolveWorkspace(empty), null); await assert.rejects(noBoard.query(id, 'board'), { code: 'not-found' });
  assert.deepEqual(fs.readdirSync(empty), ['README.txt']);
  const before = bytes(A); await assert.rejects(a.command('prj_0000000000000000', cmd('wrong project')), { code: 'not-found' });
  assert.deepEqual(bytes(A), before);
  fs.mkdirSync(data(partial), { recursive: true }); const meta = path.join(data(partial), 'meta.json');
  fs.copyFileSync(path.join(data(A), 'meta.json'), meta, fs.constants.COPYFILE_EXCL); const preserved = fs.readFileSync(meta);
  await assert.rejects(f.open(partial), { code: 'space-home-unavailable' });
  assert.deepEqual(fs.readdirSync(data(partial)), ['meta.json']); assert.deepEqual(fs.readFileSync(meta), preserved);
});

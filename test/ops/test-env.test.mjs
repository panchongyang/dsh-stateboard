/**
 * 测试职责：约束独立测试环境的目录所有权、环境隔离、监督进程及安全停止/重置。
 * 典型流程：临时源码/profile 和 mock 子进程/控制端 → prepare/run/status/stop/reset → 对照拒绝与数据轮换。
 * 覆盖边界：覆盖 链接/标记防伪、回环控制身份及 lifecycle 互斥；不覆盖真实 DSH 服务或生产 PID。
 * 外部前置：需要目录链接与回环临时端口能力；子进程由内存 mock 模拟。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createEnvironment, prepareEnvironment, assertOwned, childEnvironment, resetEnvironment,
  readRuntime, writeJson, withStoppedEnvironment } from '../../scripts/test-env/environment.mjs';
import { runEnvironment, statusEnvironment, stopEnvironment } from '../../scripts/test-env/lifecycle.mjs';
import { parseArguments } from '../../scripts/test-env.mjs';

function fixture(t) {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-test-env-')));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const cliPath = path.join(repoRoot, 'installed', 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, '// offline fixture; never executed\n');
  fs.writeFileSync(path.join(repoRoot, 'installed', 'package.json'), '{"version":"fixture"}');
  fs.mkdirSync(path.join(repoRoot, 'lib'));
  fs.writeFileSync(path.join(repoRoot, 'lib', 'client.js'), '// fixture\n');
  return createEnvironment({ repoRoot, cliPath });
}

function runningState(env, overrides = {}) {
  const marker = assertOwned(env);
  return { kind: 'project-board-test-supervisor', root: env.root, owner: marker.owner,
    nonce: 'expected-nonce', phase: 'running', supervisorPid: 123456, childPid: 40784,
    controlUrl: 'http://127.0.0.1:1/', controlToken: 'a'.repeat(64), ...overrides };
}

async function fakeController(t, env, transform = (value) => value) {
  let stopRequests = 0;
  let state;
  const server = http.createServer((request, response) => {
    if (request.method === 'POST') stopRequests++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(transform(state)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  state = runningState(env, { controlUrl: 'http://127.0.0.1:' + server.address().port + '/' });
  writeJson(env.runtimeFile, state);
  return { state, get stopRequests() { return stopRequests; } };
}

// 责任：prepare 只建隔离根和最小 web profile/分支插件链接，不能复制密钥、配置或真实会话。
test('prepare creates only isolated roots, a minimal web profile and the branch plugin link', async (t) => {
  const env = fixture(t);
  fs.writeFileSync(path.join(env.repoRoot, '.env'), 'MODEL_SECRET=must-not-copy');
  await prepareEnvironment(env);
  const owner = assertOwned(env);
  assert.equal(owner.root, env.root);
  assert.equal(owner.repoRoot, env.repoRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(env.profile, 'package.json')));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-project-board']);
  assert.equal(fs.realpathSync(path.join(env.profile, 'node_modules', 'dsh-project-board')), env.repoRoot);
  assert.match(fs.readFileSync(path.join(env.profile, 'cordis.patch.yml'), 'utf8'), /rootDir:/);
  assert.equal(fs.existsSync(path.join(env.home, '.env')), false);
  assert.equal(fs.existsSync(path.join(env.home, '.credentials.yaml')), false);
  assert.equal(fs.existsSync(path.join(env.workspace, '.env')), false);
  assert.equal(fs.existsSync(path.join(env.home, 'sessions')), false);
  await prepareEnvironment(env);
  assert.equal(assertOwned(env).owner, owner.owner);
  assert.equal((await statusEnvironment(env)).phase, 'prepared');
});

// 责任：child env 须大小写无关白名单并重定向所有 HOME，不能继承模型密钥或宿主身份。
test('child env is a case-insensitive system whitelist with isolated homes and no inherited identity', async (t) => {
  const env = fixture(t);
  const actual = childEnvironment(env, { SystemRoot: 'C:/Windows', Path: 'system-path', DSH_HOME: 'production',
    dsh_agents_home: 'production-agents', DSH_WEB_URL: 'production-url', OPENAI_API_KEY: 'secret',
    DEEPSEEK_API_KEY: 'secret', CODEX_HOME: 'production-codex', NODE_OPTIONS: '--require malicious',
    PB_COMMAND_EVIDENCE: 'on', HOME: 'production-user', USERPROFILE: 'production-user', RANDOM_SECRET: 'secret' });
  assert.equal(actual.SystemRoot, 'C:/Windows');
  assert.equal(actual.Path, 'system-path');
  assert.equal(actual.DSH_HOME, env.home);
  assert.equal(actual.DSH_AGENTS_HOME, env.agents);
  assert.equal(actual.HOME, env.userHome);
  assert.equal(actual.USERPROFILE, env.userHome);
  assert.equal(actual.PB_COMMAND_EVIDENCE, 'off');
  for (const key of ['DSH_WEB_URL', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'CODEX_HOME', 'NODE_OPTIONS', 'RANDOM_SECRET', 'dsh_agents_home']) {
    assert.equal(Object.hasOwn(actual, key), false, key);
  }
});

// 责任：启动须显式选定 CLI。任意根、生产端口或未知参数必须拒绝。
test('CLI requires an explicit host executable and rejects arbitrary roots and production ports', () => {
  assert.throws(() => parseArguments(['reset', '--root', 'D:/production']), /no --root/);
  assert.throws(() => parseArguments(['run', '--port', '3080']), /production/);
  assert.throws(() => parseArguments(['run', '--port', '-1']), /unsupported/);
  assert.throws(() => parseArguments(['run', '--port', '65536']), /invalid/);
  assert.throws(() => parseArguments(['run', '--port', '0']), /requires --cli/);
  assert.throws(() => parseArguments(['run', '--cli', '--port', '0']), /unsupported/);
  assert.throws(() => parseArguments(['prepare', '--cli', 'fixture/bin.js']), /unsupported/);
  assert.deepEqual(parseArguments(['run', '--port', '0', '--cli', 'fixture with spaces/lib/bin.js']),
    { command: 'run', port: 0, cliPath: 'fixture with spaces/lib/bin.js' });
  assert.deepEqual(parseArguments(['start', '--cli', 'fixture/lib/bin.js']),
    { command: 'start', port: 3081, cliPath: 'fixture/lib/bin.js' });
  assert.equal(parseArguments(['prepare']).cliPath, undefined);
  assert.throws(() => createEnvironment({ runtimeRoot: 'D:/production' }), /repo\/\.test-env/);
});

// 责任：无所有权标记的既有目录或伪造 marker 不得被自动接管。
test('existing unmarked directories and forged markers are never adopted', async (t) => {
  const env = fixture(t);
  fs.mkdirSync(env.root);
  fs.writeFileSync(path.join(env.root, 'keep'), 'untouched');
  await assert.rejects(prepareEnvironment(env), /owner marker/);
  assert.equal(fs.readFileSync(path.join(env.root, 'keep'), 'utf8'), 'untouched');
  writeJson(env.markerFile, { kind: 'project-board-test-env', schema: 1, owner: 'a'.repeat(36), root: env.repoRoot, repoRoot: env.repoRoot });
  assert.throws(() => assertOwned(env), /mismatch/);
});

// 责任：runtime 根或托管目录是 symlink 时必须拒绝，不能跟随到真实数据。
test('runtime root and managed directory symlinks are refused', async (t) => {
  const env = fixture(t);
  const external = path.join(env.repoRoot, 'external');
  fs.mkdirSync(external);
  fs.symlinkSync(external, env.root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareEnvironment(env), /symbolic link/);
  fs.unlinkSync(env.root);
  await prepareEnvironment(env);
  fs.rmdirSync(env.board);
  fs.symlinkSync(external, env.board, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertOwned(env), /symbolic link/);
  await assert.rejects(resetEnvironment(env), /symbolic link/);
});

// 责任：home 内嵌凭据/配置链接须拒绝且原文件不能被覆盖。
test('nested home credential/config links are rejected and never overwritten', async (t) => {
  const env = fixture(t);
  await prepareEnvironment(env);
  const external = path.join(env.repoRoot, 'external-home');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'keep'), 'untouched');
  fs.symlinkSync(external, path.join(env.home, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertOwned(env), /symbolic link/);
  await assert.rejects(prepareEnvironment(env), /symbolic link/);
  assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'untouched');
});

// 责任：未知 PID 或控制端不可达须保持 stale，不能据存储 PID 杀进程。
test('unknown PIDs and unreachable control endpoints stay stale and are never killed', async (t) => {
  const env = fixture(t);
  await prepareEnvironment(env);
  writeJson(env.runtimeFile, runningState(env));
  assert.equal((await statusEnvironment(env)).phase, 'stale');
  await assert.rejects(stopEnvironment(env), /ECONNREFUSED/);
  assert.equal(readRuntime(env).childPid, 40784);
  await assert.rejects(resetEnvironment(env), /not confirmed stopped/);
});

// 责任：控制身份不匹配时不能发送 stop 请求。
test('mismatched control identity never receives a stop request', async (t) => {
  const env = fixture(t);
  await prepareEnvironment(env);
  const control = await fakeController(t, env, (state) => ({ ...state, nonce: 'wrong-instance' }));
  assert.equal((await statusEnvironment(env)).phase, 'stale');
  await assert.rejects(stopEnvironment(env), /identity mismatch/);
  assert.equal(control.stopRequests, 0);
});

// 责任：非回环或带凭据控制 URL 不能被访问，避免 SSRF 或凭据泄漏。
test('non-loopback or credential-bearing control URLs are not contacted', async (t) => {
  const env = fixture(t);
  await prepareEnvironment(env);
  for (const controlUrl of ['http://example.com:80/', 'http://user:password@127.0.0.1:1234/']) {
    writeJson(env.runtimeFile, runningState(env, { controlUrl }));
    await assert.rejects(stopEnvironment(env), /unsafe control/);
  }
});

// 责任：活动/stale 锁须阻止 reset；确认 stopped 后仅轮换 board/workspace。
test('reset refuses active/stale locks and rotates only board/workspace after stopped', async (t) => {
  const env = fixture(t);
  await prepareEnvironment(env);
  fs.writeFileSync(path.join(env.board, 'test-board'), 'board');
  fs.writeFileSync(path.join(env.workspace, 'test-work'), 'workspace');
  fs.writeFileSync(path.join(env.home, 'keep'), 'keep');
  writeJson(env.runtimeFile, runningState(env));
  await assert.rejects(resetEnvironment(env), /not confirmed stopped/);
  writeJson(env.runtimeFile, runningState(env, { phase: 'stopped' }));
  fs.writeFileSync(env.lockFile, 'stale unknown owner');
  await assert.rejects(resetEnvironment(env), /stale lifecycle lock/);
  fs.unlinkSync(env.lockFile);
  const { backup } = await resetEnvironment(env);
  assert.equal(path.dirname(backup), path.join(env.root, 'backups'));
  assert.equal(fs.readFileSync(path.join(backup, 'board', 'test-board'), 'utf8'), 'board');
  assert.equal(fs.readFileSync(path.join(backup, 'workspace', 'test-work'), 'utf8'), 'workspace');
  assert.equal(fs.readFileSync(path.join(env.home, 'keep'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(env.board), []);
  assert.deepEqual(fs.readdirSync(env.workspace), []);
});

// 责任：数据树内部 symlink 须在任何轮换前拒绝，避免部分重置。
test('reset rejects nested data symlinks before rotating anything', async (t) => {
  const env = fixture(t);
  await prepareEnvironment(env);
  fs.symlinkSync(env.home, path.join(env.board, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resetEnvironment(env), /symbolic link/);
  assert.equal(fs.existsSync(path.join(env.root, 'backups')), false);
});

// 责任：stopped 操作锁须让 seed 与生命周期操作串行，不能并行改 fixture。
test('stopped operation lock serializes fixture seeding against lifecycle operations', async (t) => {
  const env = fixture(t);
  await prepareEnvironment(env);
  await withStoppedEnvironment(env, async () => {
    await assert.rejects(prepareEnvironment(env), /busy/);
    await assert.rejects(resetEnvironment(env), /busy/);
  });
  assert.equal(fs.existsSync(env.lockFile), false);
});

// 责任：前台 supervisor 只拥有一个 mock child，认证 stop 不得按历史 PID 杀进程。
test('foreground supervisor owns one mock child and authenticated stop never uses stored PID', async (t) => {
  const env = fixture(t);
  await prepareEnvironment(env);
  let spawnOptions;
  let childArguments;
  let kills = 0;
  const child = new EventEmitter();
  Object.assign(child, { pid: 654321, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = (signal) => {
    assert.equal(signal, 'SIGTERM'); kills++;
    // Windows can report raw exit 1 for a requested SIGTERM; it is not a startup failure.
    setImmediate(() => { child.exitCode = 1; child.stdout.end(); child.stderr.end(); child.emit('close', 1, null); });
    return true;
  };
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const output = [];
  const running = runEnvironment(env, { port: 0,
    inspectVersion: () => ({ dshVersion: 'fixture', commit: 'fixture-commit' }),
    output: (line) => { output.push(line); if (line.includes('[test-env] ready')) ready(); },
    spawnChild: (_command, args, options) => {
      childArguments = args; spawnOptions = options;
      setImmediate(() => child.stdout.write('dsh web: http://127.0.0.1:54321/?token=synthetic-test-token\n'));
      return child;
    },
  });
  await readyPromise;
  const status = await statusEnvironment(env);
  assert.equal(status.phase, 'running');
  assert.equal(status.commit, 'fixture-commit');
  assert.equal(status.dshVersion, 'fixture');
  assert.equal(Number.isInteger(status.startupMs), true);
  assert.ok(status.startupMs >= 0);
  const firstReady = readRuntime(env);
  assert.ok(Date.parse(firstReady.readyAt) >= Date.parse(firstReady.startedAt));
  child.stdout.write('dsh web: http://127.0.0.1:54321/?token=synthetic-test-token\n');
  assert.equal(readRuntime(env).readyAt, firstReady.readyAt);
  assert.equal(readRuntime(env).startupMs, firstReady.startupMs);
  assert.equal(Object.hasOwn(status, 'authUrl'), false);
  assert.equal(Object.hasOwn(status, 'controlToken'), false);
  assert.equal(spawnOptions.cwd, env.workspace);
  assert.equal(spawnOptions.env.DSH_HOME, env.home);
  assert.ok(childArguments.includes('--no-open'));
  assert.ok(childArguments.includes('0'));
  assert.equal(output.some((line) => line.includes('synthetic-test-token')), false);
  assert.match(readRuntime(env).authUrl, /synthetic-test-token/);
  await assert.rejects(resetEnvironment(env), /busy/);
  await assert.rejects(prepareEnvironment(env), /busy/);
  const stop = await stopEnvironment(env);
  assert.equal(stop.phase, 'stopped');
  assert.equal(await running, 0);
  assert.equal(kills, 1);
  const stopped = await statusEnvironment(env);
  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.exitCode, 0);
  assert.equal(stopped.childExitCode, 1);
  assert.equal(stopped.stopRequested, true);
  assert.equal(fs.existsSync(env.lockFile), false);
});

// 责任：子进程未经请求启动失败须保持非零，不能伪标为正常 requested stop。
test('an unsolicited child startup failure remains nonzero and is not labeled a requested stop', async (t) => {
  const env = fixture(t);
  await prepareEnvironment(env);
  const child = new EventEmitter();
  Object.assign(child, { pid: 654322, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => { throw new Error('unexpected kill for an already-exited child'); };
  const code = await runEnvironment(env, {
    inspectVersion: () => ({ dshVersion: 'fixture', commit: 'fixture-commit' }), output: () => {},
    spawnChild: () => {
      setImmediate(() => { child.exitCode = 7; child.stdout.end(); child.stderr.end(); child.emit('close', 7, null); });
      return child;
    },
  });
  assert.equal(code, 7);
  const stopped = await statusEnvironment(env);
  assert.equal(stopped.exitCode, 7);
  assert.equal(stopped.childExitCode, 7);
  assert.equal(stopped.stopRequested, false);
  assert.equal(fs.existsSync(env.lockFile), false);
});

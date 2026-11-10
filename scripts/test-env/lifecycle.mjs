import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { assertOwned, assertNoLinks, childEnvironment, readRuntime, TEST_PLUGIN_PACKAGE, withStoppedEnvironment, writeJson } from './environment.mjs';
import { findRepository, resolveGitExecutable } from '../../lib/core/git-exec.js';

const IDENTITY = 'project-board-test-supervisor';

function sameSecret(left, right) {
  const a = Buffer.from(left ?? '');
  const b = Buffer.from(right ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

function matchesIdentity(actual, expected) {
  return actual?.kind === IDENTITY && actual.root === expected.root && actual.owner === expected.owner
    && actual.nonce === expected.nonce && actual.supervisorPid === expected.supervisorPid;
}

function validateControl(state) {
  const url = new URL(state.controlUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
    || url.username || url.password || url.search || url.hash || typeof state.controlToken !== 'string'
    || state.controlToken.length !== 64) throw new Error('unsafe control endpoint');
  return url;
}

function callControl(state, route, method = 'GET', timeout = 2000) {
  const url = new URL(route, validateControl(state));
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers: { authorization: 'Bearer ' + state.controlToken } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16384) response.destroy(new Error('oversized control response'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('control request rejected');
          resolve(JSON.parse(body));
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(timeout, () => request.destroy(new Error('control request timed out')));
    request.end();
  });
}

function publicMetadata(state) {
  return { commit: state.commit, dshVersion: state.dshVersion, startupMs: state.startupMs };
}

export async function statusEnvironment(env) {
  const state = readRuntime(env);
  if (!state) return { phase: fs.existsSync(env.lockFile) ? 'stale' : 'prepared', root: env.root };
  if (state.phase === 'stopped') return { phase: fs.existsSync(env.lockFile) ? 'busy' : 'stopped', root: env.root,
    url: state.url, exitCode: state.exitCode, childExitCode: state.childExitCode,
    stopRequested: state.stopRequested === true, ...publicMetadata(state) };
  try {
    const identity = await callControl(state, '/identity');
    if (!matchesIdentity(identity, state)) throw new Error('control identity mismatch');
    return { phase: identity.phase, root: env.root, url: identity.url, childPid: identity.childPid,
      supervisorPid: identity.supervisorPid, ...publicMetadata(identity) };
  } catch (error) {
    return { phase: 'stale', root: env.root, reason: error.message };
  }
}

export async function stopEnvironment(env) {
  const state = readRuntime(env);
  if (!state || state.phase === 'stopped') return statusEnvironment(env);
  const identity = await callControl(state, '/identity');
  if (!matchesIdentity(identity, state)) throw new Error('control identity mismatch; no stop request sent');
  const result = await callControl(state, '/stop', 'POST', 15000);
  if (!matchesIdentity(result, state)) throw new Error('stop response identity mismatch');
  return { phase: result.phase, root: env.root, url: result.url };
}

function headCommit(env) {
  let repository;
  try { repository = findRepository(env.repoRoot); } catch { return 'unknown'; }
  if (!repository) return 'unknown';
  let executable;
  try { executable = resolveGitExecutable([env.repoRoot, ...repository.roots]); } catch { return 'unknown'; }
  const git = spawnSync(executable, ['rev-parse', 'HEAD'], { cwd: env.repoRoot, encoding: 'utf8', env: childEnvironment(env), windowsHide: true });
  return git.status === 0 ? git.stdout.trim() : 'unknown';
}

export function versionInfo(env) {
  const cliPackage = JSON.parse(fs.readFileSync(path.resolve(env.cliPath, '../../package.json'), 'utf8'));
  const result = spawnSync(process.execPath, ['--version'], { encoding: 'utf8', env: childEnvironment(env) });
  return { dshVersion: cliPackage.version, nodeVersion: result.stdout?.trim(), commit: headCommit(env) };
}

function validatePrepared(env) {
  assertOwned(env);
  if (!env.cliPath || !fs.existsSync(env.cliPath)) throw new Error('installed DSH CLI not found; pass --cli <path>');
  const link = path.join(env.profile, 'node_modules', TEST_PLUGIN_PACKAGE);
  if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() || fs.realpathSync(link) !== env.repoRoot) {
    throw new Error('prepared plugin link missing or mismatched');
  }
  for (const key of ['workspace', 'home', 'agents', 'board', 'logs', 'temp', 'userHome']) {
    if (!fs.statSync(env[key]).isDirectory()) throw new Error('prepare first: ' + key);
  }
  if (!fs.existsSync(path.join(env.repoRoot, 'lib', 'client.js'))) throw new Error('branch client artifact missing; build explicitly first');
}

function controller(state, stopChild) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    if (!sameSecret(request.headers.authorization, 'Bearer ' + state.controlToken)) {
      response.writeHead(403).end('{}'); return;
    }
    const identity = () => ({ kind: IDENTITY, root: state.root, owner: state.owner, nonce: state.nonce,
      supervisorPid: state.supervisorPid, childPid: state.childPid, phase: state.phase, url: state.url,
      ...publicMetadata(state) });
    if (request.method === 'GET' && request.url === '/identity') response.end(JSON.stringify(identity()));
    else if (request.method === 'POST' && request.url === '/stop') {
      try { await stopChild(); response.end(JSON.stringify(identity())); }
      catch { response.writeHead(503).end('{}'); }
    } else response.writeHead(404).end('{}');
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return server;
}

function captureOutput(env, state, child, save, output, started) {
  const logFile = path.join(env.logs, 'dsh.log');
  assertNoLinks(logFile);
  const log = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
  let logError;
  log.on('error', (error) => {
    logError = error;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  let pending = '';
  const consume = (chunk) => {
    const text = chunk.toString();
    log.write(text);
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop().slice(-16384);
    for (const line of lines) {
      const match = line.match(/dsh web:\s+(https?:\/\/[^\s]+)/);
      if (!match) continue;
      try {
        const url = new URL(match[1]);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) continue;
        state.authUrl = url.href;
        url.search = ''; url.hash = '';
        state.url = url.href; state.phase = 'running';
        if (state.readyAt === undefined) {
          state.readyAt = new Date().toISOString();
          state.startupMs = Math.max(0, Math.round(performance.now() - started));
        }
        save();
        output('[test-env] ready ' + state.url + ' (private authentication URL stored in runtime state)');
      } catch { /* Non-URL diagnostics are retained only in the private log. */ }
    }
  };
  child.stdout?.on('data', consume);
  child.stderr?.on('data', consume);
  return () => new Promise((resolve, reject) => {
    if (logError) { reject(logError); return; }
    log.once('error', reject);
    log.end(() => logError ? reject(logError) : resolve());
  });
}

export async function runEnvironment(env, { port = 3081, spawnChild = spawn, output = console.log, inspectVersion = versionInfo } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || port === 3080) throw new Error('invalid/production port refused');
  validatePrepared(env);
  return withStoppedEnvironment(env, async () => {
    const marker = assertOwned(env);
    const state = { kind: IDENTITY, root: env.root, owner: marker.owner, nonce: randomUUID(), phase: 'starting',
      supervisorPid: process.pid, controlToken: randomBytes(32).toString('hex'), ...inspectVersion(env) };
    const save = () => writeJson(env.runtimeFile, state);
    let child;
    let closed;
    let stopping;
    const stopChild = (requested = true) => {
      if (requested) state.stopRequested = true;
      return stopping ??= (async () => {
        state.phase = 'stopping'; save();
        // The only kill target is the live ChildProcess handle created by this supervisor.
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const escalation = setTimeout(() => {
          if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 6000);
        escalation.unref();
        try { await closed; } finally { clearTimeout(escalation); }
      })();
    };
    const server = controller(state, stopChild);
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    state.controlUrl = 'http://127.0.0.1:' + server.address().port + '/';
    save();
    let finishLog = async () => {};
    const onSignal = () => { void stopChild(); };
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    try {
      output('[test-env] ' + JSON.stringify({ root: env.root, home: env.home, agents: env.agents,
        workspace: env.workspace, board: env.board, plugin: env.repoRoot, dshVersion: state.dshVersion, commit: state.commit }));
      state.startedAt = new Date().toISOString();
      const started = performance.now();
      child = spawnChild(process.execPath, [env.cliPath, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
        cwd: env.workspace, env: childEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      state.childPid = child.pid; save();
      closed = new Promise((resolve) => {
        child.once('error', () => { state.spawnError = true; });
        child.once('close', (code, signal) => {
          state.childExitCode = code;
          state.exitCode = state.stopRequested === true ? 0 : code ?? 1;
          state.signal = signal;
          resolve();
        });
      });
      finishLog = captureOutput(env, state, child, save, output, started);
      await closed;
    } finally {
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
      if (child && child.exitCode === null && child.signalCode === null) await stopChild(false);
      state.phase = 'stopped';
      const errors = [];
      try { save(); } catch (error) { errors.push(error); }
      try { await finishLog(); } catch (error) { errors.push(error); }
      await new Promise((resolve) => server.close(resolve));
      if (errors.length) throw new AggregateError(errors, 'test supervisor cleanup failed');
    }
    output('[test-env] stopped (exit ' + state.exitCode + ')');
    return state.exitCode ?? 1;
  });
}

#!/usr/bin/env node
// HTTP/data-plane verification only: no browser automation or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createEnvironment, readRuntime, TEST_PLUGIN_PACKAGE } from './test-env/environment.mjs';
import { statusEnvironment } from './test-env/lifecycle.mjs';

export function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.port === '3080' || url.username || url.password) {
    throw new Error('verification only permits the independent loopback test instance');
  }
  return url;
}

export function injectedGlobal(html, name) {
  const prefix = 'globalThis[' + JSON.stringify(name) + '] = ';
  const at = html.indexOf(prefix);
  if (at < 0) throw new Error('missing index injection: ' + name);
  const end = html.indexOf('</script>', at);
  if (end < 0) throw new Error('unterminated index injection: ' + name);
  return JSON.parse(html.slice(at + prefix.length, end).trim().replace(/;$/, ''));
}

function scriptUrls(html, base) {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
    .map((match) => new URL(match[1].replaceAll('&amp;', '&'), base));
}

async function request(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
}

export async function verifyEnvironment(env = createEnvironment()) {
  const status = await statusEnvironment(env);
  assert.equal(status.phase, 'running', 'test instance must be ready');
  const state = readRuntime(env);
  const base = localUrl(state.url);
  const auth = localUrl(state.authUrl);
  assert.equal(auth.origin, base.origin, 'authentication URL cannot point at another instance');
  const anonymous = await request(base);
  assert.ok([401, 403].includes(anonymous.status), 'anonymous index must be refused');
  const login = await request(auth);
  assert.ok([200, 302, 303, 307].includes(login.status), 'launch authentication must succeed');
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'launch URL must mint a cookie');
  const redirected = login.headers.get('location');
  if (redirected) assert.equal(new URL(redirected, base).origin, base.origin, 'login redirect stays on test instance');
  const page = await request(base, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  const boot = injectedGlobal(html, '__DSH_BOOT__');
  assert.ok(boot && typeof boot === 'object', 'full DSH boot payload, not a standalone Vite shell');
  const board = injectedGlobal(html, '__PROJECT_BOARD__');
  assert.equal(board.base, '/project-board/api');
  assert.ok(typeof board.token === 'string' && board.token.length > 16);
  const apiBase = new URL(board.base + '/', base);
  const forbidden = await request(new URL('ping', apiBase), { headers: { cookie } });
  assert.ok([401, 403].includes(forbidden.status), 'DSH cookie alone is not ProjectBoard authorization');
  const headers = { cookie, 'x-project-board-token': board.token };
  const ping = await request(new URL('ping', apiBase), { headers });
  assert.equal(ping.status, 200);
  assert.equal((await ping.json()).name, 'project-board');
  const projectsResponse = await request(new URL('projects', apiBase), { headers });
  assert.equal(projectsResponse.status, 200);
  const projects = (await projectsResponse.json()).projects;
  assert.ok(Array.isArray(projects));
  for (const project of projects) {
    const relative = path.relative(env.workspace, project.workspacePath);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), 'all sample projects must stay in disposable workspace');
  }
  let fixture = null;
  const fixtureFile = path.join(env.root, 'fixture.json');
  if (fs.existsSync(fixtureFile)) {
    fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    assert.ok(projects.some((project) => project.id === fixture.projectId), 'seeded project is visible through real HTTP');
    const response = await request(new URL('projects/' + fixture.projectId + '/board', apiBase), { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  const entries = Array.isArray(boot.entries) ? boot.entries : [];
  const boardEntry = entries.find((entry) => entry.id === TEST_PLUGIN_PACKAGE);
  assert.ok(boardEntry && typeof boardEntry.url === 'string', 'ProjectBoard browser module must be in the real boot manifest');
  // DSH bootstraps plugin batches from this manifest; they need not be script-src tags.
  const candidates = [new URL(boardEntry.url, base), ...scriptUrls(html, base).filter((url) => url.pathname.includes('/' + TEST_PLUGIN_PACKAGE + '/client.js'))];
  const expected = fs.readFileSync(path.join(env.repoRoot, 'lib', 'client.js'), 'utf8')
    .replace(/\r\n/g, '\n').replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/, '');
  let matched = false;
  for (const candidate of candidates) {
    assert.equal(candidate.origin, base.origin, 'plugin resource stays on test origin');
    const response = await request(candidate, { headers: { cookie } });
    assert.equal(response.status, 200);
    const source = (await response.text()).replace(/\r\n/g, '\n');
    if (source.includes(expected)) matched = true;
  }
  assert.ok(matched, 'served plugin module must contain this worktree client artifact');
  return {
    checkedAt: new Date().toISOString(), url: base.href, commit: state.commit, dshVersion: state.dshVersion,
    checks: ['independent-loopback-origin', 'anonymous-index-refused', 'launch-cookie', 'full-dsh-boot', 'project-board-token-required', 'project-board-ping', 'synthetic-projects-only', 'branch-client-artifact'],
    projects: projects.length, fixtureProjectId: fixture?.projectId ?? null,
    clientCanonicalSha256: crypto.createHash('sha256').update(expected).digest('hex'),
    note: 'No browser interaction or model call was performed; manual UI acceptance remains required.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyEnvironment(), null, 2)); }
  catch (error) { console.error('[test-env:verify] ' + error.message); process.exitCode = 1; }
}

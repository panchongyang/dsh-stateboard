#!/usr/bin/env node
// Open only this authenticated test instance; do not print its launch token.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEnvironment, readRuntime } from './test-env/environment.mjs';
import { statusEnvironment } from './test-env/lifecycle.mjs';
import { localUrl } from './test-env-verify.mjs';

export function authenticationUrl(state) {
  const base = localUrl(state.url);
  const auth = localUrl(state.authUrl);
  if (auth.origin !== base.origin || auth.pathname !== '/' || auth.hash || !auth.searchParams.get('token')
    || [...auth.searchParams.keys()].some((key) => key !== 'token')) throw new Error('invalid test launch URL');
  return auth.href;
}

function openBrowser(url) {
  if (process.platform !== 'win32') throw new Error('This local launcher supports Windows; use the private runtime authentication URL on other platforms.');
  const executable = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:/Windows', 'System32', 'rundll32.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function openEnvironment(env = createEnvironment(), opener = openBrowser) {
  const status = await statusEnvironment(env);
  if (status.phase !== 'running') throw new Error('test environment is not ready: ' + status.phase);
  const state = readRuntime(env);
  await opener(authenticationUrl(state));
  return { opened: true, url: state.url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await openEnvironment(), null, 2)); }
  catch (error) { console.error('[test-env:open] ' + error.message); process.exitCode = 1; }
}

#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createEnvironment, prepareEnvironment, resetEnvironment } from './test-env/environment.mjs';
import { runEnvironment, statusEnvironment, stopEnvironment } from './test-env/lifecycle.mjs';

export function parseArguments(args) {
  const [command = 'status', ...rest] = args;
  if (!['prepare', 'run', 'start', 'status', 'stop', 'reset'].includes(command)) throw new Error('expected prepare|run|start|status|stop|reset');
  const launches = command === 'run' || command === 'start';
  let port = 3081;
  let cliPath;
  for (let index = 0; index < rest.length; index += 2) {
    const [option, value] = [rest[index], rest[index + 1]];
    if (launches && option === '--port' && /^\d+$/.test(value ?? '')) {
      port = Number(value);
    } else if (launches && option === '--cli' && value && !value.startsWith('--')) {
      cliPath = value;
    } else {
      throw new Error('unsupported argument; only run/start --cli <path> and --port <port> are accepted (no --root override)');
    }
  }
  if (port > 65535 || port === 3080) throw new Error('invalid/production port refused');
  if (launches && !cliPath) throw new Error('run/start requires --cli <path to the installed DSH CLI>');
  return { command, port, cliPath };
}

export async function main(args = process.argv.slice(2)) {
  const { command, port, cliPath } = parseArguments(args);
  const env = createEnvironment({ cliPath });
  if (command === 'prepare') {
    await prepareEnvironment(env);
    console.log('[test-env] prepared ' + env.root + '; no dependencies installed, no credentials copied');
  } else if (command === 'run' || command === 'start') {
    process.exitCode = await runEnvironment(env, { port });
  } else {
    const result = command === 'status' ? await statusEnvironment(env)
      : command === 'stop' ? await stopEnvironment(env) : await resetEnvironment(env);
    console.log(JSON.stringify(result, null, 2));
    if (result.phase === 'stale' || result.phase === 'busy') process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('[test-env] ' + error.message); process.exitCode = 1; });
}

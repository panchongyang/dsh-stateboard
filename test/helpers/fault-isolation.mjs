// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string} fixture
 * @returns {Record<string, string>}
 */
export function isolatedEnvironment(fixture) {
  /** @type {Record<string, string>} */
  const env = {};
  const allowed = ['path', 'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive', 'number_of_processors', 'processor_architecture'];
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.includes(key.toLowerCase()) && value !== undefined) env[key] = value;
  }
  const paths = {
    HOME: 'user', USERPROFILE: 'user', DSH_HOME: 'dsh', DSH_AGENTS_HOME: 'agents',
    APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp',
    XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data',
    XDG_STATE_HOME: 'state', XDG_RUNTIME_DIR: 'runtime', NPM_CONFIG_CACHE: 'npm-cache',
  };
  for (const [key, sub] of Object.entries(paths)) {
    env[key] = path.join(fixture, sub);
    fs.mkdirSync(env[key], { recursive: true });
  }
  for (const key of ['NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG']) {
    env[key] = path.join(fixture, key);
    fs.writeFileSync(env[key], '');
  }
  env.PB_FAULT_FIXTURE = fixture;
  env.PB_COMMAND_EVIDENCE = 'off';
  env.CI = '1';
  return env;
}

export function assertIsolation() {
  const fixture = process.env.PB_FAULT_FIXTURE;
  assert.ok(fixture, 'fault worker must be launched through the isolated test entry');
  const variables = Object.entries(process.env)
    .filter(([key]) => /^(HOME|USERPROFILE|DSH_HOME|DSH_AGENTS_HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR)$/.test(key)
      || /^(XDG_|NPM_CONFIG_)/.test(key));
  // Same default-root resolution as lib/index.js, without importing host peers.
  const defaultRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'project-board');
  for (const file of [os.homedir(), os.tmpdir(), defaultRoot, ...variables.map(([, value]) => value)]) {
    const relative = path.relative(fixture, file);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), file);
  }
  for (const key of Object.keys(process.env)) {
    assert.doesNotMatch(key, /^(NODE_OPTIONS|NODE_PATH|PB_MIGRATION_PROJECT|PB_EXECUTION_KEY)$|API_KEY|EXECUTION_SECRET/i);
  }
  return fixture;
}

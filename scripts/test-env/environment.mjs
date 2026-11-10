import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TEST_PLUGIN_PACKAGE = JSON.parse(fs.readFileSync(path.join(DEFAULT_REPO, 'package.json'), 'utf8')).name;
if (typeof TEST_PLUGIN_PACKAGE !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(TEST_PLUGIN_PACKAGE)) {
  throw new Error('invalid test plugin package name');
}
const LEGACY_TEST_PLUGIN_PACKAGE = 'dsh-project-board';
export const OWNER_KIND = 'project-board-test-env';

// The command-line never accepts a root override. Offline tests can inject a repository root.
export function createEnvironment({ repoRoot = DEFAULT_REPO, runtimeRoot, cliPath } = {}) {
  const repo = path.resolve(repoRoot);
  const root = path.resolve(runtimeRoot ?? path.join(repo, '.test-env'));
  if (root !== path.join(repo, '.test-env')) throw new Error('runtime root must be repo/.test-env');
  const home = path.join(root, 'home');
  return {
    repoRoot: repo, root, home, cliPath: cliPath === undefined ? undefined : path.resolve(cliPath),
    agents: path.join(root, 'agents'), workspace: path.join(root, 'workspace'),
    board: path.join(root, 'board'), logs: path.join(root, 'logs'),
    userHome: path.join(root, 'user'), temp: path.join(root, 'tmp'),
    profile: path.join(home, 'profiles', 'web'),
    markerFile: path.join(root, 'owner.json'), runtimeFile: path.join(root, 'runtime.json'),
    lockFile: path.join(root, 'lifecycle.lock'),
  };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  assertNoLinks(file);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export function assertNoLinks(target) {
  const full = path.resolve(target);
  let cursor = path.parse(full).root;
  for (const segment of full.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('symbolic link/reparse path refused: ' + cursor);
    if (!stat) break;
  }
}

export function assertOwned(env) {
  if (env.root !== path.join(env.repoRoot, '.test-env')) throw new Error('unsafe runtime root');
  assertNoLinks(env.root);
  assertNoLinks(env.markerFile);
  if (!fs.existsSync(env.markerFile)) throw new Error('missing test environment owner marker; run prepare first');
  const marker = readJson(env.markerFile);
  if (marker.kind !== OWNER_KIND || marker.schema !== 1 || !/^[a-f0-9-]{36}$/.test(marker.owner ?? '')
    || marker.root !== env.root || marker.repoRoot !== env.repoRoot) throw new Error('test environment owner marker mismatch');
  if (fs.realpathSync(env.root) !== env.root || fs.realpathSync(env.repoRoot) !== env.repoRoot) {
    throw new Error('noncanonical runtime/repository path refused');
  }
  for (const key of ['home', 'agents', 'workspace', 'board', 'logs', 'userHome', 'temp', 'profile', 'runtimeFile', 'lockFile']) {
    assertNoLinks(env[key]);
  }
  for (const relative of ['AppData', 'AppData/Roaming', 'AppData/Local']) assertNoLinks(path.join(env.userHome, relative));
  assertNoLinks(path.join(env.profile, 'node_modules'));
  const [pluginLink, legacyPluginLink] = pluginLinks(env);
  if (pluginLink !== legacyPluginLink && fs.lstatSync(pluginLink, { throwIfNoEntry: false })
    && fs.lstatSync(legacyPluginLink, { throwIfNoEntry: false })) throw new Error('conflicting test plugin links');
  for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml']) {
    assertNoLinks(path.join(env.profile, name));
  }
  assertOwnedTree(env.root, env);
  return marker;
}

function pluginLinks(env) {
  const modules = path.join(env.profile, 'node_modules');
  return [TEST_PLUGIN_PACKAGE, LEGACY_TEST_PLUGIN_PACKAGE].map((name) => path.join(modules, name));
}

function assertOwnedTree(directory, env) {
  const allowed = pluginLinks(env);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (!allowed.includes(full) || fs.realpathSync(full) !== env.repoRoot) throw new Error('symbolic link in test environment refused: ' + full);
    } else if (entry.isDirectory()) assertOwnedTree(full, env);
  }
}

function initializeOwner(env) {
  assertNoLinks(env.root);
  if (fs.existsSync(env.root)) return assertOwned(env);
  if (fs.realpathSync(env.repoRoot) !== env.repoRoot) throw new Error('repository must be canonical');
  fs.mkdirSync(env.root);
  writeJson(env.markerFile, {
    kind: OWNER_KIND, schema: 1, root: env.root, repoRoot: env.repoRoot, owner: randomUUID(),
  });
  return assertOwned(env);
}

export function readRuntime(env) {
  assertOwned(env);
  if (!fs.existsSync(env.runtimeFile)) return null;
  const state = readJson(env.runtimeFile);
  if (state.root !== env.root || state.owner !== readJson(env.markerFile).owner) throw new Error('runtime identity mismatch');
  return state;
}

// A stopped record alone is insufficient: the supervisor holds this exclusive lock
// for its entire lifetime. Crash leftovers deliberately require manual inspection.
export async function withStoppedEnvironment(env, operation) {
  assertOwned(env);
  let fd;
  try {
    fd = fs.openSync(env.lockFile, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('environment is busy or has a stale lifecycle lock; refusing mutation');
    throw error;
  }
  try {
    const state = readRuntime(env);
    if (state && state.phase !== 'stopped') throw new Error('environment not confirmed stopped (' + state.phase + ')');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, root: env.root, nonce: randomUUID() }));
    return await operation(env);
  } finally {
    fs.closeSync(fd);
    assertNoLinks(env.lockFile);
    fs.unlinkSync(env.lockFile);
  }
}

function ensurePluginLink(env) {
  const modules = path.join(env.profile, 'node_modules');
  assertNoLinks(modules);
  fs.mkdirSync(modules, { recursive: true });
  const [link, legacy] = pluginLinks(env);
  const stat = fs.lstatSync(link, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isSymbolicLink() || fs.realpathSync(link) !== env.repoRoot) throw new Error('plugin link target mismatch');
    return;
  }
  const previous = fs.lstatSync(legacy, { throwIfNoEntry: false });
  if (previous) {
    if (!previous.isSymbolicLink() || fs.realpathSync(legacy) !== env.repoRoot) throw new Error('legacy plugin link target mismatch');
    fs.renameSync(legacy, link);
  } else fs.symlinkSync(env.repoRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function prepareFiles(env) {
  for (const dir of [env.home, env.agents, env.workspace, env.board, env.logs, env.userHome, env.temp, env.profile]) {
    assertNoLinks(dir);
    fs.mkdirSync(dir, { recursive: true });
  }
  const roaming = path.join(env.userHome, 'AppData', 'Roaming');
  const local = path.join(env.userHome, 'AppData', 'Local');
  for (const dir of [roaming, local]) { assertNoLinks(dir); fs.mkdirSync(dir, { recursive: true }); }
  const manifest = {
    name: 'dsh-profile-project-board-test', private: true,
    dependencies: { [TEST_PLUGIN_PACKAGE]: 'link:' + env.repoRoot.replaceAll('\\', '/') },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  };
  writeJson(path.join(env.profile, 'package.json'), manifest);
  const patch = '- insert:\n    - id: project-board\n      name: ' + JSON.stringify(TEST_PLUGIN_PACKAGE)
    + '\n      config:\n        rootDir: ' + JSON.stringify(env.board) + '\n';
  const patchFile = path.join(env.profile, 'cordis.patch.yml');
  assertNoLinks(patchFile);
  fs.writeFileSync(patchFile, patch);
  const pnpm = path.join(env.profile, 'pnpm-workspace.yaml');
  assertNoLinks(pnpm);
  fs.writeFileSync(pnpm, 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  ensurePluginLink(env);
  const instructions = path.join(env.workspace, 'AGENTS.md');
  assertNoLinks(instructions);
  if (!fs.existsSync(instructions)) fs.writeFileSync(instructions,
    '# Isolated ProjectBoard test workspace\n\nSynthetic test data only. Do not modify production services or read production credentials.\n');
}

export async function prepareEnvironment(env) {
  initializeOwner(env);
  return withStoppedEnvironment(env, () => { prepareFiles(env); return env; });
}

export function childEnvironment(env, inherited = process.env) {
  const result = {};
  const allowed = new Set(['systemroot', 'windir', 'comspec', 'pathext', 'path', 'os', 'processor_architecture', 'number_of_processors']);
  for (const [key, value] of Object.entries(inherited)) if (allowed.has(key.toLowerCase()) && typeof value === 'string') result[key] = value;
  return Object.assign(result, {
    HOME: env.userHome, USERPROFILE: env.userHome,
    APPDATA: path.join(env.userHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(env.userHome, 'AppData', 'Local'),
    TEMP: env.temp, TMP: env.temp, DSH_HOME: env.home, DSH_AGENTS_HOME: env.agents,
    DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write', PB_COMMAND_EVIDENCE: 'off',
  });
}

function assertDataTree(target) {
  assertNoLinks(target);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error('expected test data directory: ' + target);
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error('symbolic link in test data refused: ' + child);
    if (entry.isDirectory()) assertDataTree(child);
  }
}

export async function resetEnvironment(env) {
  return withStoppedEnvironment(env, () => {
    for (const dir of [env.board, env.workspace]) assertDataTree(dir);
    const backups = path.join(env.root, 'backups');
    assertNoLinks(backups);
    fs.mkdirSync(backups, { recursive: true });
    const backup = path.join(backups, new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID());
    fs.mkdirSync(backup);
    for (const key of ['board', 'workspace']) {
      if (fs.existsSync(env[key])) fs.renameSync(env[key], path.join(backup, key));
      fs.mkdirSync(env[key]);
    }
    return { backup };
  });
}

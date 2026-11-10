#!/usr/bin/env node
/** Maintenance assembly script; never a product CLI and never restarts DSH. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'dsh-stateboard';
const RECEIPT = '.project-board-install.json';

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--dry-run', '--uninstall'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--runtime', '--profile'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2)] = args[++i];
    else throw new Error('Usage: node scripts/install.mjs [--profile <name>] [--runtime <@deepseek-ai directory>] [--dry-run] [--uninstall]');
  }
  return options;
}

export function discoverHost(runtime, env = process.env) {
  const candidates = runtime ? [path.join(path.resolve(runtime), 'dsh', 'package.json')] : [];
  if (!runtime) {
    for (const anchor of [pluginDir, process.cwd(), ...(env.PATH ?? env.Path ?? '').split(path.delimiter)]) {
      if (!anchor) continue;
      try { candidates.push(createRequire(path.join(path.resolve(anchor), '__project_board__.cjs')).resolve('@deepseek-ai/dsh/package.json')); } catch { /* next installation anchor */ }
      candidates.push(path.join(anchor, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    }
  }
  for (const manifest of candidates) {
    if (!fs.existsSync(manifest)) continue;
    const require = createRequire(manifest);
    try {
      const home = require.resolve('@deepseek-ai/dsh-home-paths');
      const boot = require.resolve('@deepseek-ai/dsh-app-boot');
      return { manifest, home, boot };
    } catch { /* incomplete host; keep searching */ }
  }
  throw new Error('DSH host not found or incomplete. Install a compatible DSH and put dsh on PATH; --runtime <node_modules/@deepseek-ai> explicitly selects a non-PATH installation. No files changed.');
}

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function stat(file) { return fs.lstatSync(file, { throwIfNoEntry: false }); }
function sameLink(file, target) {
  return stat(file)?.isSymbolicLink() && fs.realpathSync(file) === fs.realpathSync(target);
}
function assertPlain(file) {
  if (stat(file)?.isSymbolicLink()) throw new Error('Configuration symlink refused: ' + file);
}
function atomicWrite(file, text) {
  const temp = file + '.project-board-tmp-' + randomUUID();
  let created = false;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx'); created = true;
    fs.writeFileSync(fd, text); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created && stat(temp)) fs.unlinkSync(temp);
  }
}

/** All mutations are inside the selected profile. The source/runtime/store are read-only. */
export function assemble({ profileDir, source = pluginDir, uninstall = false, dryRun = false, log = console.log, failAfterLink = false, failAfterManifest = false }) {
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) throw new Error('DSH profile is not initialized: ' + profileDir + '. Initialize it with dsh plugin --profile <name> first. No files changed.');
  for (const file of [profileDir, path.join(profileDir, 'node_modules')]) assertPlain(file);
  const manifestFile = path.join(profileDir, 'package.json');
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const receiptFile = path.join(profileDir, RECEIPT);
  for (const file of [manifestFile, patchFile, receiptFile]) assertPlain(file);
  const before = fs.readFileSync(manifestFile, 'utf8');
  const manifest = JSON.parse(before);
  const patch = readOptional(patchFile);
  const receiptText = readOptional(receiptFile);
  const receipt = receiptText === null ? null : JSON.parse(receiptText);
  const link = path.join(profileDir, 'node_modules', NAME);
  const selected = manifest.dsh?.profile?.bundles ?? [];
  const dep = manifest.dependencies?.[NAME];
  if (receipt && (receipt.schema !== 1 || receipt.source !== source || receipt.profileDir !== profileDir)) throw new Error('Installation ownership conflict; use the original package/script and profile. No files changed.');
  if (uninstall && !receipt) {
    if (dep || selected.includes(NAME) || stat(link)) throw new Error('Not owned by this script. Use dsh plugin --profile <name> remove dsh-stateboard for a host-managed installation. No files changed.');
    log('[project-board] already uninstalled; project data retained');
    return;
  }
  if (!uninstall && !receipt && (dep || selected.includes(NAME) || stat(link) || /\bid:\s*project-board\b/.test(patch ?? ''))) throw new Error('Existing project-board entry/package conflicts with script ownership. Remove/migrate that assembly explicitly; nothing overwritten.');
  if (receipt && (!sameLink(link, source) || dep !== receipt.dependency || !selected.includes(NAME))) throw new Error('Assembly changed since install; refusing to remove or overwrite someone else’s configuration.');
  const next = structuredClone(manifest);
  if (uninstall) {
    delete next.dependencies[NAME];
    next.dsh.profile.bundles = selected.filter((name) => name !== NAME);
    if (!receipt.hadDependencies && Object.keys(next.dependencies).length === 0) delete next.dependencies;
  } else {
    next.dependencies = { ...next.dependencies, [NAME]: 'link:' + source.replaceAll('\\', '/') };
    next.dsh = { ...next.dsh, profile: { ...next.dsh?.profile, bundles: [...new Set([...selected, NAME])] } };
  }
  log('[project-board] profile: ' + profileDir);
  log('[project-board] ' + (uninstall ? 'remove' : 'select') + ' bundle ' + NAME + '; cordis.patch.yml remains unchanged; bundle contributes:\n' + fs.readFileSync(path.join(source, 'lib', 'cordis.patch.yml'), 'utf8'));
  log('[project-board] dependency: ' + JSON.stringify(dep ?? null) + ' -> ' + JSON.stringify(next.dependencies?.[NAME] ?? null));
  if (dryRun) { log('[project-board] preview only; no writes'); return; }
  if (!uninstall && receipt) { log('[project-board] already installed; no writes'); return; }
  const backups = path.join(profileDir, '.project-board-backups');
  assertPlain(backups);
  fs.mkdirSync(backups, { recursive: true });
  const backup = fs.mkdtempSync(path.join(backups, uninstall ? 'remove-' : 'install-'));
  fs.writeFileSync(path.join(backup, 'package.json'), before, { flag: 'wx' });
  if (patch !== null) fs.writeFileSync(path.join(backup, 'cordis.patch.yml'), patch, { flag: 'wx' });
  if (receiptText !== null) fs.writeFileSync(path.join(backup, RECEIPT), receiptText, { flag: 'wx' });
  log('[project-board] configuration backup: ' + backup);
  const hadModules = !!stat(path.dirname(link));
  let changedLink = false;
  try {
    if (uninstall) { fs.unlinkSync(link); changedLink = true; }
    else {
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
      changedLink = true;
    }
    if (failAfterLink) throw new Error('injected failure after link');
    atomicWrite(manifestFile, JSON.stringify(next, null, 2) + '\n');
    if (failAfterManifest) throw new Error('injected failure after manifest');
    if (uninstall) fs.unlinkSync(receiptFile);
    else atomicWrite(receiptFile, JSON.stringify({ schema: 1, source, profileDir, dependency: next.dependencies[NAME], hadDependencies: !!manifest.dependencies, backup }, null, 2) + '\n');
  } catch (error) {
    try {
      atomicWrite(manifestFile, before);
      if (changedLink) {
        if (uninstall) fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
        else fs.unlinkSync(link);
      }
      if (receiptText === null) { if (stat(receiptFile)) fs.unlinkSync(receiptFile); }
      else atomicWrite(receiptFile, receiptText);
      if (!hadModules && stat(path.dirname(link)) && fs.readdirSync(path.dirname(link)).length === 0) fs.rmdirSync(path.dirname(link));
    } catch (rollback) { throw new Error('Assembly failed: ' + error.message + '; automatic rollback failed: ' + rollback.message + '. Stop DSH and restore configuration from ' + backup); }
    throw new Error('Assembly failed; configuration and link restored: ' + error.message + '. Backup: ' + backup);
  }
  log('[project-board] ' + (uninstall ? 'uninstalled; project data retained' : 'installed') + '. Manually restart your selected DSH host, then refresh the page (Ctrl+R).');
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const host = discoverHost(options.runtime);
  const { resolveDshHome } = await import(pathToFileURL(host.home).href);
  const { resolveProfileDir } = await import(pathToFileURL(host.boot).href);
  const home = resolveDshHome();
  let profile = options.profile ?? process.env.DSH_PROFILE;
  if (!profile) {
    const root = path.join(home, 'profiles');
    const names = fs.existsSync(root) ? fs.readdirSync(root).filter((name) => fs.existsSync(path.join(root, name, 'package.json'))) : [];
    if (names.length !== 1) throw new Error('Select an initialized DSH profile with --profile <name> (or DSH_PROFILE); found ' + names.length + ' under ' + root + '. No files changed.');
    [profile] = names;
  }
  assemble({ profileDir: resolveProfileDir(profile, home), uninstall: options.uninstall, dryRun: options['dry-run'] });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error('[project-board] ' + error.message + (['EACCES', 'EPERM', 'EROFS'].includes(error.code) ? ' Check profile permissions; existing configuration was not intentionally replaced.' : ''));
  process.exitCode = 1;
});

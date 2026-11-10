// Resolution of the Git executable (docs/GIT-EXECUTION.md).
//
// On Windows an executable given as a bare name is resolved by libuv through the
// child's working directory, so `spawnSync('git', …, { cwd: workspace })` runs a
// `git.exe` that an attacker dropped at the workspace root. The Git calls listed
// in docs/GIT-EXECUTION.md therefore pass an absolute executable path resolved here.
//
// Resolution happens once per process (lazy singleton). A candidate is accepted
// only when its real path is a regular file outside the real path of every
// workspace root the caller is about to read and of the checkout running this
// code. There is deliberately no fallback to the bare name: when PATH has no
// acceptable candidate, Git is unavailable and callers degrade explicitly.

import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './errors.js';
import { isInside } from './util.js';

// Git for Windows ships a real git.exe; a .cmd shim would require a shell, which
// this process never uses.
const EXECUTABLE_NAMES = process.platform === 'win32' ? ['git.exe'] : ['git'];
const OWN_CHECKOUT = path.resolve(import.meta.dirname, '..', '..');
let resolvedExecutable = null;

function pathEntries() {
  return String(process.env.PATH || '').split(path.delimiter).filter((entry) => entry !== '');
}

// A junction or 8.3 alias of a root must not hide its physical subtree, so roots
// are compared by real path. A declared root that cannot be resolved is refused.
function canonicalRoot(root) {
  try {
    return fs.realpathSync.native(path.resolve(root));
  } catch (error) {
    throw new BoardError('git-unavailable', 'cannot resolve the real path of a Git safety root: ' + root, {
      status: 503,
      details: { reason: 'git-root-unresolvable', root, cause: error?.code || 'unknown' },
    });
  }
}

function forbiddenRoots(workspaceRoots) {
  const roots = [canonicalRoot(OWN_CHECKOUT)];
  for (const root of workspaceRoots) {
    if (typeof root !== 'string' || root === '') continue;
    roots.push(canonicalRoot(root));
  }
  return roots;
}

function acceptable(candidate, roots) {
  let real;
  try { real = fs.realpathSync.native(candidate); } catch { return null; }
  try { if (!fs.statSync(real).isFile()) return null; } catch { return null; }
  return roots.some((root) => isInside(root, real)) ? null : real;
}

function searchPath(roots) {
  for (const entry of pathEntries()) {
    for (const name of EXECUTABLE_NAMES) {
      const found = acceptable(path.resolve(entry, name), roots);
      if (found) return found;
    }
  }
  throw unresolved(roots, 'git-exec-not-found');
}

function unresolved(roots, reason) {
  return new BoardError('git-unavailable', 'no Git executable is available outside the workspace roots; put a system Git on PATH', {
    status: 503,
    details: { reason, workspaceRoots: roots },
  });
}

/**
 * Absolute path of the Git executable, resolved once and reused.
 * `workspaceRoots` must list every root this process reads Git state from; a
 * candidate inside the real path of one of them is skipped, and a later use that
 * would place the cached path inside a new root fails instead of silently
 * re-resolving.
 */
export function resolveGitExecutable(workspaceRoots = []) {
  const roots = forbiddenRoots(workspaceRoots);
  if (!resolvedExecutable) resolvedExecutable = searchPath(roots);
  if (roots.some((root) => isInside(root, resolvedExecutable))) throw unresolved(roots, 'git-exec-not-found');
  return resolvedExecutable;
}

function realOrRaw(dir) {
  // An unresolvable root stays raw so resolveGitExecutable refuses it.
  try { return fs.realpathSync.native(dir); } catch { return dir; }
}

// A `.git` that is a symlink or junction is classified by its target, so a
// linked gitfile is still parsed; `linked` keeps the target as a root too.
function markerKind(marker) {
  const stat = fs.lstatSync(marker);
  if (!stat.isSymbolicLink()) return { isFile: stat.isFile(), linked: false };
  try { return { isFile: fs.statSync(marker).isFile(), linked: true }; } catch { return { isFile: false, linked: true }; }
}

// Every `.git` from `start` up to the drive or UNC share root, nearest first.
// Enclosing repositories are kept too: Git skips a `.git` it finds invalid and
// keeps climbing, so the nearest marker alone is not a safe boundary.
function gitMarkers(start) {
  const found = [];
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const marker = path.join(dir, '.git');
    try { found.push({ dir, marker, ...markerKind(marker) }); } catch { /* not a repository level */ }
    // path.dirname of a drive root or a UNC share root returns it unchanged.
    if (path.dirname(dir) === dir) return found;
  }
}

// Every enclosing directory named `.git` contributes its parent (main checkout
// of a linked worktree, superproject of a nested submodule git dir).
function dotGitOwners(gitDir) {
  const owners = [];
  for (let dir = gitDir; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (path.basename(dir).toLowerCase() === '.git') owners.push(path.dirname(dir));
  }
  return owners;
}

// Whole file, never truncated: a setting past any fixed prefix must still count.
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function ownerUnresolvable(commonDir, why) {
  return new BoardError('git-unavailable', 'cannot tell which working tree owns the Git directory ' + commonDir + ' (' + why + '); refusing to pick a Git executable', {
    status: 503,
    details: { reason: 'git-owner-unresolvable', commonDir, cause: why },
  });
}

const CONFIG_ESCAPES = { n: '\n', t: '\t', b: '\b', '\\': '\\', '"': '"' };

// One `git config` value from `i` (just past `=`): quotes, escapes, `#`/`;`
// comments outside quotes, trailing-backslash continuation, and unquoted
// trailing whitespace dropped, as Git's config.c does.
function configValue(text, i) {
  let value = '';
  let pending = '';
  let quoted = false;
  for (; i < text.length && text[i] !== '\n'; i++) {
    const c = text[i];
    if (c === '\\') {
      const next = text[++i];
      if (next === '\n') continue;
      if (next === '\r' && text[i + 1] === '\n') { i++; continue; }
      if (!(next in CONFIG_ESCAPES)) throw new Error('bad escape in value');
      value += pending + CONFIG_ESCAPES[next];
      pending = '';
    } else if (c === '"') {
      value += pending;
      pending = '';
      quoted = !quoted;
    } else if (!quoted && (c === '#' || c === ';')) {
      while (i < text.length && text[i] !== '\n') i++;
      break;
    } else if (!quoted && (c === ' ' || c === '\t' || c === '\r')) {
      if (value !== '') pending += c;
    } else {
      value += pending + c;
      pending = '';
    }
  }
  if (quoted) throw new Error('unterminated quote');
  return { value, next: i };
}

// `[section]`, `[section "sub"]` or legacy `[section.sub]`, starting at `[`.
function configSection(text, i) {
  const head = /\[[ \t]*([-A-Za-z0-9.]+)[ \t]*(?:"((?:[^"\\\n]|\\.)*)"[ \t]*)?\]/y;
  head.lastIndex = i;
  const match = head.exec(text);
  if (!match) throw new Error('bad section header');
  const name = match[1].toLowerCase();
  return { name: match[2] === undefined ? name : name + '.' + match[2].replace(/\\(.)/g, '$1'), next: head.lastIndex };
}

/**
 * Minimal `git config` file reader: variable names are `section[.sub].key`
 * with section and key lower-cased, and the last assignment of a name wins.
 * A value-less key reads as `true`. Malformed input throws, as Git refuses it.
 */
export function parseGitConfig(text) {
  const values = new Map();
  const keyPattern = /([A-Za-z][-A-Za-z0-9]*)[ \t]*/y;
  let section = null;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\uFEFF') { i++; continue; }
    if (c === '#' || c === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '[') { ({ name: section, next: i } = configSection(text, i)); continue; }
    keyPattern.lastIndex = i;
    const key = keyPattern.exec(text);
    if (!key || section === null) throw new Error('bad config line');
    const assigned = text[keyPattern.lastIndex] === '=';
    const { value, next } = configValue(text, keyPattern.lastIndex + (assigned ? 1 : 0));
    if (!assigned && value !== '') throw new Error('bad config line');
    values.set(section + '.' + key[1].toLowerCase(), assigned ? value : true);
    i = next;
  }
  return values;
}

// The common git directory of a linked worktree git dir: its `commondir` file
// (`declared`), else the `<common>/worktrees/<name>` layout.
function commonDirs(gitDir) {
  const dirs = [];
  const commondir = readText(path.join(gitDir, 'commondir'));
  if (commondir && commondir.trim()) dirs.push({ dir: path.resolve(gitDir, commondir.trim()), declared: true });
  if (path.basename(path.dirname(gitDir)).toLowerCase() === 'worktrees') dirs.push({ dir: path.dirname(path.dirname(gitDir)), declared: false });
  return dirs;
}

// The main checkout of a separate-git-dir common directory (one with no `.git`
// segment in its real path). Only its `core.worktree` names it; a bare
// repository has none. Anything else is unknown, and unknown is refused.
function separateOwner(common) {
  const text = readText(path.join(common.real, 'config'));
  if (text === null) {
    if (!common.declared) return [];
    throw ownerUnresolvable(common.dir, 'config unreadable');
  }
  let config;
  try { config = parseGitConfig(text); } catch (error) { throw ownerUnresolvable(common.dir, 'config unparsable: ' + error.message); }
  const worktree = config.get('core.worktree');
  // Git resolves a relative core.worktree against the git dir; both spellings count.
  if (typeof worktree === 'string' && worktree !== '') {
    const owners = [...new Set([common.dir, common.real])].map((dir) => path.resolve(dir, worktree)).filter((dir) => fs.existsSync(dir));
    if (owners.length > 0) return owners;
    throw ownerUnresolvable(common.dir, 'core.worktree does not exist');
  }
  if (/^(true|yes|on|1)$/i.test(String(config.get('core.bare')))) return [];
  throw ownerUnresolvable(common.dir, 'no core.worktree');
}

function commonRoots(common) {
  const real = realOrRaw(common.dir);
  const owners = dotGitOwners(real);
  const separate = owners.length === 0 ? separateOwner({ ...common, real }) : [];
  return [common.dir, real, ...owners, ...separate];
}

// Owners are derived from the real path of the git dir (an alias such as a
// junction to `R/.git` has no `.git` segment) and from its given spelling.
function gitDirRoots(gitDir) {
  const roots = [];
  for (const dir of new Set([gitDir, realOrRaw(gitDir)])) {
    roots.push(dir, ...dotGitOwners(dir));
    for (const common of commonDirs(dir)) roots.push(...commonRoots(common));
  }
  return roots;
}

function gitFileRoots(found) {
  const text = readText(found.marker);
  const match = text && /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text);
  if (!match) return [];
  return gitDirRoots(path.resolve(found.dir, match[1])).filter((dir) => fs.existsSync(dir));
}

function markerRoots(found) {
  const roots = found.isFile ? gitFileRoots(found) : [];
  if (found.linked) {
    const target = realOrRaw(found.marker);
    roots.push(found.isFile ? path.dirname(target) : target, ...(found.isFile ? [] : dotGitOwners(target)));
  }
  return roots;
}

/**
 * Repository containing `start`, located from the file system alone so that no
 * Git runs before its tree is a safety root. `root` is the nearest directory
 * holding a `.git` (directory or gitfile); `roots` are the real paths to forbid:
 * every enclosing working tree and, for a gitfile, its git directory and the
 * tree owning it. Both the given and the real spelling of `start` are walked.
 * Returns null outside any repository. Throws `git-unavailable` with reason
 * `git-owner-unresolvable` when a separate-git-dir linked worktree's main
 * checkout cannot be determined, so callers refuse instead of guessing.
 */
export function findRepository(start) {
  const starts = [path.resolve(start)];
  const real = realOrRaw(starts[0]);
  if (real !== starts[0]) starts.push(real);
  let root = null;
  const roots = new Set();
  for (const from of starts) {
    for (const found of gitMarkers(from)) {
      root ??= found.dir;
      roots.add(realOrRaw(found.dir));
      for (const dir of markerRoots(found)) roots.add(realOrRaw(dir));
    }
  }
  return root === null ? null : { root, roots: [...roots] };
}

/** Test-only seam: forget the resolved path so the next call searches PATH again. */
export function resetGitExecutableCache() {
  resolvedExecutable = null;
}

// Product Git operations are bounded observations only. Refuse any new command
// before spawning it; developer Git scripts are outside lib/ and this boundary.
export function assertReadOnlyGitArgs(args) {
  const oid = '[0-9a-f]{40}(?:[0-9a-f]{24})?';
  const first = args?.[0];
  const is = (...expected) => JSON.stringify(args) === JSON.stringify(expected);
  const validOid = (value) => typeof value === 'string' && new RegExp('^' + oid + '$').test(value);
  let allowed = false;
  if (first === 'rev-parse') {
    allowed = is('rev-parse', '--show-toplevel') || is('rev-parse', '--show-object-format')
      || is('rev-parse', '--verify', '-q', 'HEAD')
      || is('rev-parse', '--verify', 'HEAD^{commit}')
      || is('rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir')
      || (args.length === 4 && args[1] === '--verify' && args[2] === '--end-of-options'
        && typeof args[3] === 'string' && args[3].endsWith('^{commit}') && validOid(args[3].slice(0, -9)));
  } else if (first === 'cat-file') {
    allowed = args.length === 3 && ['-t', '-s', 'commit', 'tree', 'blob'].includes(args[1]) && validOid(args[2]);
  } else if (first === 'config') {
    const filterPattern = args.length === 4 && args[1] === '-z' && args[2] === '--get-regexp'
      && typeof args[3] === 'string' && /^\^filter\\*\.$/.test(args[3]);
    allowed = filterPattern
      || (args.length === 3 && args[1] === '--get' && ['core.autocrlf', 'core.filemode'].includes(args[2]));
  } else if (first === 'check-attr') {
    const rest = args.slice(2);
    let at = 0;
    if (rest[at] === '--cached') at += 1;
    else if (rest[at] && /^--source=[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(rest[at])) at += 1;
    const body = rest.slice(at);
    const sep = body.indexOf('--');
    const names = ['filter', 'text', 'eol', 'working-tree-encoding', 'ident'];
    allowed = args[1] === '-z' && sep > 0 && typeof body[sep + 1] === 'string'
      && body.slice(0, sep).every((name) => names.includes(name));
  } else if (first === 'status') {
    allowed = args.length === 8 && args.slice(1, 7).join(' ') === '--porcelain=v1 -z --ignored=matching --untracked-files=all --no-renames --' && /^:\(literal\).+/.test(args[7]);
  } else if (first === 'ls-files') {
    const sep = args.indexOf('--');
    const flags = sep > 1 ? args.slice(1, sep) : [];
    allowed = sep > 1 && typeof args[sep + 1] === 'string' && /^:\(literal\)/.test(args[sep + 1])
      && flags.includes('-z') && flags.every((flag) => flag === '-z' || flag === '--stage');
  }
  if (!allowed) throw new BoardError('git-command-refused', 'product Git command is not on the bounded read-only allowlist', { status: 400 });
  return args;
}

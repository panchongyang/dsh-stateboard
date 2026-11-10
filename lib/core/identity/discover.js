// Workspace → project discovery. Pure lookups over a BindingIndex plus the
// filesystem (markers, `.git` entries) and, only for linked worktrees, git.
//
// Rules (docs/IDENTITY.md):
//   1. walk from cwd upward; the nearest directory holding a binding or a
//      project marker decides. The walk stops at the first repository root
//      (a `.git` entry), so a nested repo never falls through to a parent project.
//   2. nothing bound inside a linked git worktree: map the same relative path
//      into the main worktree (git common-dir) and repeat; the result keeps the
//      project's main binding, so the shared main workspace never changes.
//   3. a marker without a binding is never auto-bound: known project →
//      binding-required (moved/copied: the human chooses), unknown → board-data-missing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';
import { assertReadOnlyGitArgs, resolveGitExecutable } from '../git-exec.js';
import { canonicalKey, resolveWorkspacePath } from '../util.js';

export const MARKER_FILE = '.dsh-project.json';
export const MARKER_SCHEMA = 1;
const MARKER_MAX_BYTES = 4096;
const PROJECT_ID = /^prj_[0-9a-f]{16}$/;
const GIT_CACHE_MS = 30_000;
const gitCache = new Map();

function invalidMarker(dir, reason) {
  return new BoardError('invalid-project-marker', 'invalid ' + MARKER_FILE + ' in ' + dir + ': ' + reason, { status: 400, details: { dir, reason } });
}

/** null when absent; the marker may only hold { schemaVersion, projectId }. */
export function readMarker(dir) {
  const file = path.join(dir, MARKER_FILE);
  let stat;
  try { stat = fs.lstatSync(file); } catch { return null; }
  if (!stat.isFile()) throw invalidMarker(dir, 'not a regular file');
  if (stat.size > MARKER_MAX_BYTES) throw invalidMarker(dir, 'too large');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw invalidMarker(dir, 'not JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidMarker(dir, 'not an object');
  if (data.schemaVersion !== MARKER_SCHEMA) throw invalidMarker(dir, 'unknown schemaVersion');
  const keys = Object.keys(data).sort().join(',');
  if (keys !== 'projectId,schemaVersion') throw invalidMarker(dir, 'unexpected fields');
  if (typeof data.projectId !== 'string' || !PROJECT_ID.test(data.projectId)) throw invalidMarker(dir, 'malformed projectId');
  return { projectId: data.projectId };
}

export function writeMarker(dir, projectId) {
  if (!PROJECT_ID.test(projectId)) throw invalidMarker(dir, 'malformed projectId');
  const file = path.join(dir, MARKER_FILE);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: MARKER_SCHEMA, projectId }, null, 2) + '\n', 'utf8');
  return file;
}

function gitEntry(dir) {
  try { return fs.lstatSync(path.join(dir, '.git')); } catch { return null; }
}

/** Walk from `start` upward. Stops at the nearest binding/marker, a repo root, `stopAt`, or the fs root. */
export function walkUp(start, index, { stopAt = null } = {}) {
  const stopKey = stopAt ? canonicalKey(stopAt) : null;
  let dir = start;
  for (;;) {
    const bindings = index.byRoot(dir);
    const marker = readMarker(dir);
    if (bindings.length > 0 || marker) return { dir, bindings, marker, boundary: gitEntry(dir) ? dir : null };
    if (gitEntry(dir)) return { dir: null, bindings: [], marker: null, boundary: dir };
    if (stopKey && canonicalKey(dir) === stopKey) return { dir: null, bindings: [], marker: null, boundary: null };
    const parent = path.dirname(dir);
    if (parent === dir) return { dir: null, bindings: [], marker: null, boundary: null };
    dir = parent;
  }
}

function findBoundary(start) {
  let dir = start;
  for (;;) {
    if (gitEntry(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** For a linked worktree root, the main worktree root; otherwise null. `.git` may be a file or a dir. */
export function mainWorktreeOf(boundary) {
  const entry = gitEntry(boundary);
  if (!entry || entry.isDirectory()) return null;
  const cached = gitCache.get(boundary);
  if (cached && Date.now() - cached.at < GIT_CACHE_MS) return cached.main;
  let main = null;
  try {
    const out = execFileSync(resolveGitExecutable([boundary]), assertReadOnlyGitArgs(['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir']), {
      cwd: boundary, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim().split(/\r?\n/);
    const [commonDir, gitDir] = out.map((p) => path.resolve(p));
    // A submodule's git dir equals its common dir (…/.git/modules/x): not a linked worktree.
    if (commonDir && gitDir && canonicalKey(commonDir) !== canonicalKey(gitDir) && path.basename(commonDir).toLowerCase() === '.git') {
      main = resolveWorkspacePath(path.dirname(commonDir));
    }
  } catch {
    main = null; // git missing, timed out or not a repo: no worktree mapping
  }
  gitCache.set(boundary, { at: Date.now(), main });
  return main;
}

/** The same relative location in the main worktree when `dir` sits in a linked worktree; otherwise null. */
export function mainEquivalent(dir) {
  const boundary = findBoundary(dir);
  const main = boundary ? mainWorktreeOf(boundary) : null;
  return main ? path.join(main, path.relative(boundary, dir)) : null;
}

function fromBinding(hit, ctx) {
  const projects = [...new Set(hit.bindings.map((b) => b.projectId))];
  if (projects.length > 1) {
    throw new BoardError('identity-conflict', 'several projects claim ' + hit.dir, { status: 409, details: { root: hit.dir, projectIds: projects } });
  }
  const binding = hit.bindings.find((b) => b.role === 'main') || hit.bindings[0];
  if (hit.marker && hit.marker.projectId !== binding.projectId) {
    throw new BoardError('identity-conflict', MARKER_FILE + ' in ' + hit.dir + ' names ' + hit.marker.projectId + ' but the directory is bound to ' + binding.projectId, {
      status: 409, details: { root: hit.dir, markerProjectId: hit.marker.projectId, boundProjectId: binding.projectId },
    });
  }
  if (!ctx.projectExists(binding.projectId)) {
    throw new BoardError('board-data-missing', 'bound project has no board data on this machine: ' + binding.projectId, { status: 409, details: { projectId: binding.projectId, root: hit.dir } });
  }
  return { projectId: binding.projectId, bindingId: binding.bindingId, role: binding.role, root: hit.dir, implicit: Boolean(binding.implicit), via: 'binding' };
}

function viaWorktree(start, boundary, hit, index, ctx) {
  const main = mainWorktreeOf(boundary);
  if (!main) return null;
  const mainHit = walkUp(path.join(main, path.relative(boundary, start)), index, { stopAt: main });
  if (mainHit.bindings.length === 0) return null;
  const found = fromBinding(mainHit, ctx);
  if (hit.marker && hit.marker.projectId !== found.projectId) {
    throw new BoardError('identity-conflict', MARKER_FILE + ' in ' + hit.dir + ' disagrees with the main worktree binding', {
      status: 409, details: { root: hit.dir, markerProjectId: hit.marker.projectId, boundProjectId: found.projectId },
    });
  }
  return {
    ...found,
    role: 'worktree',
    via: 'git-common-dir',
    mainRoot: found.root,
    root: path.join(boundary, path.relative(main, mainHit.dir)),
  };
}

/**
 * Resolve a working directory to { projectId, bindingId, role, root, via }.
 * Returns null when nothing claims it; throws on conflicts or unbound markers.
 */
export function resolveWorkspace(cwd, index, ctx) {
  const start = resolveWorkspacePath(cwd);
  const hit = walkUp(start, index);
  if (hit.bindings.length > 0) return fromBinding(hit, ctx);
  const boundary = hit.boundary || (hit.dir ? findBoundary(hit.dir) : null);
  if (boundary) {
    const mapped = viaWorktree(start, boundary, hit, index, ctx);
    if (mapped) return mapped;
  }
  if (!hit.marker) return null;
  const projectId = hit.marker.projectId;
  if (!ctx.projectExists(projectId)) {
    throw new BoardError('board-data-missing', 'this workspace names project ' + projectId + ' but its board data is not on this machine; import it first', {
      status: 409, details: { projectId, markerDir: hit.dir },
    });
  }
  const mainRoot = ctx.mainRootOf(projectId);
  let mainExists = false;
  try { mainExists = Boolean(mainRoot) && fs.statSync(mainRoot).isDirectory(); } catch { mainExists = false; }
  throw new BoardError('binding-required', 'this directory belongs to project ' + projectId + ' but is not bound here; relocate, bind or fork explicitly', {
    status: 409, details: { projectId, markerDir: hit.dir, mainRoot, reason: mainExists ? 'copied-or-forked' : 'moved' },
  });
}

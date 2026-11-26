// The owning space selects one fixed medium. Only the legacy layout dispatches by project ID.
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from '../errors.js';

const refuse = () => new BoardError('space-home-unavailable', 'The selected space medium is incomplete, unsafe or has changed', { status: 409 });
const key = s => s.dev + ':' + s.ino;
const at = file => fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
function entry(file, directory, optional = false) {
  const s = at(file);
  if (!s && optional) return null;
  if (!s || s.ino <= 0n || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1n)) throw refuse();
  return s;
}

export function openSpaceDirectory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw refuse();
  const root = fs.realpathSync.native(input), original = key(entry(root, true));
  const namespace = path.join(root, '.projectboard'), state = path.join(namespace, 'state');
  const log = path.join(state, 'commits.jsonl');
  let nsKey, stateKey, logKey;
  function check() {
    if (key(entry(root, true)) !== original) throw refuse();
    const ns = entry(namespace, true, !nsKey);
    if (!ns) return false;
    const dir = entry(state, true);
    if ((nsKey && nsKey !== key(ns)) || (stateKey && stateKey !== key(dir))) throw refuse();
    if (logKey && key(entry(log, false)) !== logKey) throw refuse();
    return true;
  }
  function readMeta() {
    if (!check()) return null;
    entry(path.join(state, 'meta.json'), false);
    const ledger = entry(log, false);
    if (!ledger.size) throw refuse();
    entry(path.join(state, 'blobs'), true, true); entry(path.join(state, 'snapshot.json'), false, true);
    const meta = JSON.parse(fs.readFileSync(path.join(state, 'meta.json'), 'utf8'));
    if (!/^prj_[a-f0-9]{16}$/.test(meta?.projectId) || meta.project?.id !== meta.projectId) throw refuse();
    nsKey = key(entry(namespace, true)); stateKey = key(entry(state, true)); logKey = key(ledger);
    check();
    return meta;
  }
  function reserve() {
    if (check()) throw refuse();
    try { fs.mkdirSync(namespace); } catch (error) { if (error.code === 'EEXIST') throw refuse(); throw error; }
    nsKey = key(entry(namespace, true)); fs.mkdirSync(state); stateKey = key(entry(state, true));
    check();
  }
  // Captured identities only: a detached reader can verify these on its own
  // thread. Asking for the stamp does not touch the filesystem on the host.
  const mediumKey = () => nsKey && stateKey && logKey ? [original,nsKey,stateKey,logKey].join('/') : null;
  return Object.freeze({ root, directoryKey: original, mediumKey, namespace, state, readMeta, reserve, check });
}

export function projectDataDir(service, projectId) {
  if (!service.spaceHome) return path.join(service.projectsDir, projectId);
  service.spaceHome.check();
  if (!service.metas.has(projectId)) throw new BoardError('not-found', 'Project is not in the selected space', { status: 404 });
  return service.spaceHome.state;
}

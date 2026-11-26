// Lock-free stability probe shared by reader workers. It never repairs, opens a
// writer or follows links; a changed fingerprint means "retry", not "publish".
import fs from 'node:fs';
import path from 'node:path';

const STORE_FILES = ['meta.json', 'commits.jsonl', 'snapshot.json'];
const REQUIRED_FILES = ['meta.json', 'commits.jsonl'];

function stat(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Identifies the exact local medium shared with the main thread without
// treating an append to that medium as a replacement.
export function spaceReadKey(home) {
  if (home?.check() !== true) return null;
  const dirs = [home.root, home.namespace, home.state].map(stat);
  const log = stat(path.join(home.state, 'commits.jsonl'));
  if (dirs.some(dir => !dir?.isDirectory() || dir.ino <= 0n) || !log?.isFile() || log.ino <= 0n || log.nlink !== 1n) return null;
  return [...dirs, log].map(item => `${item.dev}:${item.ino}`).join('|');
}

function fileIdentity(file) {
  return file ? [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':') : 'missing';
}

export function fingerprint(dir) {
  const directory = stat(dir);
  if (!directory) return { key: 'missing-project', exists: false };
  if (!directory.isDirectory() || directory.isSymbolicLink()) return { key: 'not-a-directory', exists: false };
  const files = STORE_FILES.map((name) => stat(path.join(dir, name)));
  if (files.some((file) => file && (!file.isFile() || file.isSymbolicLink()))) return { key: 'not-store-files', exists: false };
  return {
    key: [directory.dev, directory.ino, ...files.map(fileIdentity)].join('|'),
    exists: true,
    complete: files.slice(0, REQUIRED_FILES.length).every(Boolean),
  };
}

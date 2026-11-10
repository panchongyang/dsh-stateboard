// Snapshot and blob storage for JsonlStore.
//
// Both are side files: commits.jsonl stays the only source of truth. A snapshot
// is an optimization that may be ignored, and a blob is content-addressed so an
// existing file is never rewritten.

import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, sha256, writeJson } from '../util.js';

export function saveSnapshot(store) {
  if (store.readOnly) return;
  try {
    writeJson(store.snapshotFile, {
      v: 1,
      seq: store.lastSeq,
      hash: store.lastHash,
      state: store.state,
    }, store.fs);
  } catch {
    // snapshot is an optimization; a failed snapshot is not a failed commit
  }
}

export function writeBlob(store, body) {
  const hash = sha256(body);
  const file = path.join(store.blobsDir, hash);
  if (!fs.existsSync(file)) atomicWrite(file, body, 'utf8', store.fs);
  return hash;
}

export function readBlob(store, hash) {
  try {
    return fs.readFileSync(path.join(store.blobsDir, hash), 'utf8');
  } catch {
    return null;
  }
}

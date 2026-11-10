// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProjectService } from '../../lib/core/service.js';
import { JsonlStore, commitHash } from '../../lib/core/store.js';
import { faultFs } from './fault-fs.mjs';
import { assertIsolation, isolatedEnvironment } from './fault-isolation.mjs';

// Product constructor/createProject 的 JSDoc 仍比运行时窄；测试侧局部窄化。
const Service = /** @type {any} */ (ProjectService);
const fixture = assertIsolation();
export async function setup(t) {
  const dir = fs.mkdtempSync(path.join(fixture, 'case-'));
  const rootDir = path.join(dir, 'data');
  const ws = path.join(dir, 'workspace');
  fs.mkdirSync(ws);
  const faults = faultFs(rootDir);
  let service = new Service({ rootDir, privilegedInlineWrites: true, storeFactory: (projectDir, meta) => new JsonlStore(projectDir, meta, { fs: faults.io }) });
  await service.init();
  let handle = await /** @type {any} */ (service).createProject({ workspacePath: ws, name: 'Synthetic faults' });
  const id = handle.id;
  t.after(async () => { await service.close(); });
  return {
    faults, dir, rootDir,
    get h() { return handle; },
    async stop() { await service.close(); },
    async restart() {
      await service.close();
      const cold = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../faults/cold-replay.mjs'), rootDir, id], {
        cwd: path.resolve(import.meta.dirname, '../..'), env: isolatedEnvironment(fixture),
        encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      });
      assert.ifError(cold.error);
      assert.equal(cold.status, 0, cold.stderr);
      const replayed = JSON.parse(cold.stdout);
      service = new Service({ rootDir, privilegedInlineWrites: true });
      await service.init();
      handle = await service.open(id);
      assert.deepEqual(JSON.parse(JSON.stringify(handle.state)), replayed.state, 'fresh Node replay matches reopened service');
      assert.deepEqual([...handle.cmdIds], replayed.cmdIds, 'fresh Node cmdId index matches');
      return handle;
    },
  };
}

export function logState(h) {
  const bytes = fs.readFileSync(h.store.commitsFile, 'utf8');
  assert.ok(bytes.endsWith('\n'), 'no unterminated commit line');
  const commits = bytes.slice(0, -1).split('\n').map((line) => JSON.parse(line));
  let previous = 'genesis';
  const cmdIds = new Set();
  for (const [index, commit] of commits.entries()) {
    assert.equal(commit.seq, index + 1, 'no sequence gap or fork');
    assert.equal(commit.prev, previous);
    assert.equal(commit.hash, commitHash(commit));
    assert.ok(!cmdIds.has(commit.cmdId), 'no duplicated cmdId');
    cmdIds.add(commit.cmdId);
    previous = commit.hash;
  }
  assert.equal(h.rev, commits.length);
  assert.equal(h.lastHash, previous);
  return { bytes, commits };
}

export async function retryAndReplay(f, cmd) {
  const before = f.h.rev;
  const result = await f.h.command(cmd);
  assert.equal(result.committed, true);
  assert.equal(result.deduped, false);
  assert.equal(f.h.rev, before + 1);
  const snapshot = structuredClone(f.h.state);
  const bytes = logState(f.h).bytes;
  for (let restart = 0; restart < 2; restart++) {
    const retry = await f.h.command(cmd);
    assert.equal(retry.committed, true);
    assert.equal(retry.deduped, true);
    assert.deepEqual(retry.events, []);
    assert.equal(logState(f.h).bytes, bytes);
    await f.restart();
    assert.deepEqual(f.h.state, snapshot, 'cold replay matches committed state');
  }
  assert.equal((await f.h.command(cmd)).deduped, true);
}

// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../../lib/core/util.js';
import { openLockWriter } from '../helpers/lock-command.mjs';

const [, , dir, metaPath, resultPath, releasePath] = process.argv;
if (!releasePath) throw new Error('lock race child requires a release barrier');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const stateDir = path.dirname(path.dirname(dir));
let writer = null;
let result;
try {
  writer = await openLockWriter({ stateDir, projectId: meta.projectId });
  if (!writer.handle.readOnly) {
    await writer.checkpoint('race winner ' + process.pid, {
      cmdId: 'cmd_race_' + process.pid,
      actor: { kind: 'agent', sessionId: 'racer-' + process.pid, via: 'system' },
    });
  }
  result = {
    pid: process.pid,
    readOnly: writer.handle.readOnly,
    nonce: writer.handle.store.lockNonce,
    rev: writer.handle.rev,
  };
  writeJson(resultPath, result);
  // Keep the writer open until every contender has reported, not for an
  // arbitrary wall-clock interval that a delayed process can outlive.
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error('lock race release barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
} catch (error) {
  writeJson(resultPath, { pid: process.pid, error: String(error && error.code || error) });
} finally {
  if (writer) await writer.close();
}

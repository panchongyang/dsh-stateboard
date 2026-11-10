// @ts-check
import fs from 'node:fs';
import { JsonlStore, makeCommit } from '../../lib/core/store.js';
import { writeJson } from '../../lib/core/util.js';

const [, , dir, metaPath, resultPath, releasePath] = process.argv;
if (!releasePath) throw new Error('lock race child requires a release barrier');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const store = new JsonlStore(dir, meta, { heartbeatMs: 0 });
let result;
try {
  const data = store.open();
  if (!data.readOnly) {
    const commit = makeCommit(store.lastSeq + 1, store.lastHash, { kind: 'agent', sessionId: 'racer-' + process.pid }, 'cmd_race_' + process.pid, store.lastSeq, [
      { type: 'session/checkpoint', data: { note: 'race winner ' + process.pid } },
    ]);
    store.append(commit);
  }
  result = { pid: process.pid, readOnly: data.readOnly, nonce: store.lockNonce, rev: store.lastSeq };
  writeJson(resultPath, result);
  // Keep the store open until every contender has reported, not for an
  // arbitrary wall-clock interval that a delayed process can outlive.
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error('lock race release barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
} catch (error) {
  writeJson(resultPath, { pid: process.pid, error: String(error && error.code || error) });
} finally {
  store.close();
}

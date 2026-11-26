// Compatibility surface: historical callers can omit a timestamp. The model
// uses the same value-only envelope with its explicitly sampled transaction time.
import { nowIso } from '../util.js';
import { makeCommit as record } from '../domain/commit-envelope.js';
export { SUPPORTED_COMMIT_VERSION, validateCommit, validateCommits, commitHash, eventActor } from '../domain/commit-envelope.js';

export function makeCommit(seq, prev, actor, cmdId, baseRev, events, at = nowIso()) {
  return record(seq, prev, actor, cmdId, baseRev, events, at);
}

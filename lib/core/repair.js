import { validateCommit } from './store/format.js';
import { readJsonLines } from './util.js';

export function scanPrefix(file, { registry, projectId } = {}) {
  return readJsonLines(file, {
    salvage: true,
    validate: (commit, context) => validateCommit(commit, context, { strictEvents: true, registry, projectId }),
  });
}

/**
 * Pure repair planning for a ProjectBoard commit log.
 *
 * The CLI (scripts/repair-log.mjs) owns argv, files and printing; everything
 * that decides "what would be kept" lives here so it can be tested without
 * spawning a process or touching a real log.
 */

export function checkChain(commits) {
  let validHash = 'genesis';
  for (let i = 0; i < commits.length; i += 1) {
    try { validateCommit(commits[i], { line: i + 1, validSeq: i, validHash }); }
    catch (error) {
      const reason = error.details.reason === 'hash-mismatch' ? 'hash mismatch at line ' + (i + 1) : error.message;
      return { ok: false, index: i, reason };
    }
    validHash = commits[i].hash;
  }
  return { ok: true };
}

/**
 * @returns {{ok: true, action: 'none'|'repair', kept?: object[], dropped?: object[], ...}
 *          | {ok: false, action: 'refuse', reason: string}}
 */
export function planRepair(commits, { keep = 'tail' } = {}) {
  if (!Array.isArray(commits) || commits.length === 0) {
    return { ok: false, action: 'refuse', reason: 'the log is empty; there is nothing to repair' };
  }
  const chain = checkChain(commits);
  if (chain.ok) {
    return { ok: true, action: 'none', reason: 'log is contiguous (' + commits.length + ' commits); nothing to repair' };
  }
  if (commits[0].seq !== 1) {
    return {
      ok: false,
      action: 'refuse',
      reason: 'first commit has seq ' + commits[0].seq + ', not 1; this is not a forked tail, inspect it by hand',
    };
  }

  // First line whose seq breaks the 1..N expectation. A hash or prev failure
  // with contiguous seqs is corruption inside the chain, not a fork: refusing is
  // the only safe answer, and it is also what used to crash here.
  let bad = 0;
  while (bad < commits.length && commits[bad].seq === bad + 1) bad += 1;
  if (bad >= commits.length) {
    return {
      ok: false,
      action: 'refuse',
      reason: chain.reason + ' — seqs are contiguous, so the chain is corrupt inside rather than forked; repair-log will not guess',
    };
  }

  const dupSeq = commits[bad].seq;
  let start = commits.findIndex((commit) => commit.seq === dupSeq);
  if (start < 0) start = bad;
  let end = start;
  while (end + 1 < commits.length && commits[end + 1].seq === commits[end].seq + 1) end += 1;

  const keepHead = keep === 'head';
  const kept = keepHead
    ? commits.slice(0, start)
    : [...commits.slice(0, start), ...commits.slice(end + 1)];
  const dropped = keepHead ? commits.slice(start) : commits.slice(start, end + 1);

  if (kept.length === 0) {
    return { ok: false, action: 'refuse', reason: 'the proposed repair would leave an empty log; refusing' };
  }
  const verify = checkChain(kept);
  if (!verify.ok) {
    return { ok: false, action: 'refuse', reason: 'the proposed log still fails verification: ' + verify.reason };
  }

  return {
    ok: true,
    action: 'repair',
    problem: chain.reason,
    kept,
    dropped,
    keepHead,
    start,
    end,
    dupSeq,
  };
}

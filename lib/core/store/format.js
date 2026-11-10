// Commit format: hashing, construction and full-event replay.
//
// The commit envelope is part of the on-disk contract: field names and the hash
// recipe must never change: validateCommit() is shared by normal cold open,
// strict prefix inspection and repair planning.

import { canonicalJSON, nowIso, sha256 } from '../util.js';
import { BoardError } from '../errors.js';
import { assertCurrentSchema } from '../schema.js';
import { applyEvent, assertEventSupported, emptyState } from '../model.js';
import { assertFixedCommit } from '../documents/fixed-reference.js';

export const SUPPORTED_COMMIT_VERSION = 1;

// Normal replay and strict salvage share the same explicit compatibility table.
import { EVENT_REGISTRY } from '../../shared/events.js';

export function validateCommit(commit, context, { strictEvents = false, registry = EVENT_REGISTRY, projectId } = {}) {
  const { line, validSeq, validHash } = context;
  const fail = (reason, message, extra = {}) => {
    const version = reason === 'unsupported-version';
    throw new BoardError(version ? 'unsupported-version' : 'hash-chain-broken', message + ' at line ' + line, {
      status: version ? 409 : 503, details: { ...context, reason, ...extra },
    });
  };
  if (!commit || typeof commit !== 'object' || Array.isArray(commit)) fail('invalid-commit', 'invalid commit');
  if (commit.v !== SUPPORTED_COMMIT_VERSION) {
    fail('unsupported-version', 'unsupported log version ' + commit.v, { found: commit.v, supported: SUPPORTED_COMMIT_VERSION });
  }
  if (strictEvents && Array.isArray(commit.events)) {
    const state = { project: { id: projectId } };
    for (const event of commit.events) {
      try {
        assertEventSupported(state, event, commit, registry);
      } catch (error) {
        if (error.code !== 'incompatible-event') throw error;
        fail('unknown-event', error.message, error.details);
      }
    }
  }
  if (commit.seq !== validSeq + 1) fail('seq-mismatch', 'non-contiguous seq ' + commit.seq);
  if (commit.prev !== validHash) fail('prev-mismatch', 'broken prev hash');
  if (commitHash(commit) !== commit.hash) fail('hash-mismatch', 'bad commit hash');
  if (!Array.isArray(commit.events)) fail('invalid-events', 'commit has no events');
}

export function validateCommits(commits) {
  let validHash = 'genesis';
  for (let i = 0; i < commits.length; i++) {
    validateCommit(commits[i], { line: i + 1, validSeq: i, validHash });
    validHash = commits[i].hash;
  }
}

export function commitHash(commit) {
  const { hash, ...rest } = commit;
  return 'sha256:' + sha256(String(commit.prev) + '\n' + canonicalJSON(rest));
}

export function makeCommit(seq, prev, actor, cmdId, baseRev, events) {
  const commit = {
    v: 1,
    seq,
    prev,
    hash: '',
    at: nowIso(),
    actor,
    cmdId,
    baseRev,
    events,
  };
  commit.hash = commitHash(commit);
  return commit;
}

/**
 * Timeline attribution: an event may carry its own actor (system-generated
 * events inside a caller's commit). The commit actor stays the command caller.
 */
export function eventActor(event, commit) {
  return event.actor || commit.actor;
}

export function replay(meta, commits) {
  const state = emptyState({ ...meta.project, schemaVersion: meta.schemaVersion ?? meta.project.schemaVersion ?? 2 });
  const timeline = [];
  for (const commit of commits) {
    assertFixedCommit(state, commit);
    for (const event of commit.events) {
      applyEvent(state, structuredClone(event), commit);
      timeline.push({
        seq: commit.seq,
        at: commit.at,
        type: event.type,
        taskId: event.taskId || null,
        actor: eventActor(event, commit),
        cmdId: commit.cmdId,
      });
    }
    state.lastSeq = commit.seq;
    state.lastHash = commit.hash;
    state.project.rev = commit.seq;
  }
  assertCurrentSchema(state);
  return { state, timeline };
}

// Commit format: hashing and envelope construction.
//
// The commit envelope is part of the on-disk contract: field names and the hash
// recipe must never change: validateCommit() is shared by normal cold open,
// strict prefix inspection and repair planning.

import { canonicalJSON, sha256 } from './value-hash.js';
import { BoardError } from '../errors.js';

export const SUPPORTED_COMMIT_VERSION = 1;

// Normal replay and strict salvage share the same explicit compatibility table.
import { EVENT_REGISTRY, eventClass } from '../../shared/events.js';

function incompatibleEvent(state, event, commit, compatibility) {
  const rawType = event && event.type;
  const type = rawType !== null && typeof rawType === 'object' ? '<invalid>' : String(rawType);
  const seq = commit && Number.isInteger(commit.seq) ? commit.seq : null;
  return new BoardError(
    'incompatible-event',
    'event ' + JSON.stringify(type) + ' at seq ' + (seq === null ? '?' : seq) + ' is not readable by this build (' + compatibility + ')',
    {
      status: 409,
      details: {
        projectId: (state.project && state.project.id) || null,
        seq,
        type,
        compatibility,
        hint: compatibility === 'migration'
          ? 'run the migration for this event before opening the store'
          : 'upgrade the reader, or restore the store snapshot taken before the switch',
      },
    },
  );
}

/**
 * Enforce the event compatibility contract. Returns the class for `applied`
 * and `additive`; throws for `refuse` and `migration` (see lib/shared/events.js).
 * `registry` is injectable so the migration path is testable before it exists.
 */
export function assertEventSupported(state, event, commit = null, registry = EVENT_REGISTRY) {
  const compatibility = eventClass(event && event.type, registry);
  if (compatibility === 'applied' || compatibility === 'additive') return compatibility;
  throw incompatibleEvent(state, event, commit, compatibility);
}

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

export function makeCommit(seq, prev, actor, cmdId, baseRev, events, at) {
  if (typeof at !== 'string') throw new TypeError('record time is required');
  const commit = {
    v: 1,
    seq,
    prev,
    hash: '',
    at,
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

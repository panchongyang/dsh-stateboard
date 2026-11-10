// Intent settlement: the one place that decides whether an open work intent
// may be closed, and what the closing record must contain.
//
// RFC-3: an open intent means "side effects may have happened". Closing it is
// only allowed with an explicit `intent.outcome=stopped` declaration and a
// side-effect list (which may be empty). `unknown` never closes: the caller
// must use task.interrupt and reconcile instead.

import { BoardError } from './errors.js';
import { openIntentFor } from './model.js';

const SIDE_EFFECT_KINDS = new Set(['file', 'command', 'network', 'other']);
const MAX_SIDE_EFFECTS = 50;
const MAX_SETTLEMENT_BYTES = 16 * 1024;

export function actorRef(actor) {
  const value = actor || {};
  return {
    kind: value.kind || 'system',
    sessionId: value.sessionId || null,
    agentId: value.agentId || null,
  };
}

/**
 * Validate and copy the side-effect declarations. This is a declaration, not
 * evidence verification: the host cannot prove what the model did.
 */
export function normalizeSideEffects(input, { required = false } = {}) {
  if (input === undefined) {
    if (required) {
      throw new BoardError('invalid-command', 'intent.sideEffects is required (use [] to declare no known side effects)', { status: 400 });
    }
    return [];
  }
  if (!Array.isArray(input)) throw new BoardError('invalid-command', 'sideEffects must be an array', { status: 400 });
  if (input.length > MAX_SIDE_EFFECTS) {
    throw new BoardError('invalid-command', 'sideEffects exceeds ' + MAX_SIDE_EFFECTS + ' entries', { status: 400 });
  }
  const out = input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BoardError('invalid-command', 'sideEffects[' + index + '] must be an object', { status: 400 });
    }
    const kind = String(raw.kind || '');
    if (!SIDE_EFFECT_KINDS.has(kind)) {
      throw new BoardError('invalid-command', 'sideEffects[' + index + '].kind must be file|command|network|other', { status: 400 });
    }
    const ref = String(raw.ref || '').trim();
    if (ref === '' || ref.length > 1000) {
      throw new BoardError('invalid-command', 'sideEffects[' + index + '].ref must be 1..1000 chars', { status: 400 });
    }
    const entry = { kind, ref };
    if (raw.note !== undefined) {
      const note = String(raw.note);
      if (note.length > 500) throw new BoardError('invalid-command', 'sideEffects[' + index + '].note must be <=500 chars', { status: 400 });
      if (note !== '') entry.note = note;
    }
    if (raw.hash !== undefined) {
      const hash = String(raw.hash);
      if (!/^[a-f0-9]{64}$/i.test(hash)) {
        throw new BoardError('invalid-command', 'sideEffects[' + index + '].hash must be a sha256 hex digest', { status: 400 });
      }
      entry.hash = hash.toLowerCase();
    }
    return entry;
  });
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_SETTLEMENT_BYTES) {
    throw new BoardError('invalid-command', 'sideEffects exceeds ' + MAX_SETTLEMENT_BYTES + ' bytes', { status: 400 });
  }
  return out;
}

/**
 * Return the `work/abandoned` event for a governance command, or null when
 * there is no open intent. Throws intent-unresolved when the command would
 * close an open intent without a `stopped` declaration.
 */
export function settleOpenIntent(handle, task, cmd, closeReason, at, lease = null) {
  const intent = openIntentFor(handle.state, task.id);
  if (!intent) {
    if (cmd.intent !== undefined) {
      throw new BoardError('invalid-command', 'intent settlement is only valid while an intent is open', { status: 400, details: { taskId: task.id } });
    }
    return null;
  }
  const raw = cmd.intent;
  const outcome = raw && typeof raw === 'object' ? raw.outcome : undefined;
  if (outcome !== 'stopped') {
    throw new BoardError(
      'intent-unresolved',
      'open intent ' + intent.id + ' cannot be closed by ' + closeReason + '; declare intent.outcome=stopped with sideEffects, or use task.interrupt',
      {
        status: 409,
        details: {
          taskId: task.id,
          intentId: intent.id,
          outcome: outcome === undefined ? 'missing' : String(outcome),
          hint: 'use task.interrupt, then task.reconcile(resume|completed|discard)',
          allowedOps: ['task.interrupt'],
        },
      },
    );
  }
  const sideEffects = normalizeSideEffects(raw.sideEffects, { required: true });
  return {
    type: 'work/abandoned',
    taskId: task.id,
    data: {
      ...intent,
      status: 'abandoned',
      closeReason,
      outcome: 'stopped',
      sideEffects,
      settlementNote: String(raw.note || cmd.note || cmd.reason || '').slice(0, 2000),
      closedAt: at,
      closedBy: actorRef(cmd.actor),
      token: lease ? lease.token : intent.token,
    },
  };
}

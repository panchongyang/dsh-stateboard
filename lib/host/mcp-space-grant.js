// Local issuance only; the operator retains the grant outside the workspace and hands only the bearer to the caller.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from '../core/errors.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const scopes = new Set(['metadata', 'full']);
const bindingProof = (token, { spaceRoot, directoryKey, scope }) => createHmac('sha256', token)
  .update(JSON.stringify([spaceRoot, directoryKey, scope])).digest('hex');
function rootIdentity(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('An absolute space root is required');
  const spaceRoot = fs.realpathSync.native(root), stat = fs.statSync(spaceRoot, { bigint: true });
  if (!stat.isDirectory() || stat.ino <= 0n) throw new TypeError('An identifiable space directory is required');
  return { spaceRoot, directoryKey: stat.dev + ':' + stat.ino };
}

export function issueSpaceGrant(root, scope) {
  if (!scopes.has(scope)) throw new TypeError('Specify metadata or full permission explicitly');
  const identity = rootIdentity(root), token = randomBytes(32).toString('hex');
  const grant = { ...identity, scope, tokenHash: digest(token) };
  return { token, grant: Object.freeze({ ...grant, bindingProof: bindingProof(token, grant) }) };
}

/** The HTTP boundary supplies only a bearer. The workspace and permissions come exclusively from operator configuration. */
export function spaceGrantFor(grants, authorization) {
  if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/i.test(authorization)) return null;
  const hash = digest(authorization.slice(7));
  const matching = () => { const rows = typeof grants === 'function' ? grants() : grants;
    return Array.isArray(rows) ? rows.filter(g => g?.tokenHash === hash) : []; };
  const matches = matching();
  if (matches.length !== 1 || matches[0].bindingProof !== bindingProof(authorization.slice(7), matches[0])) return null;
  const { spaceRoot, directoryKey, scope, bindingProof: proof } = matches[0];
  if (!scopes.has(scope)) return null;
  const stillGranted = () => {
    const rows = matching();
    return rows.length === 1 && rows[0].bindingProof === proof && rows[0].scope === scope && rows[0].spaceRoot === spaceRoot && rows[0].directoryKey === directoryKey;
  };
  const assertCurrent = () => {
    if (stillGranted()) try {
      const actual = rootIdentity(spaceRoot);
      if (actual.spaceRoot === spaceRoot && actual.directoryKey === directoryKey) return;
    } catch { /* An unavailable root never authorizes its replacement. */ }
    throw new BoardError('project-forbidden', 'The bound workspace or credential is unavailable', { status: 403 });
  };
  try { assertCurrent(); } catch { return null; }
  // P3-only asynchronous assertion: same operator configuration and proof,
  // asynchronous realpath/stat so projection scans never block the caller.
  const assertCurrentAsync = async () => {
    if (!stillGranted()) throw new BoardError('project-forbidden', 'The bound workspace or credential is unavailable', { status: 403 });
    let actual;
    try {
      const resolved = await fs.promises.realpath(spaceRoot);
      const stat = await fs.promises.stat(resolved, { bigint: true });
      actual = stat.isDirectory() && stat.ino > 0n ? { spaceRoot: resolved, directoryKey: stat.dev + ':' + stat.ino } : null;
    } catch { actual = null; }
    if (!actual || !stillGranted() || actual.spaceRoot !== spaceRoot || actual.directoryKey !== directoryKey) {
      throw new BoardError('project-forbidden', 'The bound workspace or credential is unavailable', { status: 403 });
    }
  };
  return Object.freeze({ spaceRoot, scope, tokenHash: hash, assertCurrent, assertCurrentAsync });
}

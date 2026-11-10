// @ts-check
// Historical signing format, only for replay fixtures; never imported by runtime.
import crypto from 'node:crypto';
const activeKey = Buffer.from('11'.repeat(32), 'hex');
const FIELDS = [
  'executor', 'status', 'exitCode', 'signal', 'timedOut',
  'stdoutHash', 'stderrHash', 'outputBytes', 'commandHash',
  'executedAt', 'cwd', 'taskId', 'attempt', 'intentId', 'token', 'proofVersion',
];

function canonical(execution) {
  const out = {};
  for (const field of FIELDS) out[field] = execution[field] ?? null;
  return JSON.stringify(out);
}

export function signExecution(execution, key = activeKey) {
  return crypto.createHmac('sha256', key).update(canonical(execution)).digest('hex');
}

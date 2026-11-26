/**
 * Maintenance-script rules. A read/inventory script may not take a production
 * writer; a dry-run script may not reach a writer before its gate; an apply/ops
 * script must name its gate and use the public command/ops entry, never the
 * private append/state API.
 */
import { chainOf, collectImports, lineOf, propertyTarget, walkNode } from './ast.mjs';
import { buildRawAliases } from './lib-rules.mjs';
import { FS_WRITE_CALLS, PRIVATE_WRITE_CALLS, RULES } from './config.mjs';

export function checkScriptFile(ts, rel, sourceFile, source, policy, report) {
  const modes = policy && Array.isArray(policy.modes) ? policy.modes : [];
  const hasMode = (name) => modes.includes(name);
  const fsCalls = [];
  const boardCalls = [];
  const privateCalls = [];
  let gateLine = null;
  let firstBoardWriterLine = null;
  const rawAliases = buildRawAliases(ts, sourceFile);

  // A dynamic module load is only a bypass in a mutating maintenance path;
  // build/test tooling may resolve its own compiler without touching the board.
  if (modes.includes('apply') || modes.includes('ops')) {
    for (const dynamic of collectImports(ts, sourceFile).dynamic) {
      report(RULES.dynamicImport, dynamic.line, 'non-literal module specifier cannot be proven safe', rel);
    }
  }

  walkNode(ts, sourceFile, (node) => {
    const line = lineOf(sourceFile, node);
    if (ts.isCallExpression(node)) {
      const chain = chainOf(ts, node.expression);
      const name = chain ? chain[chain.length - 1] : null;
      if (!name) return;
      if (FS_WRITE_CALLS.has(name) || ['atomicWrite', 'writeJson', 'ensureDir', 'writeBlob'].includes(name)) {
        fsCalls.push({ name, line });
      }
      if (PRIVATE_WRITE_CALLS.has(name) || rawAliases.has(name)) privateCalls.push({ name, line, kind: 'call' });
      const writerOpen = name === 'open' && chain && chain.some((part) => ['service', 'svc', 'runtime', 'handle'].includes(part));
      if (['openByWorkspace', 'createProject', 'command', 'touch', 'attach', 'detach'].includes(name) || writerOpen) {
        boardCalls.push({ name, line });
        if (firstBoardWriterLine === null) firstBoardWriterLine = line;
      }
      if (name === 'append' && chain && chain.some((part) => part === 'store')) {
        boardCalls.push({ name: 'store.append', line });
        privateCalls.push({ name: 'store.append', line, kind: 'call' });
        if (firstBoardWriterLine === null) firstBoardWriterLine = line;
      }
      if (name === 'eval' || name === 'Function') {
        report(RULES.dynamicCall, line, 'dynamic call cannot be proven safe: ' + name, rel);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = propertyTarget(ts, node.left);
      if (target && target.name === 'state' && target.chain && !['options', 'config', 'result'].includes(target.chain[0])) {
        privateCalls.push({ name: 'state-assignment', line, kind: 'state' });
      }
    }
    if (ts.isIfStatement(node) && node.expression) {
      const text = source.slice(node.expression.getStart(sourceFile), node.expression.getEnd());
      const gates = policy && Array.isArray(policy.gate) ? policy.gate : [];
      const hit = gates.find((gate) => text.includes(gate))
        || (/\b(dryRun|apply|isApply)\b/.test(text) ? text : null);
      if (hit && gateLine === null) gateLine = line;
    }
  });

  const gateMode = policy && policy.gateMode === 'command' ? 'command' : 'flag';
  const allGateTokensPresent = !policy || !Array.isArray(policy.gate)
    || policy.gate.some((token) => source.includes(token));
  if ((hasMode('apply') || hasMode('ops')) && policy && Array.isArray(policy.gate) && !allGateTokensPresent) {
    report(RULES.scriptMissingGate, 1, 'apply/ops script contains none of its declared gate tokens: ' + policy.gate.join(', '), rel);
  }

  const isolatedCopy = policy && policy.isolation === 'temp-copy';
  const isolatedSynthetic = policy && policy.isolation && /synthetic|isolated|fixture/i.test(policy.isolation);
  const readOnlyModes = modes.every((mode) => ['read', 'inventory', 'tooling'].includes(mode));

  if (readOnlyModes) {
    const allowedBoard = isolatedCopy ? new Set(['open', 'openByWorkspace']) : new Set();
    for (const call of boardCalls) {
      if (!allowedBoard.has(call.name)) {
        report(RULES.scriptReadWriter, call.line, 'read/inventory script takes a writer capability (' + call.name + ') without declaring apply', rel);
      }
    }
    if (hasMode('read')) {
      for (const call of fsCalls) {
        report(RULES.scriptFsWrite, call.line, 'pure read script performs a filesystem write (' + call.name + ')', rel);
      }
    }
  }

  if (hasMode('dry-run') && gateMode === 'flag') {
    if (gateLine === null) {
      report(RULES.scriptMissingGate, 1, 'dry-run script has no flag-gated apply branch', rel);
    } else if (firstBoardWriterLine !== null && firstBoardWriterLine < gateLine) {
      report(RULES.scriptDryRunWriter, firstBoardWriterLine, 'writer capability is reached before the dry-run/apply gate at line ' + gateLine, rel);
    }
  }
  if (hasMode('dry-run') && gateMode === 'command' && firstBoardWriterLine !== null && !allGateTokensPresent) {
    report(RULES.scriptMissingGate, 1, 'command-gated script has no declared apply command token', rel);
  }

  if (!isolatedSynthetic) {
    for (const call of privateCalls) {
      report(RULES.scriptPrivateWrite, call.line, 'private write/state bypass in a maintenance script: ' + call.name, rel);
    }
  }
  return { rel, modes, boardWrites: boardCalls.length, fsWrites: fsCalls.length, privateWrites: privateCalls.length };
}

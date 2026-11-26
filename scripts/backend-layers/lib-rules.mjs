/**
 * Per-file backend rules: import direction, capability receivers, state
 * ownership, published-value mutation, write bypass, query writes and
 * ambient time. The report callback is shared with the entry point.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  chainOf, collectImports, collectTainted, lineOf, propertyTarget, toRel, unwrap, walkNode,
} from './ast.mjs';
import { buildAliases, buildRefs, classifyCall, dynamicCall } from './capabilities.mjs';
import {
  COMMAND_FORBIDDEN_IMPORTS, COMMAND_FORBIDDEN_RETURN_FIELDS, COMMAND_HANDLER_NAME,
  COMMAND_PLAN_CALLBACKS, COMMAND_PLAN_VALUE_FIELDS, COMMAND_PRE_ACTIVITY, COMMAND_WRITE_FUNCTION, FORBIDDEN_IMPORTS,
  FS_WRITE_CALLS, HOST_ACTIVITY_LIFECYCLE_FILES, HOST_LIFECYCLE_FILES, HOST_LIFECYCLE_METHODS,
  MODEL_LAYERS, NO_GO_LAYERS, PRIVATE_WRITE_CALLS, PURE_LAYERS, RAW_WRITE_ALLOW,
  PUBLIC_COMMAND_NAMES, RAW_WRITE_DEFINITIONS, RAW_WRITE_METHODS, READER_LAYERS, REPLAY_BUILDERS, RULES, isIoBuiltin, layerOf,
} from './config.mjs';

function importTarget(root, file, spec) {
  if (spec.startsWith('lib/')) {
    const base = path.join(root, spec);
    const candidates = [base, base + '.js', base + '.mjs', path.join(base, 'index.js')];
    const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    return found ? toRel(root, found) : null;
  }
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(file), spec);
  const candidates = [base];
  for (const ext of ['.js', '.mjs', '.cjs']) candidates.push(base + ext);
  for (const ext of ['.js', '.mjs', '.cjs']) candidates.push(path.join(base, 'index' + ext));
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (found) return toRel(root, found);
  return null;
}

function isMethodDefinition(ts, node) {
  return Boolean(node.parent && (ts.isMethodDeclaration(node.parent) || ts.isPropertyAssignment(node.parent))
    && node.parent.name === node.expression);
}

export function buildRawAliases(ts, sourceFile) {
  const aliases = new Set();
  const candidates = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      candidates.push([node.name.text, node.initializer]);
    } else if (ts.isAssignmentExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(unwrap(ts, node.left))) {
      candidates.push([unwrap(ts, node.left).text, node.right]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, init] of candidates) {
      if (aliases.has(name)) continue;
      const chain = chainOf(ts, init);
      const last = chain ? chain[chain.length - 1] : null;
      if ((last && RAW_WRITE_METHODS.has(last)) || (ts.isIdentifier(unwrap(ts, init)) && aliases.has(unwrap(ts, init).text))) {
        aliases.add(name);
        changed = true;
      }
    }
  }
  return aliases;
}

function functionName(ts, node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

function exportName(ts, node) {
  if (!ts.isFunctionDeclaration(node) || !node.name || !ts.isIdentifier(node.name)) return null;
  const exported = (ts.getModifiers?.(node) || node.modifiers || []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return exported ? node.name.text : null;
}

function isCommandFile(rel) {
  return rel.startsWith('lib/core/commands/') && rel !== 'lib/core/commands/transaction.js';
}

function commandEventVariables(ts, sourceFile) {
  const names = new Set();
  const candidates = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      const object = ts.isObjectLiteralExpression(node.initializer) ? node.initializer : null;
      const hasEvents = object && object.properties.some((property) => property.name && ts.isIdentifier(property.name) && property.name.text === 'events');
      if (/^(events|authoritativeEvents|pendingEvents|committedEvents)$/.test(name) || hasEvents) {
        names.add(name);
        candidates.push([name, node.initializer]);
      } else if (ts.isIdentifier(unwrap(ts, node.initializer))) {
        candidates.push([name, node.initializer]);
      }
    }
    if (ts.isAssignmentExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = propertyTarget(ts, node.left);
      if (target && COMMAND_FORBIDDEN_RETURN_FIELDS.has(target.name) && target.chain) names.add(target.chain[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, init] of candidates) {
      if (names.has(name)) continue;
      if (ts.isIdentifier(unwrap(ts, init)) && names.has(unwrap(ts, init).text)) { names.add(name); changed = true; }
    }
  }
  return names;
}

function commandSurfaceChecks(ts, rel, sourceFile, imports, root, file, report) {
  if (!isCommandFile(rel)) return;
  const eventNames = commandEventVariables(ts, sourceFile);

  for (const entry of imports) {
    const target = importTarget(root, file, entry.spec);
    if (target && COMMAND_FORBIDDEN_IMPORTS.has(target)) {
      report(RULES.commandImport, entry.line, 'command layer may not import implementation entry ' + target, rel);
    }
  }

  walkNode(ts, sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node)) {
      const exported = exportName(ts, node);
      if (exported && COMMAND_WRITE_FUNCTION.test(exported)) {
        report(RULES.commandWriteFunction, lineOf(sourceFile, node), 'command layer must not export arbitrary write function ' + exported, rel);
      }
      if (exported && COMMAND_HANDLER_NAME.test(exported) && node.parameters.length > 0
        && ts.isIdentifier(node.parameters[0].name)
        && ['handle', 'work', 'writer', 'model', 'store', 'state'].includes(node.parameters[0].name.text)) {
        report(RULES.commandSurface, lineOf(sourceFile, node), 'command handler receives raw writable context ' + node.parameters[0].name.text, rel);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && /^(events|authoritativeEvents|pendingEvents|committedEvents)$/.test(node.name.text)) {
      report(RULES.eventAssembly, lineOf(sourceFile, node), 'command layer must not build an authoritative events array', rel);
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const expression = unwrap(ts, node.expression);
      if (ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
          if (ts.isSpreadAssignment(property)) {
            const spread = unwrap(ts, property.expression);
            if (ts.isIdentifier(spread) && (COMMAND_FORBIDDEN_RETURN_FIELDS.has(spread.text) || eventNames.has(spread.text))) {
              report(RULES.eventAssembly, lineOf(sourceFile, property), 'command result spreads raw ' + spread.text, rel);
            }
            continue;
          }
          if (property.name && ts.isIdentifier(property.name) && COMMAND_FORBIDDEN_RETURN_FIELDS.has(property.name.text)) {
            report(RULES.eventAssembly, lineOf(sourceFile, property), 'command result returns forbidden field ' + property.name.text, rel);
          }
          if (property.name && ts.isIdentifier(property.name) && eventNames.has(property.name.text)) {
            report(RULES.eventAssembly, lineOf(sourceFile, property), 'command result returns assembled events', rel);
          }
        }
      } else if (ts.isIdentifier(expression)
        && (COMMAND_FORBIDDEN_RETURN_FIELDS.has(expression.text) || eventNames.has(expression.text))) {
        report(RULES.eventAssembly, lineOf(sourceFile, node), 'command result returns raw ' + expression.text, rel);
      }
    }
  });
}

function isTransactionModel(rel) {
  return rel === 'lib/core/model.js' || rel.startsWith('lib/core/transaction/');
}

function functionLike(ts, node) {
  return Boolean(node) && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** Public command assembly must be value-only; function-valued plan fields are callbacks. */
function commandPlanChecks(ts, rel, sourceFile, report) {
  walkNode(ts, sourceFile, (node) => {
    if (!ts.isFunctionDeclaration(node) || !node.name || !ts.isIdentifier(node.name) || node.name.text !== 'assembleCommand') return;
    walkNode(ts, node.body, (inner) => {
      if (!ts.isReturnStatement(inner) || !inner.expression) return;
      const value = unwrap(ts, inner.expression);
      if (!ts.isObjectLiteralExpression(value)) return;
      for (const property of value.properties) {
        const name = property.name && ts.isIdentifier(property.name) ? property.name.text : null;
        const callback = ts.isMethodDeclaration(property)
          || (ts.isPropertyAssignment(property) && functionLike(ts, unwrap(ts, property.initializer)))
          || (name && COMMAND_PLAN_CALLBACKS.has(name));
        if (callback) {
          report(RULES.commandPlanCallback, lineOf(sourceFile, property), 'command plan exposes a callable ' + (name || '<method>') + '; pass value operations only', rel);
        }
      }
    });
  });
}

/** Model/transaction must not import or call command assembly/handlers. */
function modelCommandChecks(ts, rel, sourceFile, imports, report) {
  if (!isTransactionModel(rel)) return;
  for (const entry of imports) {
    if (entry.spec.startsWith('./commands/') || entry.spec.startsWith('../commands/')) {
      report(RULES.modelCommandCallback, entry.line, 'model/transaction imports command assembly from ' + entry.spec, rel);
    }
  }
  walkNode(ts, sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const chain = chainOf(ts, node.expression);
    const name = chain ? chain[chain.length - 1] : null;
    const receiver = chain && chain.length > 1 ? chain[0] : null;
    if (name && ['assembleCommand', 'submitCommand', 'COMMAND_HANDLERS'].includes(name)) {
      report(RULES.modelCommandCallback, lineOf(sourceFile, node), 'model/transaction calls command assembly ' + name + '()', rel);
    }
    if (receiver && ['plan', 'assembled', 'candidate'].includes(receiver)) {
      report(RULES.modelCommandCallback, lineOf(sourceFile, node), 'model/transaction calls command callback ' + chain.join('.') + '()', rel);
    }
  });
  walkNode(ts, sourceFile, (node) => {
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.name)) return;
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) return;
    const chain = chainOf(ts, node);
    const receiver = chain && chain.length > 1 ? chain[0] : null;
    if (chain && chain.length === 2 && receiver && ['plan', 'assembled', 'candidate'].includes(receiver) && !COMMAND_PLAN_VALUE_FIELDS.has(node.name.text)) {
      report(RULES.modelCommandCallback, lineOf(sourceFile, node), 'model/transaction reads callable command plan field ' + chain.join('.'), rel);
    }
  });
}

/** Host write helper must not attach/record/touch before application.command. */
function preCommandActivityChecks(ts, rel, sourceFile, report) {
  if (!rel.startsWith('lib/host/') || HOST_ACTIVITY_LIFECYCLE_FILES.has(rel)) return;
  walkNode(ts, sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const chain = chainOf(ts, node.expression);
    const name = chain ? chain[chain.length - 1] : null;
    if (name && COMMAND_PRE_ACTIVITY.has(name)) {
      report(RULES.preCommandActivity, lineOf(sourceFile, node), 'host helper performs ' + name + '() before the command; use an isolated lifecycle/init capability', rel);
    }
  });
}

/** Domain operations receive assembled values, never command names or command handlers. */
function operationsCommandNameChecks(ts, rel, sourceFile, imports, report) {
  if (!rel.startsWith('lib/core/domain/operations/')) return;
  for (const entry of imports) {
    if (entry.spec.includes('/commands/')) report(RULES.operationsCommandName, entry.line, 'domain operation imports command handlers from ' + entry.spec, rel);
  }
  const aliases = new Set(['cmd', 'request', 'command', 'req']);
  const isAlias = (node) => ts.isIdentifier(node) && aliases.has(node.text);
  let changed = true;
  while (changed) {
    changed = false;
    walkNode(ts, sourceFile, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isAlias(unwrap(ts, node.initializer))) {
        if (!aliases.has(node.name.text)) { aliases.add(node.name.text); changed = true; }
      }
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && aliases.has(node.name.text)) return;
    });
  }
  walkNode(ts, sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      const chain = chainOf(ts, node.expression);
      const name = chain ? chain[chain.length - 1] : null;
      if (name && ['requireCommand', 'COMMAND_HANDLERS', 'assembleCommand', 'submitCommand'].includes(name)) {
        report(RULES.operationsCommandName, lineOf(sourceFile, node), 'domain operation calls command helper ' + name + '()', rel);
      }
    }
    if (ts.isStringLiteral(node) && PUBLIC_COMMAND_NAMES.has(node.text)) {
      const parent = node.parent;
      const named = (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name) && ['op', 'cmd', 'command', 'commandName'].includes(parent.name.text))
        || (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
        || (ts.isCallExpression(parent) && chainOf(ts, parent.expression)?.at(-1) === 'requireCommand');
      if (named) report(RULES.operationsCommandName, lineOf(sourceFile, node), 'domain operation reads public command name ' + JSON.stringify(node.text), rel);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && node.name.text === 'op' && isAlias(unwrap(ts, node.expression))) {
      report(RULES.operationsCommandName, lineOf(sourceFile, node), 'domain operation reads command op ' + node.expression.getText(sourceFile) + '.op', rel);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'op' && isAlias(unwrap(ts, node.expression))) {
      report(RULES.operationsCommandName, lineOf(sourceFile, node), 'domain operation reads command op []', rel);
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isAlias(unwrap(ts, node.initializer))) {
      for (const element of node.name.elements) {
        const prop = element.propertyName ?? element.name;
        if (ts.isIdentifier(prop) && prop.text === 'op') report(RULES.operationsCommandName, lineOf(sourceFile, element), 'domain operation destructures command op', rel);
      }
    }
  });
}

export function checkLibFile(ts, root, file, sourceFile, report) {
  const rel = toRel(root, file);
  const layer = layerOf(rel);
  if (layer === null) {
    report(RULES.unknownLayer, 1, 'unclassified lib path; add it to LAYER_PREFIXES after deciding its layer', rel);
    return { layer: 'unknown', imports: 0 };
  }
  const { imports, dynamic } = collectImports(ts, sourceFile);
  const tainted = collectTainted(ts, sourceFile);
  const refs = buildRefs(ts, sourceFile, imports);
  const aliases = buildAliases(ts, sourceFile, refs);
  const fileLayer = layer;
  const stateWriter = MODEL_LAYERS.has(fileLayer) || REPLAY_BUILDERS.has(rel);
  const lifecycleFile = HOST_LIFECYCLE_FILES.has(rel);
  const rawAliases = buildRawAliases(ts, sourceFile);
  const rawAllowed = RAW_WRITE_ALLOW[rel] || new Set();
  let forbiddenRawDefinition = false;

  for (const entry of dynamic) {
    report(RULES.dynamicImport, entry.line, 'non-literal module specifier cannot be proven safe', rel);
  }

  for (const entry of imports) {
    // Builtin checks run before resolution: a bare fs import has no local target.
    if (NO_GO_LAYERS.has(fileLayer) && isIoBuiltin(entry.spec)) {
      report(RULES.layerIo, entry.line, fileLayer + ' must not import a Node builtin (' + entry.spec + ')', rel);
    }
    const targetRel = importTarget(root, file, entry.spec);
    if (!targetRel) continue;
    const targetLayer = layerOf(targetRel);
    if (targetLayer === null) {
      report(RULES.unknownLayer, entry.line, 'imports an unclassified lib module: ' + targetRel, rel);
      continue;
    }
    if (targetLayer === 'generated-client') continue;
    const forbidden = FORBIDDEN_IMPORTS[fileLayer];
    if (forbidden && forbidden.has(targetLayer)) {
      report(RULES.forbiddenImport, entry.line, fileLayer + ' must not import ' + targetLayer + ' (' + targetRel + ')', rel);
    }
    if (NO_GO_LAYERS.has(fileLayer) && ['node:fs', 'fs', 'node:child_process', 'child_process'].includes(entry.spec)) {
      report(RULES.layerIo, entry.line, fileLayer + ' must not do filesystem/process I/O (' + entry.spec + ')', rel);
    }
  }

  walkNode(ts, sourceFile, (node) => {
    const declared = functionName(ts, node);
    if (declared && RAW_WRITE_DEFINITIONS.has(declared) && !rawAllowed.has(declared)) {
      forbiddenRawDefinition = true;
      report(RULES.rawWrite, lineOf(sourceFile, node), 'raw write function ' + declared + '() is not authorized in this module', rel);
    }
  });

  commandSurfaceChecks(ts, rel, sourceFile, imports, root, file, report);
  commandPlanChecks(ts, rel, sourceFile, report);
  modelCommandChecks(ts, rel, sourceFile, imports, report);
  preCommandActivityChecks(ts, rel, sourceFile, report);
  operationsCommandNameChecks(ts, rel, sourceFile, imports, report);

  walkNode(ts, sourceFile, (node) => {
    const line = lineOf(sourceFile, node);

    if (ts.isCallExpression(node)) {
      const dyn = dynamicCall(ts, node, refs);
      if (dyn) report(RULES.dynamicCall, line, 'dynamic call cannot be proven safe: ' + dyn, rel);
      const chain = chainOf(ts, node.expression);
      const name = chain ? chain[chain.length - 1] : null;
      if (name && !isMethodDefinition(ts, node)) {
        const classification = classifyCall(ts, node, refs);
        if (classification && classification.safe === false) {
          const exempt = rel === 'lib/core/application/index.js'
            || (lifecycleFile && HOST_LIFECYCLE_METHODS.has(name));
          if (!exempt && (fileLayer === 'host' || fileLayer === 'application')) {
            report(RULES.hostCapability, line, 'ordinary ingress must not call ' + name + '() on a ' + classification.kind + ' receiver', rel);
          }
        }
        if (aliases.forbidden.has(name) && (fileLayer === 'host' || fileLayer === 'application')) {
          report(RULES.capabilityAlias, line, 'calls forbidden capability alias ' + name + ' (' + aliases.forbidden.get(name) + ')', rel);
        }
      }

      if (name && RAW_WRITE_METHODS.has(name) && !rawAllowed.has(name) && !forbiddenRawDefinition) {
        report(RULES.rawWrite, line, 'raw write entry ' + name + '() is not authorized in this module', rel);
      }
      if (name && rawAliases.has(name)) {
        report(RULES.rawWriteAlias, line, 'raw write alias ' + name + '() bypasses the named operation entry', rel);
      }
      if (name && PRIVATE_WRITE_CALLS.has(name)) {
        const allowed = rel === 'lib/core/handle.js' || rel.startsWith('lib/core/transaction/')
          || rel.startsWith('lib/core/store/') || rel === 'lib/core/store.js';
        if (!allowed && !forbiddenRawDefinition) report(RULES.writeBypass, line, 'private write entry ' + name + '() outside the transaction/model publisher', rel);
      }
      if (name === 'append' && chain && chain.some((part) => part === 'store') && !rel.startsWith('lib/core/store')) {
        report(RULES.writeBypass, line, 'store.append() outside the persistence/transaction boundary', rel);
      }
      if (name === 'acquireLock' || name === 'touchLock') {
        if (['reader', 'projection', 'business', 'model', 'host', 'command', 'application'].includes(fileLayer)) {
          report(RULES.queryWrite, line, name + '() acquires/renews a write lock from a non-writer layer', rel);
        }
      }
      if (READER_LAYERS.has(fileLayer) && (FS_WRITE_CALLS.has(name) || ['atomicWrite', 'writeJson', 'ensureDir', 'writeBlob'].includes(name))) {
        report(RULES.queryWrite, line, fileLayer + ' must not perform a filesystem/commit write (' + name + ')', rel);
      }
      if (PURE_LAYERS.has(fileLayer) && name === 'now' && chain && chain[0] === 'Date' && node.arguments.length === 0) {
        report(RULES.ambientTime, line, fileLayer + ' must receive time from the caller, not Date.now()', rel);
      }
      if (PURE_LAYERS.has(fileLayer) && name === 'now' && chain && chain[0] === 'performance') {
        report(RULES.ambientTime, line, fileLayer + ' must not read performance.now()', rel);
      }
      if (fileLayer === 'projection' && name === 'now' && chain && chain[0] === 'Date' && node.arguments.length === 0) {
        report(RULES.ambientTime, line, 'projection must not read the system clock', rel);
      }
      if (fileLayer === 'projection' && ts.isNewExpression(node) && chainOf(ts, node.expression)?.[0] === 'Date'
        && (!node.arguments || node.arguments.length === 0)) {
        report(RULES.ambientTime, line, 'projection must not construct new Date() from ambient time', rel);
      }
    }

    if (ts.isNewExpression(node) && chainOf(ts, node.expression)?.[0] === 'Date'
      && (!node.arguments || node.arguments.length === 0) && PURE_LAYERS.has(fileLayer)) {
      report(RULES.ambientTime, line, fileLayer + ' must not construct new Date() from ambient time', rel);
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = propertyTarget(ts, node.left);
      if (!target) return;
      const property = target.name;
      const chain = target.chain;
      if (property === 'state' && !stateWriter) {
        report(RULES.stateWrite, line, 'entity/project state is assigned outside the model layer', rel);
        return;
      }
      if (property !== 'state' && !stateWriter && chain) {
        const rootName = chain[0];
        if (tainted.has(rootName) || chain.includes('state')) {
          report(RULES.publishedMutation, line, 'writes ' + chain.join('.') + ' through a published/committed value', rel);
        }
      }
    }

    if (ts.isDeleteExpression(node)) {
      const target = propertyTarget(ts, node.expression);
      if (target) {
        if (target.name === 'state' && !stateWriter) {
          report(RULES.stateWrite, line, 'deletes entity/project state outside the model layer', rel);
        } else if (!stateWriter && target.chain) {
          const rootName = target.chain[0];
          if (tainted.has(rootName) || target.chain.includes('state')) {
            report(RULES.publishedMutation, line, 'deletes a field of a published/committed value: ' + target.chain.join('.') + '.' + target.name, rel);
          }
        }
      }
    }

    if (ts.isCallExpression(node) && chainOf(ts, node.expression)?.[0] === 'Object'
      && chainOf(ts, node.expression)?.[1] === 'assign' && node.arguments.length >= 2) {
      const targetArg = node.arguments[0];
      const chain = chainOf(ts, targetArg);
      if (!stateWriter && chain && (tainted.has(chain[0]) || chain.includes('state'))) {
        report(RULES.publishedMutation, line, 'Object.assign() mutates a published/committed value', rel);
      }
    }
  });

  return { layer, imports: imports.length };
}

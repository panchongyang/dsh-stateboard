/**
 * Reference classification for writer capabilities.
 *
 * The gate must distinguish app.command(...) (the application entry) from
 * service.command(...) / handle.command(...) and from a helper such as
 * resolveHandle (...). A method name alone is not enough; the receiver is
 * resolved from imports, constructor calls, factories, destructuring,
 * assignments and function parameters.
 */
import { chainOf } from './ast.mjs';
import {
  COMMAND_METHODS, HANDLE_HELPERS, HANDLE_ONLY_METHODS, SAFE_RECEIVERS,
} from './config.mjs';

function last(chain) {
  return chain && chain.length ? chain[chain.length - 1] : null;
}

function includesAny(chain, names) {
  return Boolean(chain) && chain.some((part) => names.includes(part));
}

/** Read a member chain's receiver; the final member is the method. */
export function receiverChain(chain) {
  return chain ? chain.slice(0, -1) : null;
}

export function receiverKind(chain, refs) {
  if (!chain || chain.length < 2) return 'unknown';
  const receiver = chain.slice(0, -1);
  const root = receiver[0];
  if (refs && refs.has(root)) return refs.get(root);
  if (receiver.includes('capabilities')) return 'application';
  if (root === 'this') {
    if (receiver.includes('service')) return 'service';
    if (receiver.includes('handle')) return 'handle';
    if (receiver.includes('application')) return 'application';
    return 'unknown';
  }
  if (['service', 'svc'].includes(root) || receiver.includes('service')) return 'service';
  if (root === 'handle' || receiver.includes('handle')) return 'handle';
  if (['app', 'application', 'facade'].includes(root) || receiver.includes('application')) return 'application';
  if (['source', 'ingress'].includes(root)) return 'safe-port';
  return 'unknown';
}

function classifyInitializer(ts, init, refs) {
  const chain = chainOf(ts, init);
  if (chain && chain.length) {
    if (chain[0] === 'new' && chain[1] === 'ProjectService') return 'service';
    if (chain[0] === 'new' && chain[1] === 'ProjectHandle') return 'handle';
    if (chain.includes('capabilities')) return 'application';
    if (chain[0] === 'runtime' && chain[1] === 'service') return 'service';
    if (chain[0] === 'runtime' && chain[1] === 'application') return 'application';
    if (chain.includes('service')) return 'service';
    if (chain.includes('handle')) return 'handle';
    if (chain.includes('application')) return 'application';
    return null;
  }
  const current = ts.isParenthesizedExpression(init) ? init.expression : init;
  if (ts.isAwaitExpression(current)) return classifyInitializer(ts, current.expression, refs);
  if (ts.isCallExpression(current)) {
    const callee = chainOf(ts, current.expression);
    const name = last(callee);
    if (name === 'resolveHandle' || name === 'requireHandle') return 'handle';
    if (['open', 'openByWorkspace', 'createProject'].includes(name)) return 'handle';
    if (['createApplication', 'applicationFor'].includes(name)) return 'application';
  }
  if (ts.isNewExpression(current)) {
    const callee = chainOf(ts, current.expression);
    const name = last(callee);
    if (name === 'ProjectService') return 'service';
    if (name === 'ProjectHandle') return 'handle';
  }
  return null;
}

/**
 * Build identifier -> origin class for one file. Names are a fallback only
 * when the value comes from a parameter; every local binding is classified
 * from its initializer/import.
 */
export function buildRefs(ts, sourceFile, imports) {
  const refs = new Map();
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.importClause && node.importClause.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        const imported = element.propertyName ? element.propertyName.text : element.name.text;
        if (imported === 'ProjectService') refs.set(element.name.text, 'service');
        if (imported === 'ProjectHandle') refs.set(element.name.text, 'handle');
        if (imported === 'createApplication') refs.set(element.name.text, 'application');
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const kind = classifyInitializer(ts, node.initializer, refs);
        if (kind) refs.set(node.name.text, kind);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          if (element.name.text === 'service') refs.set(element.name.text, 'service');
          if (element.name.text === 'handle') refs.set(element.name.text, 'handle');
          if (element.name.text === 'application') refs.set(element.name.text, 'application');
        }
      }
    }
    if (ts.isAssignmentExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      const kind = classifyInitializer(ts, node.right, refs);
      if (kind) refs.set(node.left.text, kind);
    }
    if (ts.isFunctionLike(node) && node.parameters) {
      for (const parameter of node.parameters) {
        if (!ts.isIdentifier(parameter.name)) continue;
        if (parameter.name.text === 'service' || parameter.name.text === 'svc') refs.set(parameter.name.text, 'service');
        if (parameter.name.text === 'handle') refs.set(parameter.name.text, 'handle');
        if (parameter.name.text === 'app' || parameter.name.text === 'application') refs.set(parameter.name.text, 'application');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return refs;
}

/** Classify one call expression's capability shape. */
export function classifyCall(ts, node, refs) {
  if (!ts.isCallExpression(node)) return null;
  const chain = chainOf(ts, node.expression);
  if (!chain || chain.length < 1) return null;
  const method = last(chain);
  if (method === '()') return null;
  const kind = receiverKind(chain, refs);
  const safeReceiver = kind === 'application' || kind === 'safe-port'
    || SAFE_RECEIVERS.has(chain[0] || '') || Boolean(chain.includes('capabilities'));
  const writerReceiver = kind === 'service' || kind === 'handle'
    || includesAny(chain, ['service', 'handle']) || ['service', 'svc', 'handle'].includes(chain[0] || '');
  if (HANDLE_HELPERS.has(method)) {
    return { method, kind, safe: false, reason: 'handle-helper' };
  }
  if (HANDLE_ONLY_METHODS.has(method)) {
    if (safeReceiver) return { method, kind, safe: true };
    if (writerReceiver) return { method, kind, safe: false, reason: 'writer-receiver' };
    return { method, kind, safe: null };
  }
  if (COMMAND_METHODS.has(method)) {
    if (safeReceiver) return { method, kind, safe: true };
    if (writerReceiver) return { method, kind, safe: false, reason: 'writer-receiver' };
    return { method, kind, safe: null };
  }
  return null;
}

/**
 * Collect aliases such as const cmd = handle.command. A forbidden alias is
 * remembered so a later cmd(...) call cannot hide the writer capability.
 */
export function buildAliases(ts, sourceFile, refs) {
  const forbidden = new Map();
  const safe = new Set();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = ts.isPropertyAccessExpression(node.initializer) || ts.isElementAccessExpression(node.initializer)
        ? node.initializer
        : null;
      if (init) {
        const chain = chainOf(ts, init);
        const method = last(chain);
        if (method && (HANDLE_HELPERS.has(method) || HANDLE_ONLY_METHODS.has(method) || COMMAND_METHODS.has(method))) {
          const kind = receiverKind(chain, refs);
          const safeReceiver = kind === 'application' || kind === 'safe-port'
            || SAFE_RECEIVERS.has(chain[0] || '') || Boolean(chain.includes('capabilities'));
          if (safeReceiver) safe.add(node.name.text);
          else forbidden.set(node.name.text, method);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { forbidden, safe };
}

/** Dynamic calls that could hide a proven capability: eval/Function and computed member calls on writer receivers. */
export function dynamicCall(ts, node, refs) {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return null;
  const chain = chainOf(ts, node.expression);
  const name = last(chain);
  if (name === 'eval') return 'eval';
  if (name === 'Function') return 'Function';
  if (ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)) {
    const argument = node.expression.argumentExpression;
    if (!argument || !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      const objectChain = chainOf(ts, node.expression.expression);
      const kind = objectChain ? receiverKind([...objectChain, '__call__'], refs) : 'unknown';
      if (kind === 'service' || kind === 'handle') return 'computed-writer-call';
    }
  }
  return null;
}

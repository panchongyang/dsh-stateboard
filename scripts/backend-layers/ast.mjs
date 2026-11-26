/**
 * TypeScript AST helpers. The parser is the repository toolchain
 * (tools/typescript), never a runtime dependency; strings and comments are
 * never treated as code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const SOURCE_EXT = ['.js', '.mjs'];
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let cachedTypeScript = null;
export function typeScript() {
  if (cachedTypeScript) return cachedTypeScript;
  const requireFromToolchain = createRequire(path.join(REPO_ROOT, 'tools', 'typescript', 'package.json'));
  try {
    cachedTypeScript = requireFromToolchain('typescript');
  } catch {
    throw new Error('[backend-layers] TypeScript parser missing; run: npm --prefix tools/typescript ci --ignore-scripts');
  }
  return cachedTypeScript;
}

export function toRel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

export function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

export function parse(ts, file) {
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return { source, sourceFile };
}

export function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function isStringLike(ts, node) {
  return Boolean(node) && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

export function unwrap(ts, node) {
  let current = node;
  while (current && (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  )) current = current.expression;
  return current;
}

/** a.b.c / a['b'].c -> ['a','b','c']; null for computed or complex roots. */
export function chainOf(ts, node) {
  const current = unwrap(ts, node);
  if (!current) return null;
  if (ts.isIdentifier(current)) return [current.text];
  if (ts.isPropertyAccessExpression(current)) {
    const base = chainOf(ts, current.expression);
    return base ? [...base, current.name.text] : null;
  }
  if (ts.isElementAccessExpression(current) && isStringLike(ts, current.argumentExpression)) {
    const base = chainOf(ts, current.expression);
    return base ? [...base, current.argumentExpression.text] : null;
  }
  if (ts.isCallExpression(current)) {
    const base = chainOf(ts, current.expression);
    return base ? [...base, '()'] : null;
  }
  return null;
}

export function walkNode(ts, node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walkNode(ts, child, visit));
}

export function propertyTarget(ts, node) {
  const target = unwrap(ts, node);
  if (!target) return null;
  if (ts.isPropertyAccessExpression(target)) {
    return { chain: chainOf(ts, target), name: target.name.text };
  }
  if (ts.isElementAccessExpression(target) && isStringLike(ts, target.argumentExpression)) {
    return { chain: chainOf(ts, target), name: target.argumentExpression.text };
  }
  return null;
}

export function isStateExpression(ts, node, tainted) {
  const chain = chainOf(ts, node);
  if (chain) {
    if (chain.includes('state')) return true;
    if (chain.length >= 2 && ['handle', 'store', 'model', 'snapshot', 'view'].includes(chain[0])
      && ['tasks', 'docs', 'plans', 'planHeads', 'timeline', 'commits', 'leases', 'bindings', 'intents'].includes(chain[1])) return true;
    if (tainted && tainted.has(chain[0])) return true;
  }
  const current = unwrap(ts, node);
  if (current && ts.isCallExpression(current)) {
    const callee = chainOf(ts, current.expression);
    if (callee && ['structuredClone', 'clone', 'detachValue'].includes(callee[callee.length - 1])) return false;
    if (callee && ['readStateWithoutLock', 'committedSnapshot', 'snapshot'].includes(callee[callee.length - 1])) return true;
  }
  return false;
}

export function collectTainted(ts, sourceFile) {
  const tainted = new Set();
  const candidates = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      candidates.push([node.name.text, node.initializer]);
    } else if (ts.isAssignmentExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(unwrap(ts, node.left)) && node.right) {
      candidates.push([unwrap(ts, node.left).text, node.right]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, init] of candidates) {
      if (tainted.has(name)) continue;
      if (isStateExpression(ts, init, tainted)) { tainted.add(name); changed = true; }
    }
  }
  return tainted;
}

export function collectImports(ts, sourceFile) {
  const imports = [];
  const dynamic = [];
  walkNode(ts, sourceFile, (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && isStringLike(ts, node.moduleSpecifier)) {
        imports.push({ spec: node.moduleSpecifier.text, line: lineOf(sourceFile, node.moduleSpecifier) });
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (argument && ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        imports.push({ spec: argument.literal.text, line: lineOf(sourceFile, argument.literal) });
      }
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(ts, node.expression);
      if (callee && (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))) {
        const argument = node.arguments[0];
        if (isStringLike(ts, argument)) imports.push({ spec: argument.text, line: lineOf(sourceFile, argument) });
        else dynamic.push({ line: lineOf(sourceFile, node), kind: 'non-literal-import' });
      }
    }
  });
  return { imports, dynamic };
}

export function resolveLocal(spec, fromFile) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  for (const ext of ['.js', '.mjs', '.cjs']) candidates.push(base + ext);
  for (const ext of ['.js', '.mjs', '.cjs']) candidates.push(path.join(base, 'index' + ext));
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

export function importTarget(root, fromFile, spec) {
  if (spec.startsWith('lib/')) {
    const candidate = path.join(root, spec);
    for (const ext of ['', '.js', '.mjs']) {
      if (fs.existsSync(candidate + ext) && fs.statSync(candidate + ext).isFile()) return toRel(root, candidate + ext);
    }
    return null;
  }
  const target = resolveLocal(spec, fromFile);
  if (target && target.startsWith(path.join(root, 'lib'))) return toRel(root, target);
  return null;
}

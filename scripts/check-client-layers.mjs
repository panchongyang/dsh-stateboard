#!/usr/bin/env node
/**
 * Client-half layering gate.
 *
 * The target layout is pages/components/hooks/model/utils/api (see
 * docs/modules/client/design.md). This checker enforces the cross-layer
 * directions, same-layer cycles, the single fetch boundary and the file-size
 * ceiling. During S3 the flat src/client root and views/ are "legacy": they
 * keep the global rules (fetch/node/lib boundaries, size) but skip the layer
 * matrix. `--strict` is the closeout gate: every non-keep legacy file fails.
 *
 * Imports and fetch calls are read from the TypeScript compiler AST (already
 * an isolated dev dependency in tools/typescript), so strings, comments, JSX
 * text, template expressions and computed access cannot hide or fake a rule.
 * Missing toolchain is a hard error rather than a silent skip.
 *
 * Usage:
 *   npm --prefix tools/typescript ci --ignore-scripts
 *   node scripts/check-client-layers.mjs
 *   node scripts/check-client-layers.mjs --strict
 *   node scripts/check-client-layers.mjs --json
 *   node scripts/check-client-layers.mjs --root <repo>
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAYERS = ['pages', 'components', 'hooks', 'model', 'utils', 'api'];
const ALLOWED = {
  pages: new Set(['pages', 'components', 'hooks', 'model', 'utils', 'api']),
  components: new Set(['components', 'model', 'utils']),
  hooks: new Set(['api', 'model', 'utils']),
  model: new Set(['model', 'utils']),
  utils: new Set(['utils']),
  api: new Set(['api', 'model', 'utils']),
};
const REACT_FORBIDDEN = new Set(['model', 'utils', 'api']);
const KEEP_FILES = new Set([
  'index.ts',
  'styles.ts',
  // Ambient host React declarations have no runtime layer or dependency edges.
  'react.d.ts', 'css.d.ts',
]);
const SOURCE_EXT = ['.js', '.jsx', '.ts', '.tsx'];
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => 'node:' + name)]);
const FETCH_ALLOWED = new Set([
  'src/client/transport.js',
  'src/client/transport.ts',
  'src/client/api/transport.js',
  'src/client/api/transport.jsx',
  'src/client/api/transport.ts',
  'src/client/api/transport.tsx',
]);
const MAX_FILE_LINES = 450;

let cachedTypeScript = null;

function typeScript() {
  if (cachedTypeScript) return cachedTypeScript;
  const requireFromToolchain = createRequire(path.join(REPO_ROOT, 'tools', 'typescript', 'package.json'));
  try {
    cachedTypeScript = requireFromToolchain('typescript');
  } catch {
    throw new Error('[client-layers] TypeScript parser missing; run: npm --prefix tools/typescript ci --ignore-scripts');
  }
  return cachedTypeScript;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function toRel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function scriptKind(ts, file) {
  const ext = path.extname(file);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.ts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function lineOf(ts, sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isStringLike(ts, node) {
  return Boolean(node) && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

function isFetchExpression(ts, node) {
  if (ts.isIdentifier(node) && node.text === 'fetch') return true;
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'fetch') return true;
  if (ts.isElementAccessExpression(node) && isStringLike(ts, node.argumentExpression) && node.argumentExpression.text === 'fetch') return true;
  return false;
}

function unwrapExpression(ts, node) {
  let current = node;
  while (current && (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  )) {
    current = current.expression;
  }
  return current;
}

function resolveLocal(spec, fromFile) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  for (const ext of SOURCE_EXT) candidates.push(base + ext);
  if (/\.(?:js|jsx|ts|tsx)$/.test(base)) {
    const stem = base.replace(/\.(?:js|jsx|ts|tsx)$/, '');
    for (const ext of SOURCE_EXT) candidates.push(stem + ext);
  }
  for (const ext of SOURCE_EXT) candidates.push(path.join(base, 'index' + ext));
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function layerOf(relClient) {
  const first = relClient.split('/')[0];
  return LAYERS.includes(first) ? first : 'legacy';
}

function cycleViolations(graph, root) {
  const color = new Map();
  const stack = [];
  const violations = [];
  const seen = new Set();
  function visit(node) {
    color.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (!color.has(dep)) visit(dep);
      else if (color.get(dep) === 1) {
        const at = stack.indexOf(dep);
        const cycle = stack.slice(at).concat(dep);
        const key = [...new Set(cycle)].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          violations.push({
            file: toRel(root, cycle[0]),
            line: 1,
            rule: 'cycle',
            message: 'import cycle: ' + cycle.map((file) => toRel(root, file)).join(' -> '),
          });
        }
      }
    }
    stack.pop();
    color.set(node, 2);
  }
  for (const node of graph.keys()) if (!color.has(node)) visit(node);
  return violations;
}

/** Collect imports and fetch calls from one parsed file. */
function scanFile(ts, sourceFile, report) {
  function visit(node) {
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (argument && ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        report.import(argument.literal.text, lineOf(ts, sourceFile, argument.literal));
      } else {
        report.nonLiteral(lineOf(ts, sourceFile, node));
      }
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier) {
        if (isStringLike(ts, specifier)) report.import(specifier.text, lineOf(ts, sourceFile, specifier));
        else report.nonLiteral(lineOf(ts, sourceFile, specifier));
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (isStringLike(ts, expression)) report.import(expression.text, lineOf(ts, sourceFile, expression));
      else report.nonLiteral(lineOf(ts, sourceFile, node));
    } else if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(ts, node.expression);
      if (callee && (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))) {
        const argument = node.arguments[0];
        if (isStringLike(ts, argument)) report.import(argument.text, lineOf(ts, sourceFile, argument));
        else report.nonLiteral(lineOf(ts, sourceFile, node));
      }
      if (isFetchExpression(ts, callee)) report.fetch(lineOf(ts, sourceFile, node));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

export function checkClientLayers(options = {}) {
  const ts = typeScript();
  const root = path.resolve(options.root || REPO_ROOT);
  const strict = options.strict === true;
  const clientDir = path.join(root, 'src', 'client');
  const files = walk(clientDir).sort();
  const violations = [];
  const legacy = [];
  const graph = new Map();
  const layerCounts = Object.fromEntries(LAYERS.map((layer) => [layer, 0]));

  for (const file of files) {
    const relClient = toRel(clientDir, file);
    const relRepo = toRel(root, file);
    const layer = layerOf(relClient);
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
    const parseErrors = (sourceFile.parseDiagnostics || []).slice(0, 1);
    const lineCount = source.replace(/\n$/, '').split('\n').length;
    if (layer === 'legacy') legacy.push(relClient);
    else layerCounts[layer] += 1;
    if (parseErrors.length) {
      const diagnostic = parseErrors[0];
      const line = diagnostic.start === undefined
        ? 1
        : sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
      violations.push({ file: relRepo, line, rule: 'parse-error', message: `cannot parse: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}` });
    }
    if (lineCount > MAX_FILE_LINES) {
      violations.push({ file: relRepo, line: 1, rule: 'size', message: `file has ${lineCount} lines (max ${MAX_FILE_LINES})` });
    }
    if (strict && layer === 'legacy' && !KEEP_FILES.has(relClient)) {
      violations.push({ file: relRepo, line: 1, rule: 'legacy', message: 'legacy path; move it under pages/components/hooks/model/utils/api' });
    }

    const deps = [];
    const addViolation = (line, rule, message) => violations.push({ file: relRepo, line, rule, message });
    scanFile(ts, sourceFile, {
      import(value, line) {
        if (value.startsWith('node:') || BUILTINS.has(value)) {
          addViolation(line, 'node-builtin', `forbidden Node builtin import: ${value}`);
          return;
        }
        if (value === 'react' || value.startsWith('react/')) {
          if (REACT_FORBIDDEN.has(layer)) addViolation(line, 'react-layer', `React is not allowed in ${layer}/`);
          return;
        }
        if (value === 'lib/shared' || value.startsWith('lib/shared/')) return;
        if (value === 'lib/core' || value.startsWith('lib/core/') || value === 'lib/host' || value.startsWith('lib/host/')) {
          addViolation(line, 'backend-import', `client must not import ${value}`);
          return;
        }
        if (!value.startsWith('.')) {
          addViolation(line, 'external', `unexpected client dependency: ${value}`);
          return;
        }
        const target = resolveLocal(value, file);
        if (!target) {
          addViolation(line, 'unresolved', `unresolved relative import: ${value}`);
          return;
        }
        const targetRel = toRel(root, target);
        if (inside(clientDir, target)) {
          deps.push(target);
          if (layer !== 'legacy') {
            const targetLayer = layerOf(toRel(clientDir, target));
            if (targetLayer === 'legacy') {
              addViolation(line, 'layered-to-legacy', `layered code must not import legacy ${targetRel}`);
            } else if (targetLayer !== layer && !ALLOWED[layer].has(targetLayer)) {
              addViolation(line, 'cross-layer', `${layer}/ must not import ${targetLayer}/ (${targetRel})`);
            }
          }
        } else if (!targetRel.startsWith('lib/shared/')) {
          addViolation(line, 'outside-client', `relative import leaves src/client: ${targetRel}`);
        }
      },
      nonLiteral(line) {
        addViolation(line, 'non-literal-import', 'import specifier must be a plain string');
      },
      fetch(line) {
        if (!FETCH_ALLOWED.has(relRepo)) {
          addViolation(line, 'fetch', 'fetch() is only allowed in src/client/api/transport.*');
        }
      },
    });
    graph.set(file, deps);
  }

  violations.push(...cycleViolations(graph, root));
  const unique = [];
  const seenViolation = new Set();
  for (const violation of violations) {
    const key = `${violation.file}:${violation.line}:${violation.rule}:${violation.message}`;
    if (!seenViolation.has(key)) { seenViolation.add(key); unique.push(violation); }
  }
  return {
    ok: unique.length === 0,
    mode: strict ? 'strict' : 'migration',
    files: files.length,
    legacy,
    layers: layerCounts,
    cycles: unique.filter((violation) => violation.rule === 'cycle').length,
    violations: unique,
  };
}

function printHuman(result) {
  const layered = Object.entries(result.layers).filter(([, count]) => count > 0)
    .map(([layer, count]) => `${layer}=${count}`).join(' ');
  console.log(`[client-layers] mode=${result.mode} files=${result.files} legacy=${result.legacy.length} ${layered} cycles=${result.cycles} violations=${result.violations.length}`);
  for (const violation of result.violations) {
    console.log(`  ${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`);
  }
  if (result.mode === 'migration' && result.legacy.length > 0) {
    console.log('[client-layers] legacy paths are exempt from the layer matrix until S3; use --strict at closeout.');
  }
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/check-client-layers.mjs [--strict] [--json] [--root <repo>]');
    return 0;
  }
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? REPO_ROOT : path.resolve(argv[rootIndex + 1] || '');
  const result = checkClientLayers({ root, strict: argv.includes('--strict') });
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error('[client-layers] ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  }
}

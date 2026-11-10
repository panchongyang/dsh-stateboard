#!/usr/bin/env node
/** 测试规模硬门禁：tracked .test.mjs；物理行含注释/空行，函数按 TypeScript AST 起止行（含回调）。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { root, trackedTests } from '../test/suite-manifest.mjs';

const require = createRequire(import.meta.url);
const ts = require(require.resolve('typescript', { paths: [path.join(root, 'tools/typescript')] }));
export const limits = { file: 600, function: 150 };
// Explicit, non-growing physical-line ceilings; never auto-update these values.
// When a file reaches <=600, remove its baseline entry (stale entries fail).
export const baseline = {
  'test/client/unit/bundle-logic.test.mjs': 781,
  'test/client/unit/external-docs.test.mjs': 607,
  'test/client/unit/logic.test.mjs': 883,
  'test/docs/evidence-audit.test.mjs': 860,
};

export function measureSource(text, file = 'synthetic.test.mjs') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw new Error(`${file}: invalid JavaScript: ${source.parseDiagnostics[0].messageText}`);
  const lines = text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
  const functions = [];
  function visit(node) {
    if (ts.isFunctionLike(node) && node.body) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.end - 1).line + 1;
      functions.push({ line: start, lines: end - start + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { file, lines, functions };
}

export function violations(metrics) {
  const ceiling = baseline[metrics.file] ?? limits.file;
  return [
    ...(baseline[metrics.file] && metrics.lines <= limits.file ? [`${metrics.file}: stale baseline; remove the exception`] : []),
    ...(metrics.lines > ceiling ? [`${metrics.file}: ${metrics.lines} file lines > ${ceiling}`] : []),
    ...metrics.functions.filter(fn => fn.lines > limits.function)
      .map(fn => `${metrics.file}:${fn.line}: ${fn.lines} function lines > ${limits.function}`),
  ];
}

export function checkFiles(files = trackedTests()) {
  if (!files.length) throw new Error('No tracked test files; refusing an empty scan');
  const metrics = files.map(file => measureSource(fs.readFileSync(path.resolve(root, file), 'utf8'), file));
  const failures = metrics.flatMap(violations);
  const largest = [...metrics].sort((a, b) => b.lines - a.lines)[0];
  const functions = metrics.flatMap(metric => metric.functions.map(fn => ({ ...fn, file: metric.file }))).sort((a, b) => b.lines - a.lines);
  console.log(`[test-size] ${metrics.length} tracked files / ${functions.length} AST functions; limits file=${limits.file}, function=${limits.function}`);
  console.log(`[test-size] largest file ${largest.file}: ${largest.lines}; largest function ${functions[0]?.file}:${functions[0]?.line}: ${functions[0]?.lines}`);
  for (const [file, ceiling] of Object.entries(baseline)) console.log(`[test-size] non-growing baseline ${file}: ${ceiling}`);
  for (const [min, max] of [[0, 200], [200, 400], [400, 600], [600, Infinity]]) {
    console.log(`[test-size] files (${min},${max}]: ${metrics.filter(metric => metric.lines > min && metric.lines <= max).length}`);
  }
  for (const ceiling of [50, 100, 150, 200, Infinity]) {
    const floor = ceiling === 50 ? 0 : ceiling === Infinity ? 200 : ceiling - 50;
    console.log(`[test-size] functions (${floor},${ceiling}]: ${functions.filter(fn => fn.lines > floor && fn.lines <= ceiling).length}`);
  }
  failures.forEach(message => console.error(message));
  return failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = checkFiles(process.argv.slice(2).length ? process.argv.slice(2) : undefined); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

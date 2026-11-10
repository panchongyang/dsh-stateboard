#!/usr/bin/env node
/**
 * 检查测试入口的四字段中文头注释和逐例责任说明；只读源码，不加载或执行测试。
 * Git 清单是公开测试范围，无法取得清单时才遍历 test，并始终排除 helpers/fixtures。
 * 本检查只保证结构和最低信息量；注释是否准确、是否只是复述标题仍须人工阅读。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fields = ['测试职责', '典型流程', '覆盖边界', '外部前置'];
const isEntrypoint = (file) => /^test\/.*\.mjs$/.test(file) && !/^test\/(helpers|fixtures)\//.test(file);

/** 返回仓库相对路径；不纳入 Git 正常可用时的未跟踪私有测试。 */
export function findEntrypoints(root = repositoryRoot, { git = 'git' } = {}) {
  let names;
  try {
    names = execFileSync(git, ['ls-files', '-z', '--', 'test'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').filter(Boolean);
  } catch {
    // 非 Git 源码副本也能检查；不跟随符号链接，防止遍历到工作区外。
    names = [];
    const walk = (directory, relative) => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = relative + '/' + entry.name;
        if (entry.isDirectory() && !/^test\/(helpers|fixtures)$/.test(name)) walk(path.join(directory, entry.name), name);
        else if (entry.isFile()) names.push(name);
      }
    };
    walk(path.join(root, 'test'), 'test');
  }
  return [...new Set(names.map((file) => file.replaceAll('\\', '/')).filter(isEntrypoint))].sort();
}

/**
 * 屏蔽注释、字符串/模板及正则字面量，保留换行和偏移，避免把合成反例或 RegExp.test 算成用例。
 * 这是针对 test()/test.skip()/test.todo() 的轻量词法检查，不解释动态别名或运行时生成代码。
 */
function sourceCode(source) {
  const chars = source.split('');
  const comments = new Map();
  let i = 0, line = 1, expressionStart = true;
  const hide = (start, end) => {
    for (let n = start; n < end; n++) if (chars[n] !== '\n' && chars[n] !== '\r') chars[n] = ' ';
  };
  while (i < source.length) {
    const ch = source[i], next = source[i + 1];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (i === 0 && ch === '#' && next === '!') {
      const start = i;
      while (i < source.length && source[i] !== '\n') i++;
      hide(start, i); continue;
    }
    if (ch === '/' && next === '/') {
      const start = i;
      while (i < source.length && source[i] !== '\n') i++;
      comments.set(line, source.slice(start, i));
      hide(start, i); continue;
    }
    if (ch === '/' && next === '*') {
      const start = i; i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i = Math.min(source.length, i + 2); hide(start, i); continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          if (source[i + 1] === '\n') line++;
          i += 2; continue;
        }
        if (source[i] === '\n') line++;
        if (source[i++] === ch) break;
      }
      hide(start, i); expressionStart = false; continue;
    }
    if (ch === '/' && expressionStart) {
      const start = i++;
      let bracket = false;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') bracket = true;
        if (source[i] === ']') bracket = false;
        if (source[i++] === '/' && !bracket) break;
      }
      while (/[a-z]/i.test(source[i] || '') && i < source.length) i++;
      hide(start, i); expressionStart = false; continue;
    }
    if (/[\w$]/.test(ch)) {
      const start = i++;
      while (i < source.length && /[\w$]/.test(source[i])) i++;
      expressionStart = /^(return|throw|case|delete|void|typeof|yield|await|in|of)$/.test(source.slice(start, i));
      continue;
    }
    expressionStart = /[({\[,:;=!?&|+*%~^<>-]/.test(ch);
    i++;
  }
  return { code: chars.join(''), comments };
}

/** 检查一份源码，返回带文件名和 1-based 行号的诊断，不执行该源码。 */
export function checkSource(source, { file = '<source>' } = {}) {
  const errors = [];
  const fail = (line, message) => errors.push({ file, line, message });
  const header = /^\uFEFF?(?:#![^\n]*(?:\n|$))?\s*(\/\*\*[\s\S]*?\*\/)/.exec(source)?.[1];
  if (!header) fail(1, '缺少 import 之前的四字段头注释');
  for (const field of fields) {
    const value = header && new RegExp('^\\s*\\*\\s*' + field + '：([^\\r\\n]*)', 'm').exec(header)?.[1].trim();
    if (!value || (value.length < 4 && !(field === '外部前置' && value === '无'))) {
      fail(1, '头注释缺少或过短字段：' + field);
    } else if (!/[\u3400-\u9fff]/.test(value)) {
      fail(1, '头注释字段须有中文说明：' + field);
    }
    if (field === '覆盖边界' && value && !/覆盖\s*\S[\s\S]*[；;]\s*不覆盖\s*\S/.test(value)) {
      fail(1, '覆盖边界须明确写出“覆盖 …；不覆盖 …”');
    }
  }
  const { code, comments } = sourceCode(source);
  let testCount = 0;
  for (const match of code.matchAll(/(?<![\w$.])test\s*(?:\.\s*(?:skip|todo)\s*)?\(/g)) {
    testCount++;
    const line = code.slice(0, match.index).split('\n').length;
    const documented = [line - 1, line - 2, line - 3].some((number) => {
      const note = /^\/\/\s*责任：\s*(.+?)\s*$/.exec(comments.get(number) || '')?.[1];
      return note && note.length >= 4 && /[\u3400-\u9fff]/.test(note);
    });
    if (!documented) fail(line, 'test 用例上方 1–3 行缺少非空中文 // 责任：说明');
  }
  if (!testCount && ![...comments.values()].some((comment) => /^\/\/\s*分段职责：\s*\S/.test(comment))) {
    fail(1, '无 test() 的入口须为关键步骤提供 // 分段职责：中文说明');
  }
  return { ok: errors.length === 0, file, testCount, errors };
}

/** 聚合所有 tracked 入口；读取失败也作为该文件的诊断，不静默漏扫。 */
export function checkAll(root = repositoryRoot, options = {}) {
  const files = findEntrypoints(root, options);
  const results = files.map((file) => {
    try { return checkSource(fs.readFileSync(path.join(root, file), 'utf8'), { file }); }
    catch (error) { return { file, testCount: 0, errors: [{ file, line: 1, message: '无法读取入口：' + error.message }] }; }
  });
  const errors = results.flatMap((result) => result.errors);
  if (!files.length) errors.push({ file: 'test/', line: 1, message: '未发现测试入口，拒绝空扫描通过' });
  return { ok: errors.length === 0, files, fileCount: files.length, testCount: results.reduce((sum, result) => sum + result.testCount, 0), errors };
}

/** 两个反例都来自独立临时目录；不读取真实仓库，结果不依赖当前测试注释。 */
export function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-test-docs-'));
  const header = '/**\n * 测试职责：限定合成输入的返回值。\n * 典型流程：构造输入 → 调用函数 → 比较返回值。\n * 覆盖边界：覆盖 合成值；不覆盖 外部服务。\n * 外部前置：无\n */\n';
  try {
    fs.mkdirSync(path.join(root, 'test'));
    const cases = [
      ['missing-header.mjs', header.replace(' * 典型流程：构造输入 → 调用函数 → 比较返回值。\n', '') + "// 责任：输入固定值后返回原值，不执行外部命令。\ntest('fixture', () => {});\n", '典型流程'],
      ['missing-case.mjs', header + "test('fixture', () => {});\n", '责任'],
    ];
    for (const [name, source, expected] of cases) {
      fs.writeFileSync(path.join(root, 'test', name), source);
      const result = checkSource(fs.readFileSync(path.join(root, 'test', name), 'utf8'), { file: name });
      assert.equal(result.ok, false, name + ' 应失败');
      assert.ok(result.errors.some((error) => error.message.includes(expected)), name + ' 应定位缺失原因');
    }
    const result = checkAll(root, { git: path.join(root, 'git-not-installed') });
    assert.equal(result.fileCount, 2);
    assert.equal(result.ok, false);
    assert.equal(result.testCount, 2);
    return 'PASS self-test: 缺头字段、缺用例责任均被拒绝（独立临时目录）';
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--self-test')) console.log(selfTest());
    else {
      const result = checkAll();
      for (const error of result.errors) console.error(`${error.file}:${error.line}: ${error.message}`);
      if (!result.ok) process.exitCode = 1;
      else console.log(`PASS test-docs: ${result.fileCount} files / ${result.testCount} test() cases`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

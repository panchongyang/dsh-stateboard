/**
 * 测试职责：验证 P3 投影扫描使用的 Git ignore 纯函数契约：编译、匹配、预算与失败关闭。
 * 典型流程：编译合成 ignore 文本 → 对合成相对路径调用 isIgnored → 断言布尔值或抛错码。
 * 覆盖边界：覆盖 行语法、锚定/目录规则、双星/字符类/转义、ASCII POSIX 类、UTF-8 字节语义、base 作用域、否定顺序、预算与非法输入；不覆盖 文件读取、realpath 与父目录不下钻（由扫描器负责）。
 * 外部前置：无（纯函数与合成字符串，不读写文件系统）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileIgnore, isIgnored, IGNORE_LIMITS, IgnoreError } from '../../lib/core/reader/discovery/ignore-rules.js';

const BS = '\\';
const ignore = (text, path, isDirectory = false, base = '') => isIgnored(compileIgnore(text, base), path, isDirectory);

// 责任：确认注释、空行、行尾空格与转义字面量按 Git 规则被跳过或保留。
test('ignore lines: comments, blanks, trailing spaces and escaped literals', () => {
  const rules = compileIgnore('# comment\n\n   \n*.log\n');
  assert.equal(rules.length, 1);
  assert.equal(isIgnored(rules, 'a/x.log', false), true);
  assert.equal(isIgnored(rules, 'a/x.txt', false), false);
  assert.equal(ignore('\\#hash', '#hash'), true);
  assert.equal(ignore('\\!bang', '!bang'), true);
  assert.equal(ignore('foo   ', 'foo'), true);
  assert.equal(ignore('foo   ', 'foo '), false);
  assert.equal(ignore('foo' + BS + ' ', 'foo '), true);
  assert.equal(ignore('foo' + BS + ' ', 'foo'), false);
  assert.equal(ignore('x' + BS + ' y', 'x y'), true);
  assert.equal(ignore('a' + BS + '*b', 'a*b'), true);
  assert.equal(ignore('a' + BS + '*b', 'axb'), false);
  assert.equal(ignore('[]]', ']'), true);
  assert.equal(ignore('[' + BS + ']]', ']'), true);
  assert.equal(ignore('[a' + BS + '-c]', '-'), true);
  assert.equal(ignore('[a-c]', '-'), false);
});

// 责任：确认格式非法的规则在编译期以 ignore-invalid 失败关闭，并带上行号。
test('malformed patterns fail closed with ignore-invalid', () => {
  const malformed = ['[', '[]', '[!]', '[z-a]', 'a//b', 'a' + BS, '!', '/', '//a', 'a' + BS + '/b', 'a//'];
  for (const pattern of malformed) {
    assert.throws(() => compileIgnore(pattern), { code: 'ignore-invalid' }, JSON.stringify(pattern));
  }
  try {
    compileIgnore('ok.md\n[broken\n');
    assert.fail('expected IgnoreError');
  } catch (error) {
    assert.ok(error instanceof IgnoreError);
    assert.equal(error.code, 'ignore-invalid');
    assert.equal(error.line, 2);
  }
  assert.throws(() => compileIgnore('ok.md\0'), { code: 'ignore-invalid' });
  assert.throws(() => compileIgnore(null), { code: 'ignore-invalid' });
});

// 责任：确认文本字节、规则条数、单条模式与 base 深度超预算时以 ignore-oversize 失败关闭。
test('over-budget input fails closed with ignore-oversize', () => {
  const atLimit = Array.from({ length: IGNORE_LIMITS.rules }, (_, index) => 'f' + index).join('\n');
  assert.equal(compileIgnore(atLimit).length, IGNORE_LIMITS.rules);
  assert.throws(() => compileIgnore(atLimit + '\nextra'), { code: 'ignore-oversize' });
  assert.throws(() => compileIgnore('#'.repeat(IGNORE_LIMITS.textBytes + 1)), { code: 'ignore-oversize' });
  assert.doesNotThrow(() => compileIgnore('a'.repeat(IGNORE_LIMITS.patternChars)));
  assert.throws(() => compileIgnore('a'.repeat(IGNORE_LIMITS.patternChars + 1)), { code: 'ignore-oversize' });
  const deepBase = Array.from({ length: IGNORE_LIMITS.baseSegments }, () => 'd').join('/');
  assert.doesNotThrow(() => compileIgnore('', deepBase));
  assert.throws(() => compileIgnore('', deepBase + '/d'), { code: 'ignore-oversize' });
  assert.throws(() => compileIgnore('a', Array.from({ length: 128 }, () => 'd').join('/')), { code: 'ignore-oversize' });
});

// 责任：确认非法 baseRelPath 在编译期失败关闭，而不是被静默当成根目录。
test('invalid baseRelPath fails closed', () => {
  for (const base of ['/', 'a/', '/a', 'a//b', 'a/./b', 'a/../b', 'a' + BS + 'b', 'a\0b', 42, null]) {
    assert.throws(() => compileIgnore('*.md', base), { code: 'ignore-invalid' }, String(base));
  }
});

// 责任：确认基名规则匹配任意深度、带斜杠规则锚定、前导斜杠锚定到 base 根。
test('basename patterns match any depth; slash patterns are anchored', () => {
  assert.equal(ignore('*.log', 'x.log'), true);
  assert.equal(ignore('*.log', 'a/b/x.log'), true);
  assert.equal(ignore('*.log', 'a/b/x.txt'), false);
  assert.equal(ignore('*.log', 'a/b/x.log', true), true);
  assert.equal(ignore('build', 'a/build', true), true);
  assert.equal(ignore('build', 'a/build', false), true);
  assert.equal(ignore('/root.txt', 'root.txt'), true);
  assert.equal(ignore('/root.txt', 'a/root.txt'), false);
  assert.equal(ignore('docs/*.md', 'docs/a.md'), true);
  assert.equal(ignore('docs/*.md', 'docs/sub/a.md'), false);
  assert.equal(ignore('docs/*.md', 'a.md'), false);
  assert.equal(ignore('docs/**', 'docs/a/b.md'), true);
  assert.equal(ignore('docs/**', 'docs', true), false);
  assert.equal(ignore('*.md', 'a.MD'), false);
});

// 责任：确认目录规则只作用于目录，文件同名的项不被忽略。
test('directory-only patterns match only directories', () => {
  assert.equal(ignore('build/', 'build', true), true);
  assert.equal(ignore('build/', 'build', false), false);
  assert.equal(ignore('build/', 'a/build', true), true);
  assert.equal(ignore('build/', 'a/build/inner.md', false), false);
  assert.equal(ignore('**/', 'a', true), true);
  assert.equal(ignore('**/', 'a', false), false);
});

// 责任：确认否定规则按“最后匹配者胜出”生效，且父目录不下钻保留给扫描器。
test('negation is last-match-wins; ancestor exclusion belongs to the scanner', () => {
  assert.equal(ignore('*.log\n!keep.log', 'keep.log'), false);
  assert.equal(ignore('*.log\n!keep.log', 'other.log'), true);
  assert.equal(ignore('!*.log\n*.log', 'keep.log'), true);
  assert.equal(ignore('!*.log', 'keep.log'), false);
  assert.equal(ignore('build/*\n!build/keep.md', 'build/keep.md'), false);
  assert.equal(ignore('build/*\n!build/keep.md', 'build/other.md'), true);
  // 契约分工：父目录 build 被目录规则忽略后，扫描器不下钻；本函数只回答末次匹配。
  assert.equal(ignore('build/\n!build/keep.md', 'build', true), true);
  assert.equal(ignore('build/\n!build/keep.md', 'build/keep.md'), false);
  assert.equal(ignore('build', 'build/inner.md'), false);
});

// 责任：确认双星只在独立路径段跨目录，零段与一段以上语义与 Git 一致。
test('double star matches directories with zero or more path segments', () => {
  assert.equal(ignore('a/**/b', 'a/b'), true);
  assert.equal(ignore('a/**/b', 'a/x/b'), true);
  assert.equal(ignore('a/**/b', 'a/x/y/b'), true);
  assert.equal(ignore('a/**/b', 'a/x/b/c'), false);
  assert.equal(ignore('**/x', 'x'), true);
  assert.equal(ignore('**/x', 'a/x'), true);
  assert.equal(ignore('**/x', 'a/x/y'), false);
  assert.equal(ignore('d/**', 'd/q'), true);
  assert.equal(ignore('d/**', 'd/q/r'), true);
  assert.equal(ignore('d/**', 'd', true), false);
  assert.equal(ignore('a/**b', 'a/b'), true);
  assert.equal(ignore('a/**b', 'a/xb'), true);
  assert.equal(ignore('a/**b', 'a/x/yb'), false);
  assert.equal(ignore('**', 'a/b/c.md'), true);
  assert.equal(ignore('**', 'a', true), true);
  assert.equal(ignore('***', 'a/b'), true);
});

// 责任：确认字符类支持范围、! 与 ^ 否定、前导 ] 字面量和转义成员。
test('character classes support ranges, negation and literal members', () => {
  assert.equal(ignore('[a-c].md', 'b.md'), true);
  assert.equal(ignore('[a-c].md', 'd.md'), false);
  assert.equal(ignore('[!a-c].md', 'd.md'), true);
  assert.equal(ignore('[!a-c].md', 'b.md'), false);
  assert.equal(ignore('[^a-c].md', 'd.md'), true);
  assert.equal(ignore('[^a-c].md', 'b.md'), false);
  assert.equal(ignore('[]].md', 'a].md'), false);
  assert.equal(ignore('[]].md', '].md'), true);
  assert.equal(ignore('[a-c].md', 'a.md'), true);
  assert.equal(ignore('[a-c].md', 'c.md'), true);
  assert.equal(ignore('[a-c-e].md', 'e.md'), true);
});

// 责任：确认单星与问号不跨路径段，且按 Git 的 UTF-8 字节语义匹配多字节字符。
test('star and question mark stay within a segment; matching is UTF-8 byte based', () => {
  assert.equal(ignore('a*b', 'ab'), true);
  assert.equal(ignore('a*b', 'aXXb'), true);
  assert.equal(ignore('a*b', 'a/b'), false);
  assert.equal(ignore('?.md', 'a.md'), true);
  assert.equal(ignore('?.md', 'ab.md'), false);
  // Git 按字节匹配：文 = 3 字节，é = 2 字节，😀 = 4 字节。
  assert.equal(ignore('?.md', '文.md'), false);
  assert.equal(ignore('???.md', '文.md'), true);
  assert.equal(ignore('?.md', 'é.md'), false);
  assert.equal(ignore('??.md', 'é.md'), true);
  assert.equal(ignore('????.md', '😀.md'), true);
  assert.equal(ignore('?.md', '😀.md'), false);
  assert.equal(ignore('[é].md', 'é.md'), false);
  assert.equal(ignore('文档.md', '文档.md'), true);
  assert.equal(ignore('*.md', 'A.md'), true);
  assert.equal(ignore('*.MD', 'A.md'), false);
});

// 责任：确认 ASCII POSIX 字符类按 Git 语义匹配，未知或未闭合的类失败关闭。
test('POSIX character classes are ASCII; unsupported classes fail closed', () => {
  assert.equal(ignore('[[:digit:]].md', '1.md'), true);
  assert.equal(ignore('[[:digit:]].md', 'a.md'), false);
  assert.equal(ignore('[[:digit:]].md', '１.md'), false);
  assert.equal(ignore('[[:alpha:]].md', 'a.md'), true);
  assert.equal(ignore('[[:alpha:]].md', '1.md'), false);
  assert.equal(ignore('[[:alnum:]].md', 'a1.md'), false);
  assert.equal(ignore('[[:alnum:]][[:alnum:]].md', 'a1.md'), true);
  assert.equal(ignore('[[:xdigit:]].md', 'f.md'), true);
  assert.equal(ignore('[[:xdigit:]].md', 'g.md'), false);
  assert.equal(ignore('[[:upper:]].md', 'A.md'), true);
  assert.equal(ignore('[[:lower:]].md', 'A.md'), false);
  assert.equal(ignore('[[:space:]].md', ' .md'), true);
  assert.equal(ignore('[[:blank:]]', '	'), true);
  assert.equal(ignore('[[:punct:]].md', '!.md'), true);
  assert.equal(ignore('[[:punct:]].md', 'a.md'), false);
  assert.equal(ignore('[[:graph:]]', '~'), true);
  assert.equal(ignore('[[:print:]]', ' '), true);
  assert.equal(ignore('[![:digit:]].md', 'a.md'), true);
  assert.equal(ignore('[![:digit:]].md', '1.md'), false);
  assert.equal(ignore('[a[:digit:]].md', '3.md'), true);
  for (const bad of ['[[:foo:]]', '[[:^digit:]]', '[[:digit:]', '[[:digit]]', '[[:]]']) {
    assert.throws(() => compileIgnore(bad), { code: 'ignore-invalid' }, bad);
  }
});

// 责任：确认 baseRelPath 把规则限制在对应子目录，并让锚定规则相对该目录生效。
test('baseRelPath scopes rules to its subtree', () => {
  assert.equal(ignore('*.md', 'docs/x.md', false, 'docs'), true);
  assert.equal(ignore('*.md', 'docs/sub/x.md', false, 'docs'), true);
  assert.equal(ignore('*.md', 'x.md', false, 'docs'), false);
  assert.equal(ignore('*.md', 'docs2/x.md', false, 'docs'), false);
  assert.equal(ignore('/x.md', 'docs/x.md', false, 'docs'), true);
  assert.equal(ignore('/x.md', 'docs/sub/x.md', false, 'docs'), false);
  assert.equal(ignore('sub/*', 'docs/sub/a', false, 'docs'), true);
  assert.equal(ignore('sub/*', 'docs/sub/a/b', false, 'docs'), false);
  assert.equal(ignore('sub/*', 'sub/a', false, 'docs'), false);
  assert.equal(ignore('', 'docs/x.md', false, 'docs'), false);
  assert.equal(ignore('docs/*.md', 'x.md', false, 'docs'), false);
});

// 责任：确认空文本得到零规则；CRLF 文本与重复编译结果稳定，编译结果不可变。
test('compiled rules are empty, deterministic and frozen', () => {
  const empty = compileIgnore('');
  assert.equal(empty.length, 0);
  assert.equal(isIgnored(empty, 'anything.md', false), false);
  const rules = compileIgnore('*.log\r\n!keep.log\r\n');
  assert.equal(rules.length, 2);
  assert.equal(isIgnored(rules, 'keep.log', false), false);
  assert.equal(isIgnored(rules, 'other.log', false), true);
  const again = compileIgnore('*.log\n!keep.log\n');
  assert.equal(isIgnored(again, 'keep.log', false), false);
  assert.notEqual(again, rules);
  assert.equal(Object.isFrozen(rules), true);
  assert.equal(Object.isFrozen(rules[0]), true);
  assert.equal(Object.isFrozen(rules[0].segments), true);
  assert.equal(Object.isFrozen(rules[0].segments[0]), true);
  assert.throws(() => rules.push(rules[0]), TypeError);
  assert.equal(isIgnored(rules, 'keep.log', false), false);
});

// 责任：确认扫描器按层拼接 [...inherited, ...own] 的普通数组可直接匹配，空数组表示无规则。
test('concatenated rule sets compose across nested .gitignore layers', () => {
  const combined = [...compileIgnore('*.log\nbuild/\n'), ...compileIgnore('!keep.log\n*.tmp\n', 'docs')];
  assert.equal(combined.length, 4);
  assert.equal(isIgnored(combined, 'a/b/x.log', false), true);
  assert.equal(isIgnored(combined, 'docs/keep.log', false), false);
  assert.equal(isIgnored(combined, 'a/keep.log', false), true);
  assert.equal(isIgnored(combined, 'docs/sub/x.tmp', false), true);
  assert.equal(isIgnored(combined, 'x.tmp', false), false);
  assert.equal(isIgnored(combined, 'build', true), true);
  assert.equal(isIgnored([], 'x.log', false), false);
  assert.equal(isIgnored(Object.freeze([]), 'x.log', false), false);
});

// 责任：确认非法扫描路径、非法规则数组元素与非法 isDirectory 都失败关闭。
test('invalid runtime input fails closed', () => {
  const rules = compileIgnore('*.log');
  assert.throws(() => isIgnored([{}], 'a.log', false), { code: 'ignore-invalid' });
  assert.throws(() => isIgnored(['*.log'], 'a.log', false), { code: 'ignore-invalid' });
  assert.throws(() => isIgnored('*.log', 'a.log', false), { code: 'ignore-invalid' });
  assert.throws(() => isIgnored(rules, 'a.log', 'yes'), { code: 'ignore-invalid' });
  assert.throws(() => isIgnored(rules, 42, false), { code: 'ignore-invalid' });
  for (const path of ['', '/a.log', 'a.log/', 'a//b.log', 'a/./b.log', 'a/../b.log', 'a' + BS + 'b.log', 'a\0b.log']) {
    assert.throws(() => isIgnored(rules, path, false), { code: 'ignore-invalid' }, JSON.stringify(path));
  }
  assert.throws(() => isIgnored(rules, 'a'.repeat(IGNORE_LIMITS.pathChars + 1), false), { code: 'ignore-oversize' });
  const deepPath = Array.from({ length: IGNORE_LIMITS.pathSegments + 1 }, () => 'd').join('/');
  assert.throws(() => isIgnored(rules, deepPath, false), { code: 'ignore-oversize' });
});

// 责任：确认病态模式在长路径上是线性有界时间，不出现灾难性回溯。
test('no catastrophic backtracking on pathological patterns', () => {
  const rules = compileIgnore('a*'.repeat(60) + 'b');
  const started = performance.now();
  assert.equal(isIgnored(rules, 'a'.repeat(4000), false), false);
  assert.equal(isIgnored(rules, 'a'.repeat(4000) + 'b', false), true);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, 'pathological match took ' + elapsed.toFixed(1) + 'ms');
});

// 责任：确认跨规则累计匹配步数超过上限时以 ignore-budget 失败关闭，短路径不受影响。
test('match step budget fails closed instead of running unbounded', () => {
  const rules = compileIgnore(Array.from({ length: 40 }, () => 'a' + '*a'.repeat(40)).join('\n'));
  const long = 'a'.repeat(4000);
  assert.throws(() => isIgnored(rules, long, false), { code: 'ignore-budget' });
  assert.equal(isIgnored(rules, 'a'.repeat(200), false), true);
});

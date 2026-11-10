/**
 * 测试职责：约束候选 tarball 发布就绪判断、元数据/条目类型和 README 链接解析的保守边界。
 * 典型流程：合成包清单/链接及临时 tarball → evaluator/CLI → 检查 blocker、manual gate、JSON 和退出码。
 * 覆盖边界：覆盖 技术就绪与人工 private 门分离、tar 类型配对和解析拒绝；不覆盖 npm publish 或远端链接连通性。
 * 外部前置：CLI tarball 场景需要系统 tar；无需网络或真实发布权限。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkReleasePurity } from '../../scripts/check-release-purity.mjs';
import { evaluateReadiness, parseReadmeLinks, resolveReadmeLinks } from '../../scripts/release-readiness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SYSTEM_TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : null;
const TAR = SYSTEM_TAR && fs.existsSync(SYSTEM_TAR) ? SYSTEM_TAR : 'tar';
const LICENSE_TEXT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n';

const ENTRIES = [
  'package/package.json', 'package/README.md', 'package/docs/CONTRACT.md', 'package/LICENSE',
  'package/lib/index.js', 'package/lib/client.js',
];
const PACKAGE = {
  name: 'dsh-project-board',
  version: '0.1.1',
  description: 'synthetic fixture',
  license: 'MIT',
  repository: { type: 'git', url: 'https://example.com/repo.git' },
  homepage: 'https://example.com/',
  author: { name: 'Example' },
  type: 'module',
  main: 'lib/index.js',
  exports: {
    '.': { default: './lib/index.js' },
    './client': { default: './lib/client.js' },
    './package.json': './package.json',
  },
};
const README = [
  '# synthetic',
  '[contract](<./docs/CONTRACT.md>)',
  '[web](https://example.com/)',
  '[top](#top)',
  '![logo](./lib/client.js)',
  '',
].join('\n');

function entryTypesFor(entries) {
  return Object.fromEntries(entries.map((entry) => [entry, { type: 'file', linkTarget: null }]));
}

function licenseFilesFor(entries) {
  return entries
    .filter((entry) => /^package\/(?:LICENSE(?:\.[^/]+)?|COPYING)$/i.test(entry))
    .map((entry) => ({ entry, content: LICENSE_TEXT }));
}

function evaluate(overrides = {}) {
  const entries = overrides.entries ?? ENTRIES;
  return evaluateReadiness({
    packageJson: PACKAGE,
    readmeText: README,
    ...overrides,
    entries,
    entryTypes: overrides.entryTypes ?? entryTypesFor(entries),
    licenseFiles: overrides.licenseFiles ?? licenseFilesFor(entries),
  });
}

function blockerIds(result) {
  return result.blockers.map((blocker) => blocker.id).sort();
}

function check(result, id) {
  return result.checks.find((entry) => entry.id === id);
}

// 责任：完整合成包须 ready=true，无 blocker/manual gate 且链接计数和入口检查明确通过。
test('a synthetic package with valid metadata, entries, license and links is ready', () => {
  const result = evaluate();
  assert.equal(result.ready, true);
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.manualGates, []);
  assert.equal(result.readmeLinks.relativeOccurrences, 2);
  assert.equal(result.readmeLinks.relativeMissing, 0);
  assert.equal(result.readmeLinks.externalOrAnchorOccurrences, 2);
  assert.equal(check(result, 'license-file').status, 'pass');
  assert.equal(check(result, 'entry-main').status, 'pass');
  assert.equal(check(result, 'entry-client').status, 'pass');
});

// 责任：逐个移除公开元数据字段须产生各自技术 blocker，不得只给笼统警告。
test('each public metadata field is a separate technical blocker when missing', () => {
  for (const field of ['license', 'repository', 'homepage', 'author']) {
    const result = evaluate({ packageJson: { ...PACKAGE, [field]: undefined } });
    assert.equal(result.ready, false, field);
    assert.ok(blockerIds(result).includes('metadata-' + field), field + ' must block');
  }
  for (const [field, value, id] of [['name', 'Bad Name', 'metadata-name'], ['version', 'v1', 'metadata-version']]) {
    const result = evaluate({ packageJson: { ...PACKAGE, [field]: value } });
    assert.ok(blockerIds(result).includes(id), field + ' validity must block');
  }
  const unreadable = evaluate({ packageJson: null, packageJsonError: 'invalid JSON' });
  assert.ok(blockerIds(unreadable).includes('package-json'));
  assert.equal(unreadable.ready, false);
});

// 责任：LICENSE 必须有可用普通文件正文，仅有同名条目不能满足许可要求。
test('LICENSE must be a usable regular file, not just a matching entry name', () => {
  const noLicense = evaluate({ entries: ENTRIES.filter((entry) => entry !== 'package/LICENSE') });
  assert.ok(blockerIds(noLicense).includes('license-file'));
  const empty = evaluate({ licenseFiles: [{ entry: 'package/LICENSE', content: '  \n' }] });
  assert.ok(blockerIds(empty).includes('license-file'));
  const todo = evaluate({ licenseFiles: [{ entry: 'package/LICENSE', content: 'TODO' }] });
  assert.ok(blockerIds(todo).includes('license-file'));
  const symlink = evaluate({ entryTypes: { ...entryTypesFor(ENTRIES), 'package/LICENSE': { type: 'symlink', linkTarget: '../missing' } } });
  assert.ok(blockerIds(symlink).includes('license-file'));
  const copying = evaluate({ entries: [...ENTRIES.filter((entry) => entry !== 'package/LICENSE'), 'package/COPYING'] });
  assert.equal(check(copying, 'license-file').status, 'pass');
});

// 责任：缺 main/client 文件或缺 ./client export 时须分别产生 entry-main、entry-client 或 entry-exports 阻断。
test('main, exports and client entry must exist as regular files', () => {
  assert.ok(blockerIds(evaluate({ packageJson: { ...PACKAGE, main: 'lib/missing.js' } })).includes('entry-main'));
  const clientMissing = evaluate({ entries: ENTRIES.filter((entry) => entry !== 'package/lib/client.js') });
  assert.ok(blockerIds(clientMissing).includes('entry-client'));
  assert.ok(blockerIds(clientMissing).includes('entry-exports'));
  const exportsGone = evaluate({ packageJson: { ...PACKAGE, exports: { '.': './lib/index.js' } } });
  assert.ok(blockerIds(exportsGone).includes('entry-client'));
});

// 责任：exports 非法结构或目标须报错，不能静默丢掉无法解析的分支。
test('exports structure and target rules are checked instead of silently dropping branches', () => {
  const noRoot = evaluate({ packageJson: { ...PACKAGE, exports: { './client': './lib/client.js', './package.json': './package.json' } } });
  assert.ok(blockerIds(noRoot).includes('entry-exports'), 'missing root export');
  const numberBranch = evaluate({ packageJson: { ...PACKAGE, exports: { '.': { import: 42 }, './client': './lib/client.js' } } });
  assert.ok(blockerIds(numberBranch).includes('entry-exports'), 'number branch');
  const mixed = evaluate({ packageJson: { ...PACKAGE, exports: { '.': './lib/index.js', default: './lib/index.js' } } });
  assert.ok(blockerIds(mixed).includes('entry-exports'), 'mixed keys');
  const bare = evaluate({ packageJson: { ...PACKAGE, exports: { '.': 'lib/index.js', './client': './lib/client.js' } } });
  assert.ok(blockerIds(bare).includes('entry-exports'), 'bare target');
  const escaping = evaluate({ packageJson: { ...PACKAGE, exports: { '.': '../outside.js', './client': './lib/client.js' } } });
  assert.ok(blockerIds(escaping).includes('entry-exports'), 'escaping target');
  const blocked = evaluate({ packageJson: { ...PACKAGE, exports: { '.': './lib/index.js', './client': './lib/client.js', './internal': null } } });
  assert.equal(blocked.ready, true);
  assert.equal(check(blocked, 'entry-exports').status, 'pass');
});

// 责任：根 exports 按 node/import/default 条件解析，无法判定形状必须拒绝。
test('root exports conditions follow node/import/default and reject undecidable shapes', () => {
  const browserOnly = evaluate({ packageJson: { ...PACKAGE, exports: { '.': { browser: './lib/index.js' }, './client': './lib/client.js' } } });
  assert.ok(blockerIds(browserOnly).includes('entry-exports'), 'browser-only root');
  const nullFirst = evaluate({ packageJson: { ...PACKAGE, exports: { '.': { default: null, import: './lib/index.js' }, './client': './lib/client.js' } } });
  assert.ok(blockerIds(nullFirst).includes('entry-exports'), 'default null first');
  const integerKey = evaluate({ packageJson: { ...PACKAGE, exports: { '.': { 0: './lib/index.js', default: './lib/index.js' }, './client': './lib/client.js' } } });
  assert.ok(blockerIds(integerKey).includes('entry-exports'), 'integer condition key');
  const encoded = evaluate({
    entries: [...ENTRIES, 'package/lib/%2e%2e/index.js'],
    packageJson: { ...PACKAGE, exports: { '.': './lib/%2e%2e/index.js', './client': './lib/client.js' } },
  });
  assert.ok(blockerIds(encoded).includes('entry-exports'), 'encoded target');
  assert.match(check(encoded, 'entry-exports').message, /encoded|unsupported/);
  const nodeCondition = evaluate({ packageJson: { ...PACKAGE, exports: { '.': { node: './lib/index.js' }, './client': { default: './lib/client.js' } } } });
  assert.equal(nodeCondition.ready, true);
  for (const unsupported of ['node-addons', 'module-sync', 'custom-condition']) {
    const result = evaluate({ packageJson: { ...PACKAGE, exports: { '.': { [unsupported]: null, default: './lib/index.js' }, './client': './lib/client.js' } } });
    assert.ok(blockerIds(result).includes('entry-exports'), unsupported);
    assert.match(check(result, 'entry-exports').message, /unsupported condition key/);
  }
  const defaultFirst = evaluate({ packageJson: { ...PACKAGE, exports: { '.': { default: './lib/index.js', 'node-addons': null }, './client': './lib/client.js' } } });
  assert.ok(blockerIds(defaultFirst).includes('entry-exports'), 'default-first still rejects unknown key');
});

// 责任：悬空 client symlink 和目录型 main 须拒绝；包内可解析到普通文件的安全链接仍可通过。
test('dangling or non-regular required entries are rejected without extracting them', () => {
  const dangling = evaluate({ entryTypes: { ...entryTypesFor(ENTRIES), 'package/lib/client.js': { type: 'symlink', linkTarget: 'missing-target' } } });
  assert.ok(blockerIds(dangling).includes('entry-client'));
  const directory = evaluate({ entryTypes: { ...entryTypesFor(ENTRIES), 'package/lib/index.js': { type: 'dir' } } });
  assert.ok(blockerIds(directory).includes('entry-main'));
  const safeLink = evaluate({ entryTypes: { ...entryTypesFor(ENTRIES), 'package/lib/client.js': { type: 'symlink', linkTarget: 'index.js' } } });
  assert.equal(safeLink.ready, true);
});

// 责任：注册 bin 或包含 bin/开发/证据树须阻断候选发布。
test('bin registration, bin/ content and developer/evidence trees are blocked', () => {
  assert.ok(blockerIds(evaluate({ packageJson: { ...PACKAGE, bin: { wt: 'bin/wt.mjs' } } })).includes('no-bin-registration'));
  assert.ok(blockerIds(evaluate({ entries: [...ENTRIES, 'package/bin/wt.mjs'] })).includes('no-bin-directory'));
  for (const name of ['scripts', 'test', 'tests', 'evidence', '.evidence']) {
    const result = evaluate({ entries: [...ENTRIES, 'package/' + name + '/x.mjs'] });
    assert.ok(blockerIds(result).includes('no-developer-content'), name);
  }
});

// 责任：private:true 必须列为人工门而非技术 blocker，不能误宣称可自动发布。
test('private:true is a manual gate, not a technical blocker', () => {
  const result = evaluate({ packageJson: { ...PACKAGE, private: true } });
  assert.equal(result.ready, false);
  assert.equal(blockerIds(result).includes('private-field'), false);
  assert.deepEqual(result.manualGates.map((gate) => gate.id), ['private-field']);
  assert.equal(result.counts.manual, 1);
  assert.ok(result.blockers.every((blocker) => blocker.category === 'technical'));
});

// 责任：README 相对目标须对打包清单检查，工作区里存在不能弥补包里缺失。
test('README relative targets are checked against package entries, not the worktree', () => {
  const cases = [
    ['[gone](./docs/GONE.md)', 'docs/GONE.md', null],
    ['[escape](../outside.md)', '../outside.md', 'path-escape'],
    ['[absolute](/etc/passwd)', '/etc/passwd', 'absolute-path'],
    ['[bad](./%ZZ.md)', './%ZZ.md', 'invalid-escape'],
    ['[win](.\\lib\\index.js)', '.\\lib\\index.js', 'backslash-path'],
  ];
  for (const [line, target, reason] of cases) {
    const result = evaluate({ readmeText: '# x\n' + line + '\n' });
    assert.equal(result.ready, false, line);
    assert.ok(blockerIds(result).includes('readme-relative-links'), line);
    const issue = check(result, 'readme-relative-links').detail.issues[0];
    assert.equal(issue.target, target, line);
    assert.equal(issue.reason, reason, line);
  }
  const fragment = evaluate({ readmeText: '# x\n[ok](<./docs/CONTRACT.md#410-x>)\n' });
  assert.equal(check(fragment, 'readme-relative-links').status, 'pass');
  const image = evaluate({ readmeText: '# x\n![ok](./lib/client.js)\n' });
  assert.equal(check(image, 'readme-relative-links').status, 'pass');
  assert.equal(image.readmeLinks.relativeOccurrences, 1);
});

// 责任：裸链接带成对括号时须解析完整路径，不能只验有效前缀。
test('balanced bare parentheses resolve the full target, not just its prefix', () => {
  const text = '# x\n[doc](docs/a(b).md)\n';
  const whole = resolveReadmeLinks(text, [...ENTRIES, 'package/docs/a(b).md']);
  assert.equal(whole.summary.relativeMissing, 0);
  const prefixOnly = resolveReadmeLinks(text, [...ENTRIES, 'package/docs/a(b)']);
  assert.equal(prefixOnly.summary.relativeMissing, 1);
});

// 责任：代码围栏与行内代码里的伪链接不得计入 README 链接统计。
test('code fences and inline code are excluded from link counting', () => {
  const text = [
    '# x',
    '```',
    '[inside-fence](./missing.md)',
    '```',
    '`[inside-span](./missing.md)`',
    '[real](./docs/CONTRACT.md)',
  ].join('\n');
  const result = resolveReadmeLinks(text, ENTRIES);
  assert.equal(result.summary.relativeOccurrences, 1);
  assert.equal(result.summary.relativeMissing, 0);
});

// 责任：引用定义须折叠空白并采用首个定义，完整/折叠引用都正确解析。
test('reference definitions fold whitespace, keep the first definition and resolve full/collapsed links', () => {
  const text = [
    '# x',
    '[ref]: <./docs/CONTRACT.md>',
    '[CONTRACT.md]: ./lib/index.js',
    '[text][ref]',
    '[CONTRACT.md][]',
  ].join('\n');
  const result = resolveReadmeLinks(text, ENTRIES);
  assert.equal(result.summary.relativeOccurrences, 2);
  assert.equal(result.summary.relativeMissing, 0);
  const folded = resolveReadmeLinks('[text][a b]\n\n[a   b]: ./MISSING.md\n', ENTRIES);
  assert.equal(folded.summary.relativeOccurrences, 1);
  assert.equal(folded.summary.relativeMissing, 1);
  const duplicate = resolveReadmeLinks('[ref]: ./MISSING.md\n[ref]: ./docs/CONTRACT.md\n\n[x][ref]\n', ENTRIES);
  assert.equal(duplicate.summary.relativeMissing, 1);
});

// 责任：多行引用定义或跨行原始 HTML 无法安全解析时必须作为 blocker。
test('multi-line reference definitions and cross-line raw HTML are conservative blockers', () => {
  const multiline = evaluate({ readmeText: '[ref]:\n  ./MISSING.md\n\n[x][ref]\n' });
  assert.ok(blockerIds(multiline).includes('readme-supported-syntax'));
  assert.equal(multiline.ready, false);
  const html = evaluate({ readmeText: '# x\n<a\n href="./MISSING.md">x</a>\n' });
  assert.ok(blockerIds(html).includes('readme-supported-syntax'));
  assert.equal(html.ready, false);
});

// 责任：不支持的链接语法须明确阻断，不得静默跳过装作全部校验。
test('unsupported link syntax is a blocker instead of a silent skip', () => {
  const nested = evaluate({ readmeText: '# x\n[![alt](./lib/client.js)](./CONTRACT.md)\n' });
  assert.ok(blockerIds(nested).includes('readme-supported-syntax'));
  assert.equal(nested.ready, false);
});

// 责任：当前 README 相对/外部链接计数必须与合成打包清单的显式期望一致。
test('current README link counts remain explicit against the synthetic packed entries', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const result = resolveReadmeLinks(readme, ENTRIES);
  assert.deepEqual(result.summary, {
    occurrencesTotal: 11,
    relativeOccurrences: 2,
    relativeMissing: 0,
    relativeUniqueTargets: 2,
    relativeUniqueMissing: 0,
    rawUniqueDestinations: 2,
    rawUniqueMissingDestinations: 0,
    angleOccurrences: 2,
    angleMissing: 0,
    plainOccurrences: 0,
    plainMissing: 0,
    externalOrAnchorOccurrences: 9,
    uniqueMissingTargets: [],
  });
  assert.deepEqual(result.unsupported, []);
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-readiness-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePackage(dir, packageJson, readme, extra = {}) {
  const files = {
    'package.json': JSON.stringify(packageJson, null, 2) + '\n',
    'README.md': readme,
    'docs/CONTRACT.md': '# contract\n',
    'LICENSE': LICENSE_TEXT,
    'lib/index.js': 'export {};\n',
    'lib/client.js': 'export {};\n',
    ...extra,
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, 'package', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

function pack(dir) {
  const archive = path.join(dir, 'package.tgz');
  const result = spawnSync(TAR, ['-cf', archive, '-C', dir, 'package'], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'tar failed: ' + result.stderr);
  return archive;
}

function writeTar(archive, files) {
  const parts = [];
  for (const file of files) {
    const data = Buffer.from(file.content || '');
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100);
    header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.write('00000000000\0', 136, 12);
    header.fill(32, 148, 156);
    header.write(file.type || '0', 156, 1);
    if (file.link) header.write(file.link, 157, 100);
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  fs.writeFileSync(archive, Buffer.concat(parts));
  return archive;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-release-purity.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

// 责任：CLI 对 ready tarball 须返回可解析 JSON 并 exit 0。
test('CLI --readiness --tarball returns JSON and exit 0 for a ready tarball', (t) => {
  const dir = tempDir(t);
  writePackage(dir, PACKAGE, README);
  const archive = pack(dir);
  const result = runCli(['--readiness', '--tarball', archive]);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.mode, 'readiness');
  assert.equal(json.ready, true);
  assert.equal(json.tarball.path, path.resolve(archive));
  assert.ok(json.tarball.entries >= 8);
  assert.equal(json.counts.fail, 0);
});

// 责任：CLI 对有 blocker tarball 须仍输出机器可读 JSON，但 exit 1。
test('CLI --readiness --tarball keeps machine-readable JSON with exit 1 on blockers', (t) => {
  const dir = tempDir(t);
  const broken = { ...PACKAGE, private: true, license: undefined, repository: undefined, homepage: undefined, author: undefined };
  writePackage(dir, broken, '# broken\n[gone](./docs/GONE.md)\n');
  fs.rmSync(path.join(dir, 'package', 'LICENSE'));
  const archive = pack(dir);
  const result = runCli(['--readiness', '--tarball', archive]);
  assert.equal(result.status, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ready, false);
  assert.ok(json.blockers.some((blocker) => blocker.id === 'license-file'));
  assert.ok(json.blockers.some((blocker) => blocker.id === 'metadata-license'));
  assert.ok(json.blockers.some((blocker) => blocker.id === 'readme-relative-links'));
  assert.deepEqual(json.manualGates.map((gate) => gate.id), ['private-field']);
});

// 责任：tar 条目名与类型必须逐项精确配对，诱饵同名不能借用普通文件类型。
test('tar entry types are paired exactly, so a decoy name cannot lend its type', (t) => {
  const dir = tempDir(t);
  const spoofPackage = { ...PACKAGE, exports: { '.': './lib/index.js', './client': './lib/client.js' } };
  const archive = writeTar(path.join(dir, 'spoof.tar'), [
    { name: 'package/decoy package/lib/client.js', content: 'decoy ordinary file' },
    { name: 'package/package.json', content: JSON.stringify(spoofPackage) },
    { name: 'package/README.md', content: '# x\n[ok](./docs/CONTRACT.md)\n' },
    { name: 'package/docs/CONTRACT.md', content: '# contract\n' },
    { name: 'package/LICENSE', content: LICENSE_TEXT },
    { name: 'package/lib/index.js', content: 'export {};\n' },
    { name: 'package/lib/client.js', type: '2', link: 'MISSING.js' },
  ]);
  const result = runCli(['--readiness', '--tarball', archive]);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const json = JSON.parse(result.stdout);
  assert.ok(json.blockers.some((blocker) => blocker.id === 'entry-client'));
});

// 责任：默认 purity 和 readiness 须分开，默认模式仍要求真实产品元数据。
test('default --tarball purity is separate from readiness and requires product metadata', (t) => {
  const dir = tempDir(t);
  writePackage(dir, PACKAGE, README);
  const archive = pack(dir);
  const cli = runCli(['--tarball', archive]);
  assert.equal(cli.status, 1);
  const json = JSON.parse(cli.stdout);
  assert.equal(json.mode, 'purity');
  assert.equal(json.ok, false);
  assert.match(json.error, /metadata|must not ship|regular file/);
  assert.equal(json.ready, undefined);
  assert.throws(() => checkReleasePurity({ tarball: archive }), /metadata|must not ship|regular file/);
});

// 责任：参数错误或 tarball 读失败须返回 ready:false JSON 和非零退出。
test('readiness argument and read errors still emit ready:false JSON plus non-zero exit', (t) => {
  const dir = tempDir(t);
  const missing = runCli(['--readiness', '--tarball', path.join(dir, 'nope.tgz')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /release-readiness/);
  let json = JSON.parse(missing.stdout);
  assert.equal(json.ready, false);
  assert.ok(json.blockers.some((blocker) => blocker.id === 'readiness-error'));

  const malformed = path.join(dir, 'malformed.tgz');
  fs.writeFileSync(malformed, 'this is not a tarball');
  const bad = runCli(['--readiness', '--tarball', malformed]);
  assert.equal(bad.status, 1);
  json = JSON.parse(bad.stdout);
  assert.equal(json.ready, false);
  assert.equal(json.schemaVersion, 1);
  assert.ok(json.blockers.some((blocker) => blocker.id === 'readiness-error'));

  const missingValue = runCli(['--readiness', '--tarball']);
  assert.equal(missingValue.status, 1);
  json = JSON.parse(missingValue.stdout);
  assert.equal(json.ready, false);
  assert.ok(json.blockers.some((blocker) => blocker.id === 'readiness-error'));

  const fakeNpm = path.join(dir, 'fake-npm.mjs');
  fs.writeFileSync(fakeNpm, 'process.exit(7);\n');
  const packFailure = runCli(['--readiness'], { npm_execpath: fakeNpm });
  assert.equal(packFailure.status, 1);
  json = JSON.parse(packFailure.stdout);
  assert.equal(json.ready, false);
  assert.ok(json.blockers.some((blocker) => blocker.id === 'readiness-error'));
});

// 责任：默认 purity 失败须同时提供机器 JSON 与人工摘要。
test('default purity failures include machine-readable JSON and human summary', () => {
  const result = runCli(['--bogus']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL/);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

// 责任：parseReadmeLinks 返回能力边界信息，让不支持语法不能被误当完整检查。
test('parseReadmeLinks exposes the capability boundary', () => {
  const parsed = parseReadmeLinks('[x](./CONTRACT.md)');
  assert.equal(parsed.occurrences.length, 1);
  assert.ok(parsed.capability.notSupported.includes('multi-line reference definitions (reported as unsupported)'));
  assert.ok(parsed.capability.notSupported.includes('full CommonMark (multi-backtick spans, escaped brackets, etc.)'));
  assert.equal(parsed.capability.onUnsupported, 'reported as a blocking check, never silently skipped');
});

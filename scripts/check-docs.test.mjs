/** Checker-only regressions; synthetic fixtures are retained in the OS temp directory. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { anchors, checkDocuments, leaks, links, prose, slug } from './check-docs.mjs';
import { newId } from '../lib/core/util.js';

function fixture(contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-docs-check-'));
  for (const [file, text] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return { root, files: Object.keys(contents) };
}

function snapshot(root, files) {
  return files.map((file) => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'));
}

test('GitHub slugs retain Chinese, underscores, and double hyphens, but remove punctuation', () => {
  assert.equal(slug('2.1 API / 中文（冻结） -- a_b'), '21-api--中文冻结----a_b');
  assert.equal(slug('`<Type>` &amp; **中文**'), 'type--中文');
  assert.equal(slug('<em>Hi</em> &quot;World&quot; &#x4e2d;'), 'hi-world-中');
});

test('headings handle duplicate suffix collisions, Setext, explicit IDs, and closing hashes', () => {
  const actual = anchors('# 同名\n# 同名\n# 同名-1\n# 同名\n标题\n===\n<a id="legacy"></a>\n## End ##\n');
  for (const id of ['同名', '同名-1', '同名-1-1', '同名-2', '标题', 'legacy', 'end']) assert.ok(actual.has(id), id);
});

test('fences include tilde, longer delimiters, blockquotes, and preserve diagnostic lines', () => {
  const source = '# A\n````md\n[bad](missing.md)\n```\n# hidden\n````\n> ~~~md\n> [bad](missing.md)\n> ~~~\n[good](ok.md)';
  assert.equal(prose(source).length, source.split('\n').length);
  assert.deepEqual(links(source), [{ url: 'ok.md', line: 10 }]);
  assert.deepEqual([...anchors(source)], ['a']);
});

test('links support angles, titles, nested parentheses, escapes, images and encoded paths', () => {
  const source = '[a](<a b.md> "title") [b](folder/a(b).md) ![img](img.png) [c](a%20b.md) [d](a\\(b\\).md)';
  assert.deepEqual(links(source).map((link) => link.url), ['a b.md', 'folder/a(b).md', 'img.png', 'a%20b.md', 'a(b).md']);
});

test('multiline and nested image links are checked, not silently dropped', () => {
  const source = '[multiline](\n  <target.md#中文>\n  "title"\n)\n[![alt](img.png)](target.md)\n';
  assert.deepEqual(links(source), [{ url: 'target.md#中文', line: 1 }, { url: 'target.md', line: 5 }, { url: 'img.png', line: 5 }]);
});

test('reference definitions, collapsed/shortcut refs and HTML are checked; inline code is not', () => {
  const source = '[A][ref] [ref][] [ref]\n[ref]: <real.md>\n`[fake](missing.md)` <img src="asset.svg">\n[next]:\n  next.md\n';
  const actual = links(source);
  assert.ok(actual.some((link) => link.url === 'real.md' && link.line === 1));
  assert.ok(actual.some((link) => link.url === 'next.md' && link.line === 4));
  assert.ok(actual.some((link) => link.url === 'asset.svg' && link.line === 3));
  assert.ok(!actual.some((link) => link.url === 'missing.md'));
});

test('relative path and anchor failures report file and line; external URLs are not fetched', () => {
  const { root, files } = fixture({
    'docs/INDEX.md': '# Map\n[page](<a b.md#中文----标题>)\n[missing](missing.md)\n[bad](a%20b.md#absent)\n[external](https://example.invalid/missing.md)\n',
    'docs/a b.md': '# 中文 -- 标题\n',
  });
  const result = checkDocuments(root, files);
  assert.equal(result.counts.missing, 2);
  assert.equal(result.counts.unreachable, 0);
  assert.ok(result.errors.some((error) => error.startsWith('docs/INDEX.md:3:') && error.includes('missing path')));
  assert.ok(result.errors.some((error) => error.startsWith('docs/INDEX.md:4:') && error.includes('missing anchor')));
});

test('INDEX reachability follows indirect links and reports genuinely unreachable documents', () => {
  const { root, files } = fixture({ 'docs/INDEX.md': '[a](a.md)', 'docs/a.md': '[b](b.md)', 'docs/b.md': '# B', 'docs/orphan.md': '# Orphan' });
  const result = checkDocuments(root, files);
  assert.equal(result.counts.unreachable, 1);
  assert.deepEqual(result.errors, ['docs/orphan.md: unreachable from docs/INDEX.md']);
});

test('archive references fail even when a local copy exists; tracking archive files also fails', () => {
  const { root, files } = fixture({ 'docs/INDEX.md': '[old](archive/old.md)', 'docs/archive/old.md': '# Old' });
  const result = checkDocuments(root, files);
  assert.equal(result.counts.archive, 2);
  assert.ok(result.errors.some((error) => error.includes('archive reference')));
  assert.ok(result.errors.some((error) => error.includes('archive file is tracked')));
});

test('privacy checks real identifiers, sessions, absolute paths and both private ranges, including fences', () => {
  const source = ['prj_1234567890abcdef', 'tsk_abcdef0123456789', 'session-12345678-1234-1234-1234-123456789abc', 'D:\\Secret\\file.md', '/home/alice/file.md', '192.168.3.4', '10.24.3.4', '```', '10.0.0.2', '```'].join('\n');
  assert.equal(leaks(source).length, 8);
  assert.equal(leaks('prj_<id> tsk_EXAMPLE session-<uuid> ABSOLUTE_STORE 127.0.0.1 110.2.3.4').length, 0);
});

test('privacy checks the live newId shape and keeps public-scope integration honest', () => {
  const ids = [newId('prj'), newId('tsk')];
  assert.equal(leaks(ids.join(' ')).length, 2);
  assert.equal(leaks('prj_<id> tsk_EXAMPLE prj_1234567890abcdef').length, 1);
  const { root, files } = fixture({
    'docs/INDEX.md': '# Map\n\n' + ids.join(' '),
    'test/README.md': newId('prj'),
  });
  const result = checkDocuments(root, files);
  assert.equal(result.counts.leaks, 2);
  assert.ok(result.errors.every((error) => error.startsWith('docs/INDEX.md')));
});

test('privacy covers RFC1918 172.16/12, UNC and macOS home paths without overmatching neighbours', () => {
  const source = ['172.16.2.3', '172.31.255.254', '\\\\example-server\\private-share\\doc.md', '/Users/alice/file.md', '172.15.0.1', '172.32.0.1'].join('\n');
  const found = leaks(source);
  assert.equal(found.filter((item) => item.kind === 'private-address').length, 2);
  assert.equal(found.filter((item) => item.kind === 'unc-path').length, 1);
  assert.equal(found.filter((item) => item.kind === 'home-path').length, 1);
  assert.equal(found.some((item) => /^172\.(?:15|32)\./.test(item.value)), false);
});

test('only reasoned same-line exemptions apply; the next line and short reasons still fail', () => {
  assert.equal(leaks('C:/x.md <!-- docs-check-allow: synthetic absolute-path rejection example, not a host path -->').length, 0);
  assert.equal(leaks('C:/x.md <!-- docs-check-allow: example -->').length, 1);
  assert.equal(leaks('C:/x.md <!-- docs-check-allow: synthetic absolute-path rejection example -->\nC:/real.md').length, 1);
});

test('test fixture Markdown still checks links but is outside public-doc privacy scope', () => {
  const { root, files } = fixture({ 'docs/INDEX.md': '# Map', 'test/README.md': 'C:/synthetic/compiler.exe [bad](missing.md)' });
  const result = checkDocuments(root, files);
  assert.equal(result.counts.leaks, 0);
  assert.equal(result.counts.missing, 1);
});

test('missing tracked Markdown is not silently filtered out', () => {
  const { root, files } = fixture({ 'docs/INDEX.md': '# Map' });
  const result = checkDocuments(root, [...files, 'docs/removed.md']);
  assert.equal(result.counts.missing, 1);
  assert.ok(result.errors.some((error) => error.includes('missing/unreadable Markdown')));
});

test('the checker leaves every input byte unchanged', () => {
  const { root, files } = fixture({ 'docs/INDEX.md': '[a](a.md#中文)', 'docs/a.md': '# 中文' });
  const before = snapshot(root, files);
  assert.equal(checkDocuments(root, files).errors.length, 0);
  assert.deepEqual(snapshot(root, files), before);
});

test('encoded path delimiters do not turn into fragment/query separators', () => {
  const { root, files } = fixture({ 'docs/INDEX.md': '[hash](a%23b.md#x)', 'docs/a#b.md': '# X' });
  assert.equal(checkDocuments(root, files).errors.length, 0);
});

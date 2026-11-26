/**
 * 测试职责：文档图片的只读字节路由、鉴权、正文引用范围与路径/大小/格式边界。
 * 典型流程：合成 binding 与临时图片 → 真实路由 handler → 比较状态、字节及 envelope。
 * 覆盖边界：覆盖 只读字节路由、鉴权、正文引用范围及路径/大小/格式边界；不覆盖 浏览器解码、真实网络盘权限。
 * 外部前置：无；只使用合成临时目录。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../../lib/core/service.js';
import { registerRoutes } from '../../lib/host/routes.js';
import { IMAGE_MAX_BYTES, readImageAsset } from '../../lib/core/documents/assets.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-assets-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-assets-store-'));
  const seed = new ProjectService({ rootDir, privilegedInlineWrites: true });
  await seed.init();
  const actor = { kind: 'human', via: 'test' };
  const project = await seed.createProject({ workspacePath: root, name: 'Image fixtures' });
  const projectId = project.projectId || project.id;
  const log = path.join(rootDir, 'projects', projectId, 'commits.jsonl');
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide');
  const registered = await project.command({ cmdId: 'register', op: 'doc.external.register', actor, title: 'Guide', relPath: 'docs/guide.md' });
  const inline = await project.command({ cmdId: 'inline', op: 'doc.put', actor, title: 'Inline', body: 'Inline body' });
  const docId = registered.docId || registered.events.find(event => event.docId).docId;
  const inlineId = inline.events.find(event => event.docId).docId;
  const state = project.state;
  const binding = seed.bindings().mainOf(projectId);
  await seed.close();
  const service = new ProjectService({ rootDir });
  await service.init();
  t.after(() => service.close());
  let opened = 0;
  const open = service.open.bind(service);
  service.open = (...args) => { opened += 1; return open(...args); };
  const handle = { id: projectId, state, service };
  const openWriter = () => service.open(projectId);
  let route;
  const runtime = { token: 'secret', ready: Promise.resolve(), service };
  t.after(() => runtime.reader?.close());
  registerRoutes({ webServer: { register(value) { route = value; return () => {}; } }, on() { return () => {}; } },
    runtime);
  function request(relPath, requestedId = docId, token = 'secret', extra = '') {
    return new Promise((resolve) => {
      const req = { method: 'GET', url: '/project-board/api/projects/' + projectId + '/docs/external/' + requestedId + '/assets' + (relPath === null ? '?' : '?path=' + encodeURIComponent(relPath)) + extra, headers: { 'x-project-board-token': token } };
      const res = { status: 0, headers: {}, writeHead(status, headers) { this.status = status; this.headers = Object.fromEntries(Object.entries(headers).map(([k,v]) => [k.toLowerCase(), v])); },
        end(body) { resolve({ status: this.status, headers: this.headers, bytes: Buffer.from(body) }); } };
      route.handler(req, res);
    });
  }
  // Guide references each allowed path exactly once; fenced and hidden files are not references.
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), [
    '# Guide', '',
    '![root](../pic.png)',
    '![local](pic.png)',
    '![diagram](diagram.svg)',
    '![huge](huge.png)',
    '![dir](directory.png)',
    '![txt](plain.txt)', '',
    '\u0060\u0060\u0060text', '![fenced](fenced.png)', '\u0060\u0060\u0060', '',
    // 带 info 的围栏行在围栏内只是代码内容，不能提前关闭围栏。
    '\u0060\u0060\u0060js', '\u0060\u0060\u0060text', '![nested](nested.png)', '\u0060\u0060\u0060', '',
  ].join('\n'));
  return { root, state, binding, handle, request, docId, inlineId, log, openWriter, openedCount() { return opened; }, put(relPath, bytes) { fs.writeFileSync(path.join(root, relPath), bytes); } };
}

// 责任：PNG/SVG 与正文引用返回原始字节、MIME、长度和 no-store，重复读取不能命中观测缓存。
test('cold image assets return exact bytes without writes or cache', async (t) => {
  const f = await fixture(t);
  const log = fs.readFileSync(f.log);
  assert.equal(IMAGE_MAX_BYTES, 4 * 1024 * 1024);
  const png = Buffer.from([137,80,78,71,0,255]);
  f.put('pic.png', png);
  f.put('docs/pic.png', png);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  f.put('docs/diagram.svg', svg);
  for (const [name, mime, bytes] of [
    ['../pic.png', 'image/png', png],
    ['pic.png', 'image/png', png],
    ['diagram.svg', 'image/svg+xml', svg],
  ]) {
    const state = JSON.stringify(f.state);
    const response = await f.request(name);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers['content-type'], mime);
    assert.equal(response.headers['content-length'], String(bytes.length));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.bytes, bytes);
    assert.equal(readImageAsset(f.handle, f.docId, name).hash, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(JSON.stringify(f.state), state);
  }
  f.put('pic.png', Buffer.from('changed'));
  assert.equal((await f.request('../pic.png')).bytes.toString(), 'changed');
  assert.equal(f.openedCount(), 0, 'asset reads must not call service.open');
  assert.deepEqual(fs.readFileSync(f.log), log);

  await f.openWriter();
  const hotLog = fs.readFileSync(f.log);
  const hot = await f.request('diagram.svg');
  assert.equal(hot.status, 200);
  assert.deepEqual(hot.bytes, svg, 'published-state DTO must retain binary bytes');
  assert.equal(f.openedCount(), 1, 'the route must not open the existing writer again');
  assert.deepEqual(fs.readFileSync(f.log), hotLog);
});

// 责任：未引用、围栏内引用与非法路径都拒绝，且不泄露本机路径；扩展名/大小/类型边界按契约。
test('image asset refusals use the documented status and error envelope', async (t) => {
  const f = await fixture(t);
  f.put('pic.png', Buffer.from([1]));
  f.put('docs/pic.png', Buffer.from([1]));
  f.put('docs/huge.png', Buffer.alloc(IMAGE_MAX_BYTES + 1));
  fs.mkdirSync(path.join(f.root, 'docs', 'directory.png'));
  f.put('docs/plain.txt', Buffer.from('text'));
  f.put('docs/fenced.png', Buffer.from([1]));
  f.put('docs/nested.png', Buffer.from([1]));
  f.put('docs/hidden.png', Buffer.from([1]));
  const cases = [
    ['../../escape.png', f.docId, 403, 'outside-root'],
    ['/absolute.png', f.docId, 403, 'security-rejected'],
    ['C:/drive.png', f.docId, 403, 'security-rejected'],
    ['a\\b.png', f.docId, 403, 'security-rejected'],
    ['a//b.png', f.docId, 403, 'security-rejected'],
    ['a/\u0000b.png', f.docId, 403, 'security-rejected'],
    ['hidden.png', f.docId, 404, 'not-found'],
    ['fenced.png', f.docId, 404, 'not-found'],
    ['nested.png', f.docId, 404, 'not-found'],
    ['plain.txt', f.docId, 415, 'unsupported-format'],
    ['missing.png', f.docId, 404, 'not-found'],
    ['pic.png', f.inlineId, 404, 'not-found'],
    ['pic.png', 'doc_unknown', 404, 'not-found'],
    ['huge.png', f.docId, 413, 'oversize'],
    ['directory.png', f.docId, 400, 'not-regular'],
    [null, f.docId, 400, 'invalid-command'],
  ];
  for (const [src, docId, status, code] of cases) {
    const response = await f.request(src, docId);
    assert.equal(response.status, status, String(src));
    const body = JSON.parse(response.bytes);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, code, String(src));
    assert.ok(!response.bytes.toString().includes(f.root));
  }
  assert.equal((await f.request('pic.png', f.docId, '')).status, 403);
  assert.equal((await f.request('pic.png', f.docId, '', '&token=secret')).status, 403, 'query token must not authorize');
  f.handle.service.bindings = () => ({ activeFor: () => [], mainOf: () => null });
  assert.equal((await f.request('pic.png')).status, 409);
  f.handle.service.bindings = () => ({ activeFor: () => [{ ...f.binding, root: path.join(f.root, 'absent') }], mainOf: () => null });
  assert.equal((await f.request('pic.png')).status, 503);
});

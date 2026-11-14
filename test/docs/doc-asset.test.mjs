/**
 * 测试职责：文档图片的只读字节路由、鉴权、正文引用范围与路径/大小/格式边界。
 * 典型流程：合成 binding 与临时图片 → 真实路由 handler → 比较状态、字节及 envelope。
 * 覆盖边界：不依赖宿主或网络端口；不覆盖浏览器解码、真实网络盘权限。
 * 外部前置：无；只使用合成临时目录。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerRoutes } from '../../lib/host/routes.js';
import { IMAGE_MAX_BYTES, readImageAsset } from '../../lib/core/documents/assets.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-assets-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const state = { docs: {
    doc_test: { id: 'doc_test', source: 'external', locator: { bindingId: 'bnd_test', relPath: 'docs/guide.md' } },
    doc_inline: { id: 'doc_inline', source: 'inline' },
  } };
  const binding = { bindingId: 'bnd_test', root };
  let opened = 0;
  const service = {
    bindings: () => ({ activeFor: () => [binding] }),
    async open() { opened += 1; return handle; },
    peekProjectState() { return state; },
  };
  const handle = { id: 'prj_test', state, service,
    command() { throw new Error('asset read must never acquire a writer'); } };
  let route;
  registerRoutes({ webServer: { register(value) { route = value; return () => {}; } }, on() { return () => {}; } },
    { token: 'secret', ready: Promise.resolve(), service });
  function request(relPath, docId = 'doc_test', token = 'secret') {
    return new Promise((resolve) => {
      const req = { method: 'GET', url: '/project-board/api/projects/prj_test/docs/external/' + docId + '/assets' + (relPath === null ? '' : '?path=' + encodeURIComponent(relPath)), headers: { 'x-project-board-token': token } };
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
    '![huge](huge.png)',
    '![dir](directory.png)',
    '![txt](plain.txt)', '',
    '\u0060\u0060\u0060text', '![fenced](fenced.png)', '\u0060\u0060\u0060', '',
  ].join('\n'));
  return { root, state, binding, handle, request, openedCount() { return opened; }, put(relPath, bytes) { fs.writeFileSync(path.join(root, relPath), bytes); } };
}

// 责任：PNG/SVG 与正文引用返回原始字节、MIME、长度和 no-store，重复读取不能命中观测缓存。
test('image assets return exact PNG/SVG bytes without writes or cache', async () => {
  const f = fixture();
  assert.equal(IMAGE_MAX_BYTES, 4 * 1024 * 1024);
  const png = Buffer.from([137,80,78,71,0,255]);
  f.put('pic.png', png);
  f.put('docs/pic.png', png);
  for (const [name, mime, bytes] of [
    ['../pic.png', 'image/png', png],
    ['pic.png', 'image/png', png],
  ]) {
    const state = JSON.stringify(f.state);
    const response = await f.request(name);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers['content-type'], mime);
    assert.equal(response.headers['content-length'], String(bytes.length));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.bytes, bytes);
    assert.equal(readImageAsset(f.handle, 'doc_test', name).hash, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(JSON.stringify(f.state), state);
  }
  f.put('pic.png', Buffer.from('changed'));
  assert.equal((await f.request('../pic.png')).bytes.toString(), 'changed');
  assert.equal(f.openedCount(), 0, 'asset reads must not call service.open');
});

// 责任：未引用、围栏内引用与非法路径都拒绝，且不泄露本机路径；扩展名/大小/类型边界按契约。
test('image asset refusals use the documented status and error envelope', async () => {
  const f = fixture();
  f.put('pic.png', Buffer.from([1]));
  f.put('docs/pic.png', Buffer.from([1]));
  f.put('docs/huge.png', Buffer.alloc(IMAGE_MAX_BYTES + 1));
  fs.mkdirSync(path.join(f.root, 'docs', 'directory.png'));
  f.put('docs/plain.txt', Buffer.from('text'));
  f.put('docs/fenced.png', Buffer.from([1]));
  f.put('docs/hidden.png', Buffer.from([1]));
  const cases = [
    ['../../escape.png', 'doc_test', 403, 'outside-root'],
    ['/absolute.png', 'doc_test', 403, 'security-rejected'],
    ['C:/drive.png', 'doc_test', 403, 'security-rejected'],
    ['a\\b.png', 'doc_test', 403, 'security-rejected'],
    ['a//b.png', 'doc_test', 403, 'security-rejected'],
    ['a/\u0000b.png', 'doc_test', 403, 'security-rejected'],
    ['hidden.png', 'doc_test', 404, 'not-found'],
    ['fenced.png', 'doc_test', 404, 'not-found'],
    ['plain.txt', 'doc_test', 415, 'unsupported-format'],
    ['missing.png', 'doc_test', 404, 'not-found'],
    ['pic.png', 'doc_inline', 404, 'not-found'],
    ['pic.png', 'doc_unknown', 404, 'not-found'],
    ['huge.png', 'doc_test', 413, 'oversize'],
    ['directory.png', 'doc_test', 400, 'not-regular'],
    [null, 'doc_test', 400, 'invalid-command'],
  ];
  for (const [src, docId, status, code] of cases) {
    const response = await f.request(src, docId);
    assert.equal(response.status, status, String(src));
    const body = JSON.parse(response.bytes);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, code, String(src));
    assert.ok(!response.bytes.toString().includes(f.root));
  }
  assert.equal((await f.request('pic.png', 'doc_test', '')).status, 403);
  f.handle.service.bindings = () => ({ activeFor: () => [] });
  assert.equal((await f.request('pic.png')).status, 409);
  f.handle.service.bindings = () => ({ activeFor: () => [{ ...f.binding, root: path.join(f.root, 'absent') }] });
  assert.equal((await f.request('pic.png')).status, 503);
});

/**
 * 测试职责：文档图片的只读字节路由、鉴权、路径安全和大小/格式边界。
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
  const handle = { id: 'prj_test', state, service: { bindings: () => ({ activeFor: () => [binding] }) },
    command() { throw new Error('asset read must never acquire a writer'); } };
  let route;
  registerRoutes({ webServer: { register(value) { route = value; return () => {}; } }, on() { return () => {}; } },
    { token: 'secret', ready: Promise.resolve(), service: { async open() { return handle; } } });
  function request(relPath, docId = 'doc_test', token = 'secret') {
    return new Promise((resolve) => {
      const req = { method: 'GET', url: '/project-board/api/projects/prj_test/docs/external/' + docId + '/assets' + (relPath === null ? '' : '?path=' + encodeURIComponent(relPath)), headers: { 'x-project-board-token': token } };
      const res = { status: 0, headers: {}, writeHead(status, headers) { this.status = status; this.headers = Object.fromEntries(Object.entries(headers).map(([k,v]) => [k.toLowerCase(), v])); },
        end(body) { resolve({ status: this.status, headers: this.headers, bytes: Buffer.from(body) }); } };
      route.handler(req, res);
    });
  }
  return { root, state, binding, handle, request, put(relPath, bytes) { fs.writeFileSync(path.join(root, relPath), bytes); } };
}

// 责任：PNG/SVG 与根内父路径返回原始字节、MIME、长度和 no-store，重复读取不能命中观测缓存。
test('image assets return exact PNG/SVG bytes without writes or cache', async () => {
  const f = fixture();
  assert.equal(IMAGE_MAX_BYTES, 4 * 1024 * 1024);
  for (const [name, mime, bytes] of [
    ['pic.png', 'image/png', Buffer.from([137,80,78,71,0,255])],
    ['pic.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ]) {
    f.put(name, bytes);
    const state = JSON.stringify(f.state);
    const response = await f.request('../' + name);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], mime);
    assert.equal(response.headers['content-length'], String(bytes.length));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.bytes, bytes);
    assert.equal(readImageAsset(f.handle, 'doc_test', '../' + name).hash, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(JSON.stringify(f.state), state);
    f.put(name, Buffer.from('changed'));
    assert.equal((await f.request('../' + name)).bytes.toString(), 'changed');
  }
});

// 责任：失败保留统一 JSON envelope，不泄露本机路径；鉴权不接受 URL token。
test('image asset refusals use the documented status and error envelope', async () => {
  const f = fixture();
  f.put('docs/huge.png', Buffer.alloc(IMAGE_MAX_BYTES + 1));
  fs.mkdirSync(path.join(f.root, 'docs', 'directory.png'));
  const cases = [
    ['../../escape.png', 'doc_test', 403, 'outside-root'],
    ['/absolute.png', 'doc_test', 403, 'security-rejected'],
    ['C:/drive.png', 'doc_test', 403, 'security-rejected'],
    ['a\\b.png', 'doc_test', 403, 'security-rejected'],
    ['a//b.png', 'doc_test', 403, 'security-rejected'],
    ['a/\u0000b.png', 'doc_test', 403, 'security-rejected'],
    ['plain.txt', 'doc_test', 415, 'unsupported-format'],
    ['missing.png', 'doc_test', 404, 'file-missing'],
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

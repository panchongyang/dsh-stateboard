/**
 * 测试职责：独占图片分块、相对资源 URL 及带头鉴权的字节传输。
 * 典型流程：真实 parser/transport → 合成文本与 fetch → 对照 block、URL、headers。
 * 覆盖边界：覆盖 独占图片分块、相对资源 URL 与带头鉴权字节传输；不覆盖 图片解码、CSP 或视觉布局。
 * 外部前置：hook 用例使用仓库 tools/build 的既有 esbuild；只用合成页面配置。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { markdownBlocks } from '../../../src/client/utils/markdown.ts';
import { docAssetUrl, getDocAsset } from '../../../src/client/api/transport.ts';

// 责任：只把独占一行图片当 image；相邻正文及内联引用不能丢失。
test('markdownBlocks recognizes standalone images and preserves surrounding text', () => {
  assert.deepEqual(markdownBlocks('before\n![图](../assets/pic.png)\nafter'), [
    { type: 'paragraph', text: 'before' }, { type: 'image', alt: '图', src: '../assets/pic.png' }, { type: 'paragraph', text: 'after' },
  ]);
  assert.deepEqual(markdownBlocks('   ![](pic.svg) '), [{ type: 'image', alt: '', src: 'pic.svg' }]);
  for (const body of ['plain text', 'before ![alt](pic.png)', '![alt](pic.png) after', '    ![alt](pic.png)', '![alt](a b.png)']) {
    assert.ok(markdownBlocks(body).every((block) => block.type !== 'image'), body);
  }
  const fence = String.fromCharCode(96).repeat(3);
  assert.equal(markdownBlocks(fence + '\n![alt](pic.png)\n' + fence)[0].type, 'code');
});

// 责任：图片请求复用页面 base/token；token 不落 URL，拒绝响应保持局部失败。
test('asset transport encodes paths and sends capability only as a header', async (t) => {
  const previous = globalThis.__PROJECT_BOARD__;
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.__PROJECT_BOARD__ = previous; globalThis.fetch = previousFetch; });
  globalThis.__PROJECT_BOARD__ = { base: '/project-board/api', token: 'private-capability' };
  const url = docAssetUrl('prj_one', 'doc_two', '../a #.svg');
  assert.equal(url, '/project-board/api/projects/prj_one/docs/external/doc_two/assets?path=..%2Fa%20%23.svg');
  assert.ok(!url.includes('private-capability'));
  const blob = new Blob(['<svg/>'], { type: 'image/svg+xml' });
  globalThis.fetch = async (input, init) => {
    assert.equal(input, url);
    assert.equal(init.headers['x-project-board-token'], 'private-capability');
    assert.equal(init.cache, 'no-store');
    return { ok: true, blob: async () => blob };
  };
  assert.equal(await getDocAsset('prj_one', 'doc_two', '../a #.svg', new AbortController().signal), blob);
  for (const status of [403,404,413,415]) {
    globalThis.fetch = async () => ({ ok: false, status });
    await assert.rejects(getDocAsset('prj_one', 'doc_two', 'a.png', new AbortController().signal));
  }
});

// 责任：相同 src 去重，跨文档切换取消迟到请求并撤销 Blob URL，危险引用不发请求。
test('document image lifecycle deduplicates, rejects remote paths and revokes URLs', async (t) => {
  const esbuild = createRequire(new URL('../../../tools/build/package.json', import.meta.url))('esbuild');
  const built = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../../../src/client/hooks/use-doc-images.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', external: ['react'], write: false,
  });
  let state;
  let deps;
  let cleanup;
  const react = {
    useState(initial) { if (!state) state = initial; return [state, (next) => { state = next; }]; },
    useEffect(fn, next) {
      if (!deps || next.some((value, i) => value !== deps[i])) { cleanup?.(); deps = next; cleanup = fn(); }
    },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)((name) => { assert.equal(name, 'react'); return react; }, module, module.exports);
  const previous = { fetch: globalThis.fetch, config: globalThis.__PROJECT_BOARD__, revoke: URL.revokeObjectURL };
  const requests = [];
  const revoked = [];
  t.after(() => { cleanup?.(); globalThis.fetch = previous.fetch; globalThis.__PROJECT_BOARD__ = previous.config; URL.revokeObjectURL = previous.revoke; });
  globalThis.__PROJECT_BOARD__ = { base: '/project-board/api', token: 'secret' };
  URL.revokeObjectURL = (url) => { revoked.push(url); previous.revoke.call(URL, url); };
  globalThis.fetch = (url, init) => new Promise((resolve) => { requests.push({ url, init, resolve }); });
  const body = ['![a](pic.png)', '![b](pic.png)', '![x](https://remote/pic.png)', '![](data:abc)', '![](/absolute.png)', '![](C:/drive.png)'].join('\n');
  const render = (docId = 'doc_one', text = body) => module.exports.useDocImages('prj_test', docId, text);
  assert.equal(render()('pic.png'), null);
  assert.equal(requests.length, 1);
  requests[0].resolve({ ok: true, blob: async () => new Blob(['image']) });
  await new Promise((resolve) => setImmediate(resolve));
  const url = render()('pic.png');
  assert.match(url, /^blob:/);
  assert.equal(requests.length, 1);
  assert.equal(render('doc_two')('pic.png'), null);
  assert.deepEqual(revoked, [url]);
  assert.equal(requests[0].init.signal.aborted, true);
  render('doc_three', 'plain text');
  assert.equal(requests[1].init.signal.aborted, true);
  requests[1].resolve({ ok: true, blob: async () => new Blob(['late']) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render('doc_three', 'plain text')('pic.png'), null);
  assert.deepEqual(revoked, [url]);
});

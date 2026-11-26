/**
 * 测试职责：旧 Git 引用只用已记录来源，保持两种对象格式的身份约束。
 * 典型流程：合成外置登记和历史来源 → 按明确引用读取 → 逐项核对字段和拒绝情形。
 * 覆盖边界：覆盖 历史来源记录与身份校验；不覆盖 真实 Git 仓库或实际原文。
 * 外部前置：无 Git 依赖；只构建临时项目和 JSONL 合成记录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getFixedContent } from '../../lib/core/documents/fixed-content.js';
import { LEGACY_GIT_RECORD } from '../../lib/shared/contract.js';
import { withProject, command } from '../helpers/service-fixture.mjs';
import { appendLegacyFacts, put, sha } from '../helpers/fixed-fixture.mjs';

for (const objectFormat of ['sha1', 'sha256']) {
  // 责任：两种历史对象身份均可记录回读，但不存在或不匹配的固定身份不得被推断。
  test('legacy fixed source-only lookup preserves recorded identity in ' + objectFormat, async t => {
    const { h, wsDir } = await withProject(t);
    put(wsDir, 'spec.md', 'current file is not historical');
    const { docId } = await h.command(command('doc.external.register', { title: 'Fixture', relPath: 'spec.md' }));
    const width = objectFormat === 'sha1' ? 40 : 64;
    const fixed = { v: 1, projectId: h.id, objectFormat, commitOid: '1'.repeat(width), pathAtCommit: 'spec.md',
      blobOid: '2'.repeat(width), blobContentHash: sha('historical fixture') };
    const input = { docId, fixed };
    assert.throws(() => getFixedContent(h, input), { code: 'not-found' });
    appendLegacyFacts(h, [{ type: 'doc/content-fixed', docId, data: { kind: 'doc', ref: docId, hash: fixed.blobContentHash, fixed } }]);
    const before = fs.readFileSync(h.store.commitsFile);
    const result = getFixedContent(h, input);
    assert.deepEqual(result.fixed, fixed);
    for (const [field, value] of Object.entries(LEGACY_GIT_RECORD)) assert.equal(result[field], value, field);
    assert.equal(result.body, null);
    assert.equal(result.totalBytes, null);
    assert.equal(result.hash, fixed.blobContentHash);
    assert.equal(result.hashDomain, 'git-blob-bytes');
    assert.deepEqual(getFixedContent(h, { docId, commitOid: fixed.commitOid, pathAtCommit: fixed.pathAtCommit }), result);
    assert.throws(() => getFixedContent(h, { docId, fixed: { ...fixed, blobOid: '3'.repeat(width) } }), { code: 'not-found' });
    assert.throws(() => getFixedContent(h, { docId, fixed: { ...fixed, pathAtCommit: '../escape.md' } }), { code: 'invalid-fixed-reference' });
    assert.deepEqual(fs.readFileSync(h.store.commitsFile), before);
  });
}

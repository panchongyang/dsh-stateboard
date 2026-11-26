/**
 * 测试职责：验证 MCP 签发、鉴别和单一空间授权。
 * 典型流程：给 A 签发凭据，复制到 B，分别验证原凭据和新凭据。
 * 覆盖边界：覆盖权限、重复授权、移除授权和同路径换根；不覆盖业务工具或真实配置。
 * 外部前置：Node 和隔离临时目录，无需服务、网络或真实 token。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueSpaceGrant, spaceGrantFor } from '../../lib/host/mcp-space-grant.js';

// 责任：认证只取签发时的实际根及权限，副本、错票、重指、撤权均不成为授权。
test('a credential is issued for exactly one root and one scope', async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'board-credential-')));
  const a = path.join(tmp, 'A'), b = path.join(tmp, 'B'); fs.mkdirSync(a); fs.cpSync(a, b, { recursive: true, errorOnExist: true, force: false });
  assert.throws(() => issueSpaceGrant(a, 'owner')); assert.throws(() => issueSpaceGrant('.', 'full'));
  const A = issueSpaceGrant(a, 'metadata'), B = issueSpaceGrant(b, 'full'), grants = [A.grant, B.grant];
  assert.ok(!JSON.stringify(grants).includes(A.token)); assert.deepEqual(fs.readdirSync(a), []);
  const use = (token, rows = grants) => spaceGrantFor(rows, 'Bearer ' + token);
  const old = use(A.token); assert.equal(old.spaceRoot, a); assert.equal(old.scope, 'metadata'); assert.equal(use(B.token).spaceRoot, b);
  assert.equal(use(A.token, [B.grant]), null); assert.equal(use(A.token, [...grants, A.grant]), null);
  assert.equal(use(A.token, [{ ...A.grant, scope: 'full' }]), null, '相同摘要不能给只读票升级');
  assert.equal(use(A.token, [{ ...B.grant, tokenHash: A.grant.tokenHash }]), null, '不能把已有票重定向到副本');
  assert.equal(use('bad-token'), null);
  const pendingRead = old.assertCurrentAsync(); grants.shift();
  await assert.rejects(pendingRead, {code:'project-forbidden'});
  assert.throws(old.assertCurrent, { code: 'project-forbidden' });
  grants.unshift(A.grant); const original = path.join(tmp, 'preserved-A');
  assert.equal(path.dirname(a), tmp); assert.equal(path.dirname(original), tmp); fs.renameSync(a, original);
  fs.cpSync(b, a, { recursive: true, errorOnExist: true, force: false });
  assert.equal(use(A.token), null); assert.throws(old.assertCurrent, { code: 'project-forbidden' }); assert.doesNotThrow(use(B.token).assertCurrent);
});

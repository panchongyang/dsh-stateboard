/**
 * 测试职责：约束发布候选 tag 决策与消息记录，兼容声明不足或门禁失败时拒绝。
 * 典型流程：合成改动面/日期/标签或临时 Git 提交 → evaluate 或 dry-run CLI → 比较决定与消息。
 * 覆盖边界：覆盖 标签命名、变更面分类及 compat 要求；不覆盖真实打 tag、push、部署或发布。
 * 外部前置：CLI 场景需要 Git；仅临时仓库 dry-run，不创建 tag。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTagMessage, classifyFiles, dateStamp, evaluateRelease, nextTagName } from '../../scripts/release-tag.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Windows keeps a directory busy for a moment after a spawned process exits
 * (indexers/AV scanning the just-written tree), and fs.rmSync does not retry an
 * EBUSY from rmdir. Retry explicitly; a lock that outlives the window still
 * fails the test instead of being suppressed.
 */
function removeTree(dir) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() >= deadline || !['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'].includes(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

// 责任：同日部署 tag 序号须取最大值加一，跨日须从 1 开始。
test('tag names increment per day and reset on a new day', () => {
  const date = new Date(2026, 9, 28, 12, 0, 0);
  assert.equal(nextTagName([], date), 'deploy-20261028-1');
  assert.equal(nextTagName(['deploy-20261028-1', 'deploy-20261028-3'], date), 'deploy-20261028-4');
  assert.equal(nextTagName(['deploy-20261027-7'], date), 'deploy-20261028-1');
  assert.equal(dateStamp(date), '20261028');
});

// 责任：改动面须按路径识别存储/宿主/客户端，不能以提交数量推断。
test('file surfaces are classified by path, not by commit count', () => {
  const surfaces = classifyFiles([
    'lib/core/model.js',
    'lib/core/commands/task-work.js',
    'lib/shared/contract.js',
    'lib/host/tools/task.js',
    'src/client/views/board.js',
    'lib/client.js',
    'docs/RELEASE.md',
  ]);
  assert.equal(surfaces.storage.includes('lib/core/model.js'), true);
  assert.equal(surfaces.storage.includes('lib/core/commands/task-work.js'), true);
  assert.equal(surfaces.host.includes('lib/host/tools/task.js'), true);
  assert.equal(surfaces.client.includes('src/client/views/board.js'), true);
  assert.equal(surfaces.client.includes('lib/client.js'), true);
  assert.equal(surfaces.storage.includes('docs/RELEASE.md'), false);
});

// 责任：工作树脏或 gate 非零时必须拒绝候选发布并说明具体原因。
test('a dirty tree or a failed gate refuses the release', () => {
  const dirty = evaluateRelease({ dirty: true, gateCode: 0, files: [], compat: null, tags: [] });
  assert.equal(dirty.ok, false);
  assert.match(dirty.reason, /dirty/);
  const failed = evaluateRelease({ dirty: false, gateCode: 1, files: [], compat: null, tags: [] });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /gate failed/);
});

// 责任：存储/事件改动缺少或乱填 compat 类别须拒绝，有效声明才可生成候选 tag。
test('event/storage surfaces require an explicit compat class', () => {
  const files = ['lib/core/model.js'];
  const missing = evaluateRelease({ dirty: false, gateCode: 0, files, compat: null, tags: [] });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /--compat/);
  assert.equal(missing.surfaces.storage[0], 'lib/core/model.js');

  const wrong = evaluateRelease({ dirty: false, gateCode: 0, files, compat: 'whatever', tags: [] });
  assert.equal(wrong.ok, false);

  const declared = evaluateRelease({ dirty: false, gateCode: 0, files, compat: 'additive', tags: [] });
  assert.equal(declared.ok, true);
  assert.equal(declared.compat, 'additive');
  assert.equal(declared.tag, 'deploy-' + dateStamp() + '-1');
});

// 责任：只有文档改动时可不声明 compat，决定中 compat 应保持 null。
test('a docs-only release needs no compat class', () => {
  const decision = evaluateRelease({ dirty: false, gateCode: 0, files: ['docs/RELEASE.md'], compat: null, tags: [] });
  assert.equal(decision.ok, true);
  assert.equal(decision.compat, null);
});

// 责任：生成 tag message 须包含 sha、epoch、兼容类别和各改动面。
test('tag message records sha, epoch, compat and surfaces', () => {
  const message = buildTagMessage({
    sha: 'abc1234',
    epoch: 'schema=2 projects=4',
    clientHash: 'sha256:deadbeef',
    surfaces: { storage: ['lib/core/model.js'], host: [], client: [], total: 1 },
    compat: 'refuse',
    gate: 'check:strict',
  });
  assert.match(message, /release abc1234/);
  assert.match(message, /epoch: schema=2 projects=4/);
  assert.match(message, /compat: refuse/);
  assert.match(message, /storage: lib\/core\/model\.js/);
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// 责任：临时 schema 改动的 CLI dry-run 缺 compat 须失败，显式声明后成功且不创建 tag。
test('dry-run CLI refuses schema changes without --compat and accepts them with it', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-release-'));
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'test']);
    fs.mkdirSync(path.join(repo, 'lib', 'core'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'lib', 'core', 'model.js'), 'export const version = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'one']);
    fs.writeFileSync(path.join(repo, 'lib', 'core', 'model.js'), 'export const version = 2;\n');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'two']);

    const script = path.join(root, 'scripts', 'release-tag.mjs');
    const refused = spawnSync(process.execPath, [script, '--dry-run', '--skip-gate'], { cwd: repo, encoding: 'utf8' });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /--compat/);

    const accepted = spawnSync(process.execPath, [script, '--dry-run', '--skip-gate', '--compat', 'additive'], { cwd: repo, encoding: 'utf8' });
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.match(accepted.stdout, /release: deploy-\d{8}-1/);
    assert.match(accepted.stdout, /dry run/);
    assert.deepEqual(git(repo, ['tag', '--list']), '', 'dry-run must not create a tag');

    // Real tag creation path: stub the gate command (the repo under test has no npm test setup).
    const gate = '"' + process.execPath + '" --version';
    const tagged = spawnSync(process.execPath, [script, '--compat', 'additive'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PB_RELEASE_GATE_CMD: gate },
    });
    assert.equal(tagged.status, 0, tagged.stdout + tagged.stderr);
    assert.match(tagged.stdout, /tagged deploy-\d{8}-1 at/);
    const tags = git(repo, ['tag', '--list']).split(/\r?\n/).filter(Boolean);
    assert.equal(tags.length, 1);
    assert.match(tags[0], /^deploy-\d{8}-1$/);
    const body = git(repo, ['for-each-ref', 'refs/tags/' + tags[0], '--format=%(contents)']);
    assert.match(body, /release [0-9a-f]{7,}/);
    assert.match(body, /epoch: schema=/);
    assert.match(body, /compat: additive/);
  } finally {
    removeTree(repo);
  }
});

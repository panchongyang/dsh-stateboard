## 规格：D5「自动壳」（交实现方实施）

依据：[复议记录：固定证据改为自动跟随 + 自动降级（不增加用户心智负担）](../decisions/auto-follow-fixed-evidence.md)；仓库 [docs/PRODUCT-PRINCIPLES.md](../PRODUCT-PRINCIPLES.md)。核心引擎（固定结构、同 commit 屏障、`get_fixed`、拒绝矩阵）已在 `feat/doc-fixed-evidence` 分支完成并通过审查，**本规格只加"自动发生 + 失败降级"这层外壳，不改核心语义**。

## 1. 自动批准（取消用户操作）

- 首次需要固定证据时，系统自动对**该项目主绑定根所在仓库**记录批准：`anchorCommitOid`（当前 HEAD 提交）、`objectFormat`、`bindingId`，写一条可审计事件（`actor: system`）。
- 不向用户索取输入、不暴露"批准仓库"动作；`doc.repository.approve` 保留为兼容/内部路径，不再是前置步骤。
- 幂等：已批准同一来源时不再写事件。

## 2. 自动钉版本（跟随提交/人审）

- 触发点：任务提交（`task.submit`）与人审通过（`task.verify`）。
- 条件全部满足才钉：该路径**已提交**、该路径**工作区干净**、仓库可解析、未命中 filter/encoding/ident、内容非 LFS 指针。
- 满足时：自动生成固定引用（commitOid / pathAtCommit / blobOid / objectFormat / blobContentHash），并在**同一原子 commit** 内携带匹配的 `doc/content-fixed`（契约 §5 屏障不变）。
- 不满足时：见下条降级。

## 3. 静默降级 + 标记字段

- 证据照常写入，**不失败、不弹窗、不要求安装**；证据行新增：
  - `fixedState: 'pinned' | 'current-only'`
  - `fixedReason`（仅 current-only 时出现）：`no-git` | `git-unavailable` | `uncommitted` | `dirty-worktree` | `content-transform` | `lfs-pointer` | `not-a-repo` | `nested-repository` | `multiple-repositories` | `unsupported-format` | `oversize`
- 绝不把 `current-only` 显示或序列化成"已固定"。`pinned` 行的 `fixed` 结构与现有 `get_fixed` 读取路径完全一致（不新增读取分支）。

## 4. 文档

- `docs/DOC-EXTERNAL-EVIDENCE.md` 按现状改写：自动批准、自动钉、降级矩阵、`fixedState`/`fixedReason` 字段；删除"需要用户显式批准/确认"的表述；注明这是对冻结契约 §4.2/§4.3"显式"措辞的**有意偏离**，已在上述复议记录登记。
- 不修改 `docs/WORKSPACE-DOCUMENTS-CONTRACT.md`（冻结契约本体）。

## 5. 测试（新建 `test/doc-fixed-auto.test.mjs`，接入 `test:core`）

1. 无 git 环境（PATH 去掉 git 或用注入的 runner）→ 提交证据成功，`fixedState: 'current-only'`，`fixedReason: 'no-git'`。
2. 干净且已提交 → `pinned`，同一 commit 内可见匹配 `doc/content-fixed`。
3. 工作区有未提交修改 → `current-only` + `uncommitted`，且**不生成** fixed 引用。
4. 路径命中 filter → `current-only` + `content-transform`，且驱动未执行（MARK 不存在）。
5. 内容为 LFS 指针 → `current-only` + `lfs-pointer`，不把指针当正文。
6. 自动批准幂等：连续两次触发只产生一条批准事件（或第二次无事件）。
7. 回放/快照一致：含自动 `doc/content-fixed` 的日志在冷开与快照路径下行为一致；旧注册表读到该事件仍拒读。

## 6. 边界

- 不改 `lib/core/evidence.js` 既有 file 证据语义与 hash 算法；不改冻结契约；不碰真实 store；不 push/merge；不调看板写工具。
- 门禁：隔离 HOME 下 `npm run check:strict` + `npm run check:architecture`；文件 ≤450 行、函数 ≤80 行。
- 既有断言不得删改；如必须调整某条，先在回报里单列并说明理由。

delegation: yes — 自动壳属接口/接线层，交实现方；核心判断已完成。

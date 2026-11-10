# 工作区搬迁、换机与 schema v3 升级

入口互链：[安装](<INSTALL.md>) · [备份/故障恢复](<RECOVERY.md>) · [发布与部署边界](<RELEASE.md>) · [npm 包内自包含步骤](<../README.md#备份回退与迁移>)。

## 工作区与机器迁移

先停写并备份整个 board 根、工作区文件、必要 Git 对象、profile 配置和匹配包；只 clone 代码或复制 marker 不包含看板状态。新环境遵守 [支持矩阵](<../README.md#支持环境>)，不要与旧环境并发写同一 store。旧 key/profile 仅是私密历史材料，不作为新安装前置；当前版本不生成历史执行 key，也不执行或验签旧证明。

在匹配源码根目录，针对已核对的副本使用显式绝对 board 根和项目ID：

```text
node scripts/relocate-project.mjs --root "BOARD_ROOT" --project PROJECT_ID --to "NEW_WORKSPACE" --dry-run
node scripts/relocate-project.mjs --root "BOARD_ROOT" --project PROJECT_ID --to "NEW_WORKSPACE"
```

目标目录须存在且无另一个项目。脚本追加正常 relocate 事件，不移动文件；dry-run 会服务 open，可能触发冷开恢复/索引写，故必须先在副本演练，不能当零写诊断。脚本不保证跨机身份注册表合并或多 binding 自动迁移；冲突/缺身份时停止并保留副本，不手改日志或另建项目代替。

启动前核对主根与 binding。外置文档原定位可能仍指旧绑定，使用 `project_doc relocate`（当前 expectedMetaRev、明确 bindingId/relPath）逐个重定位；批量 rebind 仅 human/system。再 inspect/confirm，新上下文确认前不可比较，不把旧基线当匹配。file 相对路径按主根，绝对引用不重写。既有 Git fixed 缺对象时必须从备份恢复对象，不 fetch、不用当前字节替代历史。

迁移验收：新环境同一 projectId、任务/计划/文档数与历史可读；文件现状、binding、未闭意图及健康符合预期；授权副本可新提交并冷开保留。无可信备份或历史不可得必须记录限制。回退须停止写者，恢复完整备份与匹配版本，接受备份时点 RPO；外部副作用不能自动撤销。

## schema v3 离线升级

本文描述维护者操作，不是使用者前置配置，也不授权真实数据迁移、部署或重启。研发与演练只使用隔离合成 fixture；真实 store 需要单独授权与停写窗口。候选通过不代表当前宿主已部署新能力。

## 1. 运行时边界

- 新项目的 genesis、meta 与 project 使用 schemaVersion 3。运行时只识别 `requiresAudit` / `gate:audit`。
- v2 或缺失版本按 v2 处理，最终状态版本低于3时返回 `schema-migration-required`，在可写日志尾修复前拒绝。不在运行时猜测旧门字段，也不自动迁移真实 store。
- 计划 head 的派生仍为纯读兼容逻辑，不改成员归属；计划外与 orphaned 任务保持原状，不自动 adopt。
- 迁移脚本在源码维护工具中，**不进入 npm 发布包**。npm 使用者不需要手动学习迁移内部模型；升级由维护者安排。

## 2. 显式脚本接口

```text
node scripts/migrate-gate-v3.mjs --store <absolute-store-dir>
node scripts/migrate-gate-v3.mjs --store <absolute-store-dir> --apply
node scripts/migrate-gate-v3.mjs --store <absolute-store-dir> --apply --backup <outside-source-dir>
```

- `--store` 必须明确给出绝对单项目目录；没有隐式真实 HOME/DSH 根目录。
- 默认 dry-run：只读取并报告拟变更，零文件写入。先核对 projectId、任务/草稿数、schema 与目标路径。
- `--apply` 才写入：宿主必须停止；任何已有锁（包括陈旧锁/claim）均拒绝，不自动删锁或 force。脚本获取自己的独占合作锁。
- apply 先做整目录备份；默认是同级 `<store>.gate-v2-backup-<uniqueid>`。显式 `--backup` 必须不存在，且位于源 store 外。保留备份与迁移报告，不能把备份放入源目录。

## 3. 数据与事件

1. 独立 v2 读取器重放旧日志，将 `requiresHumanReview` / `gate:human` 转为 `requiresAudit` / `gate:audit`；旧字段只存在于迁移工具、测试与历史数据。
2. 保留全部原始 commit，不重写历史哈希链。
3. 追加一个迁移 commit：首先既有 `project/updated` 写 schemaVersion3，随后对**所有任务**追加全量 `task/updated`，包括 done/canceled/backlog/blocked/interrupted/orphaned。
4. 含旧门字段/标签的草稿计划 head 通过既有 `plan/updated` 保存转换后的任务定义，防止将来 publish 时静默丢门；没有受影响草稿就不需要该事件。
5. **不新增事件类型**，没有 schema 升级 marker。meta/snapshot 使用3；核对重放、health、任务/草稿计数及报告哈希。schema3 且无待转换数据为幂等 no-op。

存量门控任务获得同样的第三方审计门语义：human 可验收，独立 agent 可带自述报告显式验收；session 级独立性并非血统级信任保证。提交仍只进入 review，迁移不执行证据命令、不签名、不把材料自动变成 done。

## 4. 失败与回滚

- dry-run 无回滚副作用；apply 的任何失败都停止晋级，先检查备份、原目录、报告与锁归属，不盲目重跑或手删锁。
- 若迁移 commit 已落盘、日志已为3但 meta 仍为2，显式 `--apply` 会核对备份并只恢复 meta/snapshot，不追加事件；干净 schema3 的重复运行是真正 no-op。恢复过程仍要求停宿主与拒绝现有锁，不把一次 I/O 报错当成确定未提交。
- schema v3 使用既有事件类型，**旧构建可能读入却静默丢失审计门**；不能把“没有 incompatible-event”当作安全回退。
- **唯一支持的回滚是：停宿主，恢复迁移前完整备份，并使用匹配的旧构建。不能只切回代码。** 迁移后的新写入会丢失（RPO 为备份时刻），上线前必须确认可接受损失并独立演练。
- 日志恢复不撤销已经发生的外部副作用或验收决定；这些需要项目所有者另行处理。

## 5. 候选与授权

完整门禁针对冻结候选，由维护者统一执行。测试按 [TEST-ENV](<TEST-ENV.md>) 隔离 HOME/USERPROFILE/DSH/XDG/npm/TEMP，使用 Git 树外的合成临时目录；日志留在候选 `.evidence`。人工 UI 验收、真实迁移、合入、公开发布、部署与重启均是各自独立的授权。内嵌文档外置另见 [DOC-MIGRATION](<DOC-MIGRATION.md>)，不得把普通登记当作保持历史身份的迁移。

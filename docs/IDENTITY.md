# 项目身份与本机绑定

本文是身份最小闭环的现行说明；语义受 [D1 冻结契约](<WORKSPACE-DOCUMENTS-CONTRACT.md>) §1/§7 约束。

## 1. 模型

| 名称 | 含义 | 存放 |
|---|---|---|
| `projectId` | `prj_` + 16 位 hex，创建后永久稳定。新项目随机生成；旧项目保留原 ID（含路径哈希生成的），不重算、不改历史 | 日志 `project/created`、`meta.json`、目录名 |
| 主工作区 | 日志中 `project.workspacePath`，即共享 handle 的工作区与 file 证据根 | 日志（权威）、`meta.json`（派生缓存） |
| 本机绑定 `bindingId` | 本机目录 ↔ projectId，角色 `main`/`worktree`，状态 `active`/`retired`；只退役、不原地改指 | `<board根>/workspace-bindings.json` |
| 项目标记 | 工作区内可选文件 `.dsh-project.json`，只含 `{schemaVersion:1, projectId}`；不含路径、凭据、命令 | 用户工作区（由人显式 `mark` 写入） |

- 路径、目录名、分支名、remote URL、提交 hash 都**不是**身份。Git common-dir 只用于识别同一本机仓库的关联 worktree。
- 隐式绑定：没有持久化主绑定的项目（旧项目、未迁移的 store），按 `meta.json` 的 workspacePath 推导一条 `bnd_legacy_<hash>` 主绑定，仅存在于内存，不写盘；旧项目无需迁移即可照常打开。
- 绑定注册表是本机派生数据：可随时重建，不进入项目日志、不跨机共享。

## 2. 发现规则（`ProjectService.resolveWorkspace`）

会话 attach、工具 `resolveHandle`、HTTP 创建项目都走同一入口。

1. 从 cwd 逐级向上，最近的「有绑定或有标记」的目录决定归属；遇到仓库根（存在 `.git` 文件或目录）停止，嵌套仓库不会落到父项目。
2. 同一目录被多个项目绑定，或标记与绑定指向不同项目 → `identity-conflict`，不静默择一。
3. 在关联 worktree 内且自身无绑定：把相对路径映射到主 checkout 再查；命中则返回同一项目，`role=worktree`、`via=git-common-dir`，handle 的主工作区与证据根不变。子模块不视为 worktree；`.git` 损坏或 git 不可用则不映射。
4. 只有标记没有绑定：项目在本机有数据 → `binding-required`（`details.reason` 为 `moved` 或 `copied-or-forked`）；没有数据 → `board-data-missing`。两者都不自动建项目。
5. 以上都未命中：按日志 workspacePath 做旧版 lock-free 扫描（兼容 relocate 后 meta 未写成功的情况），仍未命中返回 null。

创建项目（`createProject`）：先从磁盘重读 meta 与注册表，再按目录自身的绑定与标记查重（标记与绑定不一致→`identity-conflict`）；关联 worktree 的根加入其主 checkout 的项目，未绑定的 worktree 内新建项目时建在主 checkout 对应路径。注册表锁内先写绑定再建日志：日志确定为空（文件不存在或 0 字节）时退役绑定并删除本次创建的目录；日志已有字节或状态无法确认时保留绑定与数据并登记，重试打开同一项目，不另建。多进程同时创建同一目录只会留下一个项目，落败者收到 `identity-conflict` 或（胜者数据尚未落盘时）`board-data-missing`。

所有占用目录的写操作（create、bind、relocate、import、fork）都先从磁盘重读 meta、日志路径与注册表再判定归属，并在注册表锁内写入；relocate 在提交前把目标目录登记为本项目的 worktree 预留（`purpose: relocate-reservation`），与并发 bind/create 互斥，提交后升级为主绑定；若提交失败，预留仍指向本项目，不改变主工作区，可 `unbind` 清理。

## 3. 显式操作（`scripts/identity.mjs`，human/system）

| 命令 | 作用 | 不变量 |
|---|---|---|
| `resolve --cwd <dir>` | 只读，显示 cwd 解析结果 | 无写入 |
| `plan` | 迁移 dry-run：列出每个项目的主根、根是否存在、将持久化的 bindingId，给出 `planHash` | 无写入 |
| `migrate --confirm <planHash>` | 把隐式主绑定写入注册表；planHash 不符、注册表已变或存在冲突即拒绝；重复执行为 0 写入 | 不改日志 |
| `relocate --project <id> --path <dir>` | 目录改名/移动后重绑：追加一条 `project/updated`，退役旧主绑定、新建主绑定 | 原 ID/任务/计划/文档/历史保留；目标被他项目占用或带他项目标记即拒绝 |
| `bind --project <id> --path <dir>` / `unbind --binding <id>` | 把同机 clone/目录显式连接为 worktree 绑定，或退役它；也可退役孤儿主绑定（创建在建日志前崩溃，项目无数据） | 有数据项目的主绑定只能经 relocate 变更 |
| `fork --path <带标记的副本>` | 复制/fork 选择「独立项目」：新随机 ID，并把副本标记改成新 ID | 原项目历史不变 |
| `import --from <导出的 projects/prj_… 目录> --path <本机目录>` | 跨机显式导入数据副本，再用 relocate 重绑到本机路径 | 保留 ID/日志/关系；不导入外机锁；同 ID 已有不同历史 → `already-exists`，不覆盖；中断后可重跑续接 |
| `mark --project <id>` | 在主根写入项目标记 | 只写 schemaVersion+projectId |

写项目日志的命令（relocate/fork/import）需先停 DSH 主进程，否则项目锁被宿主持有，命令拒绝为只读。

## 4. 错误码

`binding-required`、`board-data-missing`、`identity-conflict`、`invalid-project-marker`（400）、`bindings-unreadable`/`bindings-unsupported`/`bindings-locked`（503）。注册表损坏时已有项目仍按隐式绑定可读，所有身份写入拒绝，损坏文件原样保留待人处理；陈旧注册表锁只报告，不自动删除。

## 5. 兼容、回退与恢复

- **日志与事件**：未新增事件类型、未改 commit/meta 格式；新旧代码读写同一日志。
- **代码回退**：回退到身份改造前的提交即可读取全部项目。新代码创建的项目 ID 为随机值，旧代码按 `meta.json`/日志打开不受影响；`workspace-bindings.json` 被旧代码忽略。回退后旧代码只按主工作区路径发现，worktree 映射、标记与冲突拒绝随之失效。
- **数据回退**：注册表是派生数据，删除或移走 `workspace-bindings.json` 后回到隐式绑定（迁移前状态），再次 `plan`/`migrate` 可重建。项目日志只会因显式 relocate/import 追加记录，不会被改写。RPO = 0。
- **真实数据验证**：先获得授权并建立一致性副本与 SHA-256 清单。在隔离环境核对项目、任务、计划和文档计数后，再按 `plan` 检查拟迁移范围。
- **验证**：`test/core/identity.test.mjs`（ID、旧项目、迁移 dry-run、子目录/嵌套、worktree 与证据根、非 Git、移动重绑）、`test/core/identity-conflicts.test.mjs`（复制/fork、连接、无数据标记、跨机导入、分叉历史拒绝、恶意标记、冲突、注册表损坏/锁、创建/导入中断、多进程竞争）、`test/host/identity-host.test.mjs`（工具层主/worktree 会话共享看板与证据根、未绑定副本提示）。

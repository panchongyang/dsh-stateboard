# 项目与身份模块设计

> 文档定位：L3 模块设计；L1 权威：[服务与句柄](<../../CONTRACT.md#服务与句柄>)、[项目命令](<../../CONTRACT.md#22-命令清单>)、[冻结身份边界索引](<../../CONTRACT.md#3-冻结子契约索引1c>)。

本文解释项目身份、本机绑定和句柄装配；内部调用见[契约](<contract.md>)，全局位置见[L2](<../project.md>)。

## 1. 职责与非职责

project 负责将稳定项目 ID、本机工作区和日志目录连接起来。
service 维护项目元数据索引、绑定索引、共享 writer 和项目列表读取器。
专用 reader 提供不打开 writer 的读取路径，两者不是同一生命周期。

**非职责**：

- 不以路径、分支、remote URL 或提交 hash 充当项目身份。
- 不通过读取自动创建项目、绑定带标记的副本或导入缺失数据。
- 不管理 Git 分支/worktree，不把相关 checkout 的文件作为任意取证 fallback。
- 不把本机会话、工作区绑定和任务 lease 混为同一种身份。
- 不承接任务状态机、文档内容权威或 HTTP/MCP 授权策略。

## 2. 结构与事实源

| 实现 | 职责 |
|---|---|
| [service.js](<../../../lib/core/service.js>) | 项目发现门面、创建、open、共享与 meta 自愈 |
| [discover.js](<../../../lib/core/identity/discover.js>) | cwd 上行查找、marker、关联 worktree 映射 |
| [bindings.js](<../../../lib/core/identity/bindings.js>) | 持久绑定加隐式主绑定的内存索引 |
| [registry.js](<../../../lib/core/identity/registry.js>) | 本机注册表、锁内读改写和唯一性 |
| [ops.js](<../../../lib/core/identity/ops.js>) | 显式 bind/unbind/fork/import/迁移 |
| [project 命令](<../../../lib/core/commands/project.js>) | relocate 预留、日志提交后的元数据同步 |
| [project-reader.js](<../../../lib/core/project-reader.js>) | 锁外读取与 worker 所有权 |
| [project-list-reader.js](<../../../lib/core/project-list-reader.js>) | 异步项目列表、指纹缓存和冷读限流 |

日志的 project.workspacePath 是主根事实；meta 是可恢复缓存。
workspace-bindings.json 是本机派生注册，不进入项目事件历史。
BindingIndex 对无持久主绑定的项目派生稳定 legacy binding，仅存在内存。
可选项目 marker 只声明 projectId/schema，不携带路径、凭据或执行命令。
身份背景见[项目身份说明](<contract.md>)；当前对外语义仍由 L1 裁定。

## 3. 工作区发现数据流

1. 规范化 cwd，从最近目录向上查绑定和 marker。
2. 最近命中决定归属；遇到 .git 边界停止，嵌套仓库不穿透父项目。
3. 同目录多项目或 marker/绑定不一致，返回冲突，不静默择一。
4. 关联 worktree 自身未绑定时，用 Git common-dir 映射主 checkout 同相对位置。
5. 标记只有身份但没有绑定时，要求显式选择移动重绑、连接、副本 fork 或导入。
6. 普通发现未命中时，service 锁外扫描日志主根，兼容 relocate 后 meta 未同步。

worktree 映射返回同一项目，但不会修改共享 handle 的主工作区和 file 证据根。
子模块的 common-dir 与 git-dir 相同，不视作关联 worktree。
Git 不可用、超时或损坏时不做映射，不推断为独立项目授权。
仅 marker 且无本机数据是 board-data-missing，不是创建空项目的许可。

## 4. 身份建立与创建边界

新项目生成随机 projectId；已有 ID 不因路径移动而重算。
创建前重读磁盘 meta/注册表，核对当前目录自身的绑定、marker 与日志占用。
关联 worktree 的创建请求映射到主 checkout 的对应路径。

创建次序有意选择“先占目录，后写创世日志”：

1. 在注册表锁内追加主绑定，唯一根检查阻止并发创建。
2. 建立项目目录、meta、store 和 project/created commit。
3. 成功后登记并共享 handle，刷新绑定索引。
4. 失败时核对日志实际大小，只有确认为无创世字节才撤销本次未出生项目。
5. 已有字节或无法确认时保留数据与绑定，重试打开同一项目而不是再生 ID。

这不是跨注册表、meta 与日志的原子事务。
孤儿绑定会明确暴露缺失数据；比静默创建第二块看板更保守。
创建失败的底层清理由实现负责，本页不授予使用者删除真实项目权限。

## 5. 句柄装配与读取分层

open 首先复用 service 缓存，再复用进程内 SHARED_HANDLES。
共享按项目日志目录计数引用，避免插件重载留下两个独立 revision 计数器。
首次 open 调 store.open，构造 handle，再尝试 meta/主绑定自愈。
可写 handle 运行一次 recover；只读 handle 不执行 writer 恢复。

因此 open/openByWorkspace 不等于零写查询入口。
resolveWorkspace/peek 与专用 reader 不会隐式创建项目；open 也不应替代显式 create。
专用 reader 查 writer.store.state，或在 worker 中锁外验证前缀。
冷读只能展示持久任务状态，不能从 owner 推出 live lease。

service.close 先关闭项目列表 worker，再释放共享句柄引用。
只有最后持有者关闭 handle；其他 service 的共享引用继续有效。
原生知识读取器与 MCP reader 由 host 所有，须由各自生命周期关闭。

## 6. 移动、绑定失效与恢复

relocate 先重读归属，校验目标目录、冲突和 marker。
提交前在注册表预留目标为本项目 worktree，避免与并发 create/bind 争同一根。
日志提交后写 meta，再退役旧主绑定、建立新主绑定。

- 提交失败可留下同项目预留，但主工作区不变；它不是成功搬迁记录。
- 日志已提交后的 meta/绑定同步失败以 warning 呈现，不反向回滚 commit。
- 下一次 open 从日志尝试自愈缓存，日志仍是主根权威。
- 绑定只退役，不原地改指；引用旧 bindingId 的 locator 不自动跳到新根。
- 绑定不 active 或不属于本项目时，文档读取应报告 missing-binding。
- 固定历史不可观测的降级与错误边界见[evidence](<../evidence/contract.md>)。

显式 bind 连接本机目录，不把目录中的其他项目标记覆盖掉。
unbind 不允许退役有数据项目的主绑定；主根变化经 relocate。
fork 为带标记副本建立新身份并写新 marker，不改原历史。
import 核对已有日志前缀，保留 ID，不复制外机锁，也不覆盖分叉历史。

注册表损坏时，非 strict 读取退回 meta 派生绑定；身份写入拒绝。
陈旧注册表锁只报告，不自动删锁或猜测原进程已死。
迁移 dry-run 以 planHash 绑定注册表版本和计划动作，确认后仅持久化缺失主绑定。

## 7. I/O 成本与关键取舍

身份发现是同步目录上行检查；关联 worktree 有只读 Git 调用和短期内存缓存。
miss 时日志扫描可能同步验证多个项目，不是常量时间路径。
service.init/refreshFromDisk 可确保 projects 目录存在，不应作为零写探针。

普通 listProjects 为离线脚本保留同步兼容；HTTP 使用 listProjectsAsync。
异步列表热项目复用发布摘要，冷项目 worker 验证并按文件指纹缓存小摘要。
缓存命中不授予写权限，readOnly handle 也不冒充最新外部 writer。
worker 启动、序列化、完整链验证仍有成本，隔离不代表免费。

注册表写临界区有同步等待与原子旁文件写；频繁全盘刷新不放 prompt 渲染。
本机派生绑定可重建，项目事件不可因此重写或静默补造。
跨机恢复与迁移步骤见[运维恢复](<../../operations/RECOVERY.md>)，不在发现代码中自动执行。

## 8. 阅读顺序

1. [service](<../../../lib/core/service.js>)：resolveWorkspace/createProject/_openSync/_healMeta。
2. [discover](<../../../lib/core/identity/discover.js>)：walkUp/fromBinding/viaWorktree。
3. [BindingIndex](<../../../lib/core/identity/bindings.js>)与[registry](<../../../lib/core/identity/registry.js>)：隐式绑定与唯一性。
4. [project 命令](<../../../lib/core/commands/project.js>)：预留与日志后置同步。
5. [ops](<../../../lib/core/identity/ops.js>)：操作角色、导入前缀和迁移确认。
6. [reader](<../../../lib/core/project-reader.js>)与[列表 reader](<../../../lib/core/project-list-reader.js>)：读取所有权与关闭。

验证入口：[身份](<../../../test/core/identity.test.mjs>)、[冲突与并发](<../../../test/core/identity-conflicts.test.mjs>)、[host 身份](<../../../test/host/identity-host.test.mjs>)。

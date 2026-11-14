# 项目与身份模块内部契约

> 文档定位：L4 模块内部契约；L1 权威：[服务与句柄](<../../CONTRACT.md#服务与句柄>)、[身份错误](<../../CONTRACT.md#错误码>)、[冻结索引](<../../CONTRACT.md#3-冻结子契约索引1c>)。

本文约束 core 装配与身份调用；不扩展公共命令。设计见[模块设计](<design.md>)。

## 1. 导出入口

[service.js](<../../../lib/core/service.js>)导出 ProjectService，并兼容重导出 ProjectHandle。

| 入口 | 内部语义 |
|---|---|
| constructor / init | 建立内存容器；init 扫磁盘并加载绑定，不自动建立项目 |
| refreshFromDisk / reloadBindings | 重建 meta/本机绑定观测；strict 控制损坏是否直接抛出 |
| resolveWorkspace(path) | 返回项目/绑定/角色/发现来源或 null；冲突/未绑定 marker 抛错 |
| openByWorkspace / open | 解析或按 ID 复用/打开句柄，可 heal/recover |
| createProject | 显式建立项目；同根命中则打开已有身份 |
| command | open + handle.command 的便利入口 |
| peekProjectState / peekProject | lock-free 持久投影；无 meta 时 null，不 recover |
| lookupLiveWriter | 只查已存在可写句柄，不打开、不留新引用 |
| listProjects / listProjectsAsync | 同步兼容 / worker 冷读列表 |
| bindings / pathIndex | 内存索引 / 主根派生视图，不是授权凭据 |
| close | 关闭列表读取器并释放本 service 的共享句柄引用 |

[身份操作](<../../../lib/core/identity/ops.js>)导出 ID 生成、占用检查、绑定同步、bindWorktree/unbind/forkWorkspace/importProject/planMigration/migrate。
[discover](<../../../lib/core/identity/discover.js>)的 marker 与 worktree helper、[registry](<../../../lib/core/identity/registry.js>)的读改写函数是内部边界，不是任意 Agent 写入口。

## 2. 输入校验域

工作区路径经 resolveWorkspacePath/canonicalKey 规范化；不能用字符串前缀替代目录归属。
显式 bind/fork/relocate 目标须为存在目录，操作角色按 human/system 守卫。
createProject 的 ignoreMarker 仅 human/system 可用，不是通用冲突忽略参数。
ProjectService 构造注入的 clock/idgen/storeFactory 是内部装配，不接受 HTTP 自报实现。
privilegedInlineWrites 是构造期合成/离线入口能力，不从插件配置或环境开放。

marker 输入必须是普通文件、受限大小的 JSON 对象，且只含 schemaVersion/projectId。
marker schema 与 ID 形状在[discover](<../../../lib/core/identity/discover.js>)定义；路径、凭据、多余字段不被接受。
注册表要求已知 schema、合法绑定记录与整数 rev；缺失文件为空表，损坏不能当空表写回。
updateRegistry 在锁内重新读盘、clone、执行 mutate、检查唯一性，再递增 rev 写入。

专用 reader 的 project/task ID、分页、输出预算按[读内部契约](<../read/contract.md>)执行。
传入项目 ID 不构成授权，host 仍须在 writer 打开前做入口权限判断。

## 3. 身份与绑定不变量

1. 项目 ID 创建后稳定，路径变化不重算，已有历史不迁换为新身份。
2. 主 workspace 以日志为准，meta 与本机绑定是派生物。
3. 一个规范根至多一条 active 持久绑定，一个项目至多一条 active 持久 main。
4. 绑定退役后不原地重指向；BindingIndex 只索引 active 项。
5. 无持久主绑定时可派生 legacy main，不因读取把它写入注册表。
6. nearest binding/marker 决定归属；仓库边界阻止嵌套项目落到父项目。
7. worktree 映射不改变共享 handle 的主根和 file 证据根。
8. marker 不授予本机绑定、数据导入或项目写权限。
9. 读取 miss 是 null/明确错误，不调用 createProject 兜底。

目录已移动而 marker 仍在，要求显式选择；不能按名称相同自动合并。
绑定失效不让 locator 漂移到其他 worktree；具体读取错误见[L1](<../../CONTRACT.md#错误码>)。

## 4. 副作用与提交边界

| 路径 | 允许副作用 |
|---|---|
| resolveWorkspace | 文件/Git 观测、内存 Git 缓存；无项目/绑定写入 |
| init/refreshFromDisk | 可确保 projects 目录存在，加载内存索引 |
| peek / 专用 reader | lock=false 验证/回放，不修尾、不 recover、不续租 |
| open | store 打开/锁、meta/绑定 heal、可写首次 recover |
| createProject | 先注册主绑定，再创世日志；不是跨文件原子事务 |
| relocate | 先本机预留，再提交日志，最后 meta/主绑定同步 |
| bind/unbind/migrate | 本机注册表变更，不追加项目历史 |
| fork/import | 显式建立/接入身份及相应历史、marker/本机绑定操作 |

日志 committed 与 warning 的边界只在[L1 提交结果](<../../CONTRACT.md#21-命令信封错误码与-http-映射>)定义。
relocate 后置同步失败不能伪装日志未提交；下次 open 按日志自愈。
提交前预留失败或提交失败可留下同项目 worktree 预留，不表示主根已切换。

创建失败仅在日志不存在或大小确定为零时清理本次未出生目录并退役绑定。
已有字节或 stat 不确定必须保留，重试定位同一身份，不制造第二个项目。
注册表损坏保留原文件；陈旧锁不自动移除。

## 5. 并发与幂等

SHARED_HANDLES 按日志目录共享句柄并计数；不是按 session 复制 writer。
每个 service 释放自己的引用，最后引用才关闭 handle/store。
旧缓存中已关闭句柄不再返回；lookupLiveWriter 不保留额外引用。
同进程共享不代替 store 的跨进程合作锁。

create/bind/relocate 等占根操作先刷新磁盘归属，再在注册表锁内验证唯一性。
并发创建落败者可能见 identity-conflict 或暂时 board-data-missing，不能自行换 ID 重建。
同路径 create 打开已有项目，不代表所有创建中断都可无条件吞错重试。
relocate 的同规范路径请求无事件；命令幂等仍由 cmdId 总线负责。
迁移确认绑定 planHash 与 registryRev；无缺失动作时不写表。
import 续接先核对已有日志包含输入前缀，分叉历史拒绝覆盖。

## 6. 错误分类与恢复

完整错误码/HTTP 状态见[L1](<../../CONTRACT.md#错误码>)，此处只给处理分组：

- 发现冲突：停在歧义处，人工选择 relocate/bind/fork，不按“第一个命中”继续。
- 有身份无数据：显式 import；不得由读端创建空项目抹去缺失提示。
- 标记/注册表非法：保留原数据，严格写入口拒绝；非 strict 索引可降为隐式绑定。
- 注册表锁忙/陈旧：有限等待或报告；不自动删他人锁。
- 日志/版本拒读：沿用[store 契约](<../store/contract.md>)，不以 meta 覆盖日志。
- writer 只读/提交不明：先核对实际状态，不把读取水位当作继续追加许可。

## 7. 隐含契约与兼容类别

L1 与实现均以 open(projectId) 取得 handle 后调用 handle.query；调用方不得假设 service 另有查询便利方法。
open + query 不是零写读取保证；host 管理工具还可能 touch。
resolveWorkspace 使用当前内存索引并可能日志扫描，不是每次全盘重新加载注册表。
涉及占根的写操作必须走既有刷新与锁内更新，不能直接 mutate BindingIndex。
workspace binding 与 session binding 名字相近但授权域不同，不能互相替代。
同主根下不同 checkout 共享项目，不表示任意路径都可取证。

绑定注册表 schema、marker schema、项目运行时 schema 是独立版本域。
增加可选 DTO 字段与改变身份发现优先级属于不同兼容类别；后者可能改变归属。
事件兼容按[L1](<../../CONTRACT.md#事件兼容契约fail-closed>)，不能仅凭 registry 可重建就忽略日志兼容。
回退与导入需匹配一致性数据，不因模块文档授权真实 store 维护。
验证入口：[身份测试](<../../../test/core/identity.test.mjs>)、[竞争/冲突测试](<../../../test/core/identity-conflicts.test.mjs>)、[锁外 reader 测试](<../../../test/core/project-reader.test.mjs>)。

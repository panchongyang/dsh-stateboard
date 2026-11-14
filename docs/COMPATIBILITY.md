# 兼容与降级

本文是跨模块兼容入口；权威条款为 [CONTRACT §2.5](<CONTRACT.md#25-存储格式与事件兼容>)、[§2.4](<CONTRACT.md#24-文档>)与[§4](<CONTRACT.md#4-兼容与降级>)，运维操作另见[迁移](<MIGRATION.md>)和[恢复](<RECOVERY.md>)。

## 1. 版本域分开校验

| 版本域 | 现行值/判定 | 实现入口 |
|---|---|---|
| 项目状态 schema | v3；v2、缺版本或任务缺 requiresAudit 返回 schema-migration-required，升级是离线维护，不由运行时猜补 | [schema.js](<../lib/core/schema.js>) |
| commit / snapshot 信封 | v1；commit 版本和哈希链先于快照回放验证 | [store/format.js](<../lib/core/store/format.js>)、[store.js](<../lib/core/store.js>) |
| 外置文档端点 | schemaVersion=1；未知版本拒写，字段白名单在 open writer 前检查 | [docs.js](<../lib/host/routes/docs.js>) |
| fixed 结构 | v1；未知 fixed.v 拒绝，不回退其他解析分支 | [fixed-schema.js](<../lib/shared/fixed-schema.js>)、[fixed-reference.js](<../lib/core/documents/fixed-reference.js>) |

schema、事件分类、字段语义与传输版本是不同校验域；同为 v3 不保证每个构建都理解新增审查记录。具体准入见 [CONTRACT §4](<CONTRACT.md#4-兼容与降级>)，不以类型检查或能解析 JSON 代替兼容证明。

## 2. EVENT_REGISTRY 四分类

[events.js](<../lib/shared/events.js>) 的 EVENT_REGISTRY 是唯一分类表；[model.js](<../lib/core/model.js>) 与日志验证路径按同一分类拒绝未知语义。

| 分类 | 读方行为 |
|---|---|
| applied | 理解并应用事件投影。 |
| additive | 可 no-op；同一 commit 中的已知状态事件足以保持投影正确。 |
| migration | 无法推导语义，拒绝并要求显式迁移。 |
| refuse | 未登记或无效类型的默认结果，拒绝打开。 |

当前 additive 列表只有 task/meta-edited、task/assignment、session/checkpoint、session/handoff、lease/expired、lease/revoked；审计附加记录不因此成为任务权威状态。新增 additive 必须用同 commit 的完整状态和测试证明安全，不能凭“只是新增字段”分类，见[事件兼容契约](<CONTRACT.md#事件兼容契约fail-closed>)。

## 3. 快照覆盖与构建回退

冷开检查完整日志的版本、序号、哈希和事件，包括快照覆盖的部分；随后校验快照水位及文档/固定内容身份，再回放、检查 schema，最后只有 writer 可以规范化尾部。坏链、未知事件或不支持版本不能靠快照跳过，锁外读取也不修尾，见 [CONTRACT §2.5](<CONTRACT.md#25-存储格式与事件兼容>) 与 [store 模块](<modules/store.md>)。

出现 refuse/migration 事件时，较低能力构建只能回到切换前快照对应的一致性备份，不能只换代码目录；这里的回退不是把单个 snapshot 文件盖在新日志上，而是匹配构建和完整数据备份。即使事件全可读，审计门/I23 等字段语义仍可能不兼容，必须按同样的数据回退边界处理，见[事件兼容契约](<CONTRACT.md#事件兼容契约fail-closed>)、[发布](<RELEASE.md>)与[恢复](<RECOVERY.md>)。

salvage/fsck 是诊断或前缀观测，显式 repair 不是自动迁移；维护授权、停写、备份和数据损失确认见[运维 CLI](<operations/CLI.md#1-开发-cli>)。代码回退不回滚外部副作用。

## 4. 文档外置与 fixed/current-only

inline 正文以 blob/hash 记录，external 保存 locator 与元数据；metaRev 不代表正文版本。默认 inline 写策略与外置操作分开，不能用 put/link 改写 external；外置文档的管理状态、availability、confirmation、Git 观测互相独立，见[文档](<CONTRACT.md#24-文档>)与 [documents 模块](<modules/documents.md>)。

提交外置 doc 证据时服务端自动尝试固定；调用方只传 docId，不提交 fixed 或批准参数。已提交且干净、可安全还原时生成 pinned 身份，不能固定时返回 current-only/fixedReason，主流程继续而不伪装已固定。缺 Git、脏工作区和不支持转换属于可见降级，不要求使用者安装或批准，见[验收项与证据](<CONTRACT.md#验收项与证据>)及 [fixed-auto.js](<../lib/core/documents/fixed-auto.js>)。

新固定证据与匹配的 doc/content-fixed 必须同 commit；该事件为 applied，不能当 additive 略过。固定 Git 字节不写看板 blob；审计固定对象不追当前分支/metaRev。暂时不能观测 Git/绑定/对象给 warning，真实结构、来源身份、hash/OID/type 不符仍是 error，不以降级掩盖冲突。get_fixed 只读取，不创建证据，见[固定证据条款](<CONTRACT.md#验收项与证据>)与 [evidence 模块](<modules/evidence.md>)。

## 5. 能力缺失与显示边界

| 缺失/限制 | 现行降级边界 | 契约 |
|---|---|---|
| webServer 不可用 | 保留原生工具与提示词，不注册 Web 路由 | [Host 入口](<CONTRACT.md#261-入口>) |
| MCP 未启用、凭据/配置失败 | 只禁用该监听或写入口，网页和 DSH 工具继续运行 | [MCP](<CONTRACT.md#267-可选本机-mcp>) |
| FTS5、索引缓存不可用 | 有界扫描并标 coverage，失败不进入任务事务 | [知识读取](<CONTRACT.md#历史知识读取与检索>) |
| 历史来源不可读、范围超限 | 显式报告不可用/截断/覆盖，不以当前字节代替历史 | [知识读取](<CONTRACT.md#历史知识读取与检索>) |
| 文档/Git 内容漂移 | 维持内容审计错误边界；人工可显式刷新/豁免并保留记录 | [任务验收](<CONTRACT.md#12-任务状态机>) |

execution 和 auto/policy 等兼容数据仅按记录回放，不开启命令执行或新自动完成；agent 自述、人工验收与内容指纹的显示不能相互冒充，见 [CONTRACT §4](<CONTRACT.md#4-兼容与降级>) 和[信任边界](<TRUST-BOUNDARIES.md>)。

## 6. 已声明的适配差异

- 单位差异：[同步 docView](<../lib/core/views.js>)（views.js:317–325）的 maxBytes 实际按 JS 字符串 length/slice（UTF-16 代码单元）截断，[MCP 完整视图](<../lib/core/project-reader-views.js>)（project-reader-views.js:14–17）另按 UTF-8 字节安全截断；同名参数不代表同一单位。
- 空值差异：[planView](<../lib/core/views.js>)（views.js:186–227）对未知计划返回 plan:null，[MCP 适配](<../lib/core/project-reader-views.js>)（project-reader-views.js:50–53）对显式未知 planId 返回 not-found；未指定 ID 的 focus 空值不因此变为错误。
- 过滤差异：[docsView](<../lib/core/views.js>)（views.js:307–314）不消费 query，[MCP 适配](<../lib/core/project-reader-views.js>)（project-reader-views.js:55–60）按标题做大小写不敏感过滤；这些是已声明的适配差异，不重定义 L1 或推导额外权限。

# 共享契约模块内部契约

> 文档定位：L4 契约型模块；L1 权威：[领域模型](<../../CONTRACT.md#1-领域模型1a>)、[错误码](<../../CONTRACT.md#错误码>)、[事件兼容](<../../CONTRACT.md#事件兼容契约fail-closed>)、[兼容与降级](<../../CONTRACT.md#4-兼容与降级>)。

本文列共享定义的拥有边界与内部使用约束；全局位置见[L2 入口](<../shared.md>)。
shared 没有独立运行生命周期，设计取舍并入本篇，不另立业务服务或状态机。

## 1. 零依赖边界与取舍

当前五个 JS 文件均无运行时 import，不依赖 node、React、DSH、core、host 或 client。
定义应能由各运行环境静态消费，不能借共享校验引入文件读取、网络、时钟或身份发现。
不把跨层重复代码一概搬来：只有跨消费者共享的契约形状、词汇与无环境分类才属于此层。

- core 负责领域守卫、错误实例和持久状态，不能把授权决策藏到 shared。
- host 负责身份与传输 schema 适配，不能让 shared import 注册器或服务。
- client 可以消费共享定义，但不能要求 shared 提供 React 组件或页面状态。
- 测试可以注入注册表证明分类，不能通过运行时改全局表来获得新业务能力。

常量单源减少双端词汇漂移，但常量不是完整验证器。
例如 fixed 的字段 schema 不等于对象身份验证，命令名清单也不等于已注册工具。
新增能力仍须从 L1、core 和双端实际调用链一起验收。

## 2. 实际导出类别

不在此复制值全集；拼写和取值以源文件为唯一清单。

| 文件 | 实际导出类别 | 使用边界 |
|---|---|---|
| [contract.js](<../../../lib/shared/contract.js>) | TASK_STATES、ACTIVE_STATES、TERMINAL_STATES；COMMAND_OPS 与派生 TASK_OPS；EVIDENCE_KINDS、DOC_KINDS | 领域枚举及命令词汇；不是状态跃迁实现 |
| 同上 | DOC_EXTERNAL_WRITE_FIELDS、DOC_EXTERNAL_HTTP_ENVELOPE | 外置写白名单与 HTTP 信封字段，host 在 writer 打开前使用 |
| 同上 | TOOL_NAMES、API_PATHS、MCP_READ_TOOLS、MCP_WRITE_TOOLS | 工具名称与路由模板；不是注册器或完整端点目录 |
| 同上 | PROJECT_READ_PAGE_DEFAULT/MAX、PROJECT_READ_ID_PATTERNS | 专用读取页界和 ID 形状；不是项目权限 |
| 同上 | PROJECT_WORK_TRIGGER、PLAN_STAGE_WORK_GUIDANCE | 共用使用/阶段提示文字；不改变操作资格 |
| [events.js](<../../../lib/shared/events.js>) | EVENT_REGISTRY、EVENT_CLASSES、eventClass | 事件名到兼容类别及默认拒绝分类 |
| [knowledge.js](<../../../lib/shared/knowledge.js>) | KNOWLEDGE_VERSION、TOOLS、KINDS、LIMITS、INPUTS、DESCRIPTIONS（后五项均带 KNOWLEDGE_ 前缀） | 知识引用版本、业务 schema/描述与预算；身份字段由 host 追加 |
| [fixed-schema.js](<../../../lib/shared/fixed-schema.js>) | FIXED_REFERENCE_SCHEMA | 显式 Git 字节身份的字段形状；严格语义验证另在 core |
| [verification.js](<../../../lib/shared/verification.js>) | isOrdinaryAgentAcceptance(record) | agent + pass + gate 严格 false 的显示分类，非独立性或真实性证明 |

shared 不导出错误码枚举、BoardError 或项目 schemaVersion 常量。
错误 code/status 只由[L1 错误表](<../../CONTRACT.md#错误码>)定义，错误类型在[core/errors.js](<../../../lib/core/errors.js>)。
项目 schema 准入实现位于[core/schema.js](<../../../lib/core/schema.js>)，不能按文件名推断由 shared 拥有。

## 3. 谁消费，禁止谁反向依赖

| 消费者 | 现有用途 |
|---|---|
| [core/model](<../../../lib/core/model.js>)、[store/format](<../../../lib/core/store/format.js>) | 状态枚举、事件兼容分类和回放准入 |
| [project reader](<../../../lib/core/project-reader.js>)、[读取投影](<../../../lib/core/project-reader-projection.js>) | ID、状态、页界与证据种类 |
| [knowledge 请求](<../../../lib/core/knowledge/request.js>)、[引用](<../../../lib/core/knowledge/reference.js>) | 同一业务预算、输入验证域与引用版本 |
| [原生 task/doc registrar](<../../../lib/host/tools/task.js>)、[docs HTTP](<../../../lib/host/routes/docs.js>) | 枚举、schema 与外置字段白名单 |
| [MCP 概览](<../../../lib/host/mcp-tools.js>)、[写入适配](<../../../lib/host/mcp-write.js>)、[知识适配](<../../../lib/host/mcp-knowledge.js>) | 工具词汇、字段域与共享业务 schema |
| [digest](<../../../lib/core/digest.js>)、[client labels](<../../../src/client/model/labels.ts>) | 共用验收显示分类；digest 另消费使用提示文字 |

这是代表入口，不是全部 import 清单；新增消费者仍须通过架构审计。
client 当前直接 import 的共享实现只有 verification.js，没有直接 import contract.js/events.js。
共享定义与实际使用分开核对；依赖事实以源码 import 和构建输入为准。
[包清单](<../../../package.json>)没有声明 shared 子路径 exports；仓库内部导出不等于新增 npm 公共入口。

## 4. 冻结、可扩展与内部

这里的“冻结”首先指语义兼容，不等同 JavaScript Object.freeze。
部分数组/对象可变，调用方仍须只读使用；顶层 freeze 也不保证嵌套 schema 深冻结。

| 类别 | 约束 |
|---|---|
| 已定义词汇与字段 | 已有枚举、命令/工具名、路由模板与校验语义不可静默改名、移除或重解释 |
| D1 / fixed v1 | [冻结索引](<../../CONTRACT.md#3-冻结子契约索引1c>)指定的身份、内容域和结构；变化须显式裁定，不借共享重构放宽 |
| 可扩展清单 | 新命令/枚举/工具/事件必须先定义 L1 语义，再补实际实现、消费与回归；不是任意字符串自动获准 |
| 内部结构与辅助 | 派生 TASK_OPS、白名单构造 helper、schema 组合与显示分类实现可重构，但保持调用语义；内部 helper 不因此成为 package API |
| 提示与预算 | 共享文字、schema 及限额服务于入口行为；改动须核对模型可见描述、核心验证与输出/取消边界 |

新增错误码不通过“加 shared 枚举”完成：修改 L1 定义及实际 BoardError/适配/展示测试。
未知错误必须保留安全 code/message，不因客户端词典缺项吞为成功；MCP 的脱敏仍由 host 承担。
新增领域枚举也不能仅扩数组：检查归一化、状态机、投影、UI 未知值与双端 schema。

## 5. 事件分类与未知值

EVENT_REGISTRY 是唯一事件兼容表，分类含义只在[L1](<../../CONTRACT.md#事件兼容契约fail-closed>)定义。
eventClass(type, registry=EVENT_REGISTRY) 接受类型与可注入表，返回兼容类别字符串。
非字符串、空字符串、未登记类型、非法分类或显式 refuse 都返回 refuse。
它只分类，不应用事件、不抛 BoardError、不修复日志，也不检查事件 payload 完整性。

当前 registry 只登记 applied/additive，migration/refuse 仍是有效的拒读分类域。
新增 additive 必须证明同 commit 的已知事件足以保持投影正确，并有测试，不能按名称猜兼容。
未知事件由 store/model 拒读，包括快照覆盖日志段，不能以 UI 能显示原名为由继续回放。
UI 未知标签透传是展示策略，不等于领域输入或存储接受未知枚举。
外置未知 schemaVersion 拒写；未知 fixed.v 拒绝且不回退弱解析，具体守卫在各模块。

## 6. 版本与兼容域

[包版本](<../../../package.json>)是发布标识，不是项目状态版本或事件能力位。
项目 schemaVersion、commit/snapshot.v、外置端点 schemaVersion、fixed.v 与 KNOWLEDGE_VERSION 各有独立校验域。
这些值碰巧相同不代表可互换；不能把更新包版本视为自动迁移授权。

项目运行时准入由[core/schema](<../../../lib/core/schema.js>)执行；外置 schemaVersion=1 由[HTTP 写准入](<../../../lib/host/routes/docs.js>)等适配执行。
固定结构与知识引用的版本分别归其解析器，不因同包可加载就放行未知结构。
同 schema 能读旧事件也不证明审计字段语义可安全回退，见[兼容矩阵](<../../COMPATIBILITY.md>)。
新增值造成旧读方拒绝时，应配匹配构建与一致性数据回退方案，不只换代码。

## 7. 副作用、隐含契约与验证

共享模块导入只建立定义；分类函数不读写文件、不发网络、不触及租约或 writer。
调用方不得 mutate 常量/嵌套 schema；需要追加身份字段时构造适配副本，不污染其他入口。
知识原生 PTC 的范围描述转换不能改变共用字段/必填/枚举，core 仍执行相同约束。
共享清单存在不证明入口已注册；验证实际两端 tools/list、schema 与调用链。

- [契约 parity](<../../../test/contract/contract-parity.test.mjs>)与[bundle 契约](<../../../test/client/bundle-contract.test.mjs>)：命令/工具/客户端 surface。
- [事件兼容](<../../../test/storage/event-compat.test.mjs>)：未知事件与 additive 边界。
- [知识双端](<../../../test/host/mcp-knowledge.test.mjs>)：共享 schema、描述与身份适配。
- [固定引用边界](<../../../test/docs/doc-fixed-edges.test.mjs>)：字段 schema 不替代严格验证。
- npm run audit:check 检查层向与依赖；npm run check:architecture 检查架构清单，均不赋予业务权限。

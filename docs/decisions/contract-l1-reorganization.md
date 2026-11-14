# L1 契约重排核对记录

> 状态：交付核对档案；不替代现行契约，不授予提交、发布或部署权限。

范围：只改文档，保持 [CONTRACT](<../CONTRACT.md>) 随包路径；未改业务代码，未 commit/push。D1 冻结原文保持不变。

delegation: no — 单人有界重排；不追加下级委派。

## 1. 旧章节 → 新位置

| 旧章节 | 新位置 | 处理 |
|---|---|---|
| 标题/导言 | [CONTRACT 导言](<../CONTRACT.md>) | 现行 L1，明确随包发布；去掉 MVP/整篇冻结声明 |
| §0 MVP 范围、§6 M0–M4 验收 | [MVP 档案](<mvp-scope.md>) | 全部历史范围/非目标/验收条件归档，章节号保留为历史引文 |
| §1 目录结构 | [ARCHITECTURE §2](<../ARCHITECTURE.md#2-模块清单>)、[CLI §3](<../operations/CLI.md#3-开发与编码约束>) | 移除重复目录树；宿主 junction 与根目录不 npm install 移到 CLI。唯一额外 bin/wt 描述与磁盘/包元数据不符，保留在[旧口径档案](<contract-legacy-surfaces.md>)，不加入现行地图；其余模块事实地图已有 |
| §2.1 Service/Handle | [CONTRACT §2.3](<../CONTRACT.md#23-query-与视图>) | 保留 API、摘要字段与兼容 re-export |
| §2.2 命令信封、§2.3 错误 | [CONTRACT §2.1](<../CONTRACT.md#21-命令信封错误码与-http-映射>) | 保留提交定义、错误码/状态、I/O 不确定性及 HTTP 映射 |
| §2.4 命令、Intent/Archived、Plan v2 | [CONTRACT §2.2](<../CONTRACT.md#22-命令清单>) | 保留全部原 op，补齐已实现的 migrate/inline_policy；steps 移 §1.3，evidence 移 §2.4 |
| §2.5 Query/Health | [CONTRACT §2.3](<../CONTRACT.md#23-query-与视图>) | 保留 DTO、排序、allowedOps、stageWork、只读诊断；补 brief 与完整 health 的边界 |
| §2.6 Plan/Task 规则 | [CONTRACT §1.2](<../CONTRACT.md#12-任务状态机>)、[§1.3](<../CONTRACT.md#13-计划模型>)、[§1.4](<../CONTRACT.md#14-不变量>) | 收拢状态机、计划 head/版本、不变量 I1–I23；不采用设计提案中的旧 head 词汇 |
| §2.7 进度 | [CONTRACT §1.5](<../CONTRACT.md#15-进度与派生量>) | 保留返回字段，按实现明确项目加权/计划计数公式、0分母与 canceled 口径 |
| §2.8 文档 | [CONTRACT §2.4](<../CONTRACT.md#24-文档>) | 保留 blob/事件字段、固定证据、图片路由与安全边界；补外置读取基本语义以保证随包自包含 |
| §2.9 存储/事件 | [CONTRACT §2.5](<../CONTRACT.md#25-存储格式与事件兼容>)、[§4](<../CONTRACT.md#4-兼容与降级>)、[CLI §4](<../operations/CLI.md#4-schema-升级与故障验证>) | 存储格式/兼容分类不丢；执行密钥兼容移 §4；schema 迁移步骤与故障注入语义移 CLI |
| §2.10 Digest | [CONTRACT §2.7](<../CONTRACT.md#27-历史知识送达与摘要规则>) | 保留文本结构、includeRules 与确定性口径 |
| §3 Host 全节 | [CONTRACT §2.6](<../CONTRACT.md#26-host-表面>) | 保留7工具、全部 HTTP 路由、MCP、身份与 prompt/去重规则 |
| §4 Client | [CONTRACT §2.6](<../CONTRACT.md#26-host-表面>)、[CLI §2–§3](<../operations/CLI.md>)、[旧口径档案](<contract-legacy-surfaces.md>) | 可观察 slot/鉴权/渲染/冲突语义保留；测试机制进 CLI；旧模块路径/测试键数/样式沿革进档案 |
| §5 CLI/测试/编码约束 | [CLI](<../operations/CLI.md>)、[旧口径档案](<contract-legacy-surfaces.md>) | 15条最低测试语义全部保留；现行脚本组合/TS范围核对实现；已不存在的 wt 工具及过时数量原文归档 |
| §7 子代理边界 | [AUTONOMOUS-DELIVERY §9](<../AUTONOMOUS-DELIVERY.md#9-子代理交付边界>) | 原有各代理写入范围、构建产物限制和契约先行语义保留 |
| §8 历史读模型 | [CONTRACT §2.7](<../CONTRACT.md#27-历史知识送达与摘要规则>)、[旧口径档案](<contract-legacy-surfaces.md>) | 现行知识参数/预算/覆盖/摘要保留；未交付 asOf/fromSeq 提案及 asof-out-of-range/bad-seq 原文归档 |
| DESIGN §3.4 不变量 | [CONTRACT §1.4](<../CONTRACT.md#14-不变量>) | 把设计约束转为现行口径；不引入依赖 waiver、全量计划禁写或虚构原子文件快照 |
| 冻结原文与 schema | [CONTRACT §3](<../CONTRACT.md#3-冻结子契约索引1c>) | 只索引 D1、fixed schema、EVENT_REGISTRY，不改写冻结原文 |

## 2. 抽查的10条事实

| # | 抽查事实 | 新位置 |
|---|---|---|
| 1 | committed:true 必须 append+fsync；log-write-uncertain 降只读且不能声称确定未提交 | [§2.1](<../CONTRACT.md#21-命令信封错误码与-http-映射>) |
| 2 | unknown 不能关闭 open intent；治理结算 sideEffects 必填，可空，最多50条/16KiB | [§2.2](<../CONTRACT.md#22-命令清单>) |
| 3 | unblock 三出口：可恢复 assignee 授租回 in_progress，resumeTo=review 回 review，其余 ready；不重建 intent | [§1.2](<../CONTRACT.md#12-任务状态机>) |
| 4 | 普通 agent 可自验；审计门须独立 agent+20–4000字报告；human 不要求报告 | [§1.2](<../CONTRACT.md#12-任务状态机>) |
| 5 | plan head draft/active/archived；active revise/adopt/release version+1；focus human-only 且不校验 projectRev | [§1.3](<../CONTRACT.md#13-计划模型>)、[§2.2](<../CONTRACT.md#22-命令清单>) |
| 6 | GET 图片 assets 只读、正文已引用路径、binding 根内、6种扩展名、4MiB、no-store；非白名单415 | [§2.4](<../CONTRACT.md#24-文档>)、[§2.6](<../CONTRACT.md#26-host-表面>) |
| 7 | commit 字段 v/seq/prev/hash/at/actor/cmdId/baseRev/events 与 snapshot v/seq/hash/state 均保留 | [§2.5](<../CONTRACT.md#25-存储格式与事件兼容>) |
| 8 | EVENT_REGISTRY 四分类与6个 additive 类型保留；未知/需迁移拒读，快照覆盖段不能绕过 | [§2.5](<../CONTRACT.md#25-存储格式与事件兼容>) |
| 9 | 外置 doc 自动 fixed/current-only；调用方不可自报 fixed；doc/content-fixed 同 commit 屏障 | [§2.4](<../CONTRACT.md#24-文档>) |
| 10 | 知识 read 默认/最大24KiB、8引用、256KiB总响应；单worker、30秒、有界coverage不伪报完整 | [§2.7](<../CONTRACT.md#27-历史知识送达与摘要规则>) |

## 3. 验证与现行事实纠偏

- `git diff --check`：通过（初次发现的行尾空白/文末空行已修复并复跑）。
- 相对链接：五个改写/新增目的地26个链接路径及所带标题片段均解析成功；全仓指向 CONTRACT 的现有片段以7个兼容锚点继续解析，D1 原文不必改写。含本文在内六个交付文档合计68个相对链接（含片段）复查通过，缺失0。
- 全量基线清单抽取：原命令/错误码/HTTP 路由116条表格行逐项在新 L1 命中，缺失0；额外补齐 migrate/inline_policy 与 get_fixed 工具枚举。历史提案错误码仅在明确档案中，不冒充现行 API。
- `npm run check:release`：通过，189 package entries/189 files，8项技术检查；legacyMatches=0，README relativeMissing=0。未发布、未安装真实 profile。
- D1 冻结文 `git diff --quiet -- docs/WORKSPACE-DOCUMENTS-CONTRACT.md`：通过。
- 新旧行数（按物理行）：CONTRACT 1112→998（需求中的1110与实际基线相差2行）；AUTONOMOUS-DELIVERY 255→269；新增 CLI 91、MVP档案41、旧口径档案114行。
- 现行纠偏：冷开必须先日志/快照身份校验与回放、schema 检查，再 writer 修尾；unblock 三种出口按实现补全；focus 不校验 projectRev；项目进度加权与计划计数分开；浏览器 bundle identity 为 dsh-stateboard；npm test/CI组合、客户端全量TS/TSX按当前脚本写，不保留旧承诺。

## 4. 未解决项与边界

- 本范围内无未解决的链接/事实迁移问题；未执行业务完整测试，因为无代码改动，发布纯净度已运行。
- ARCHITECTURE/状态图的同步修正由主代理另行负责；本文作者未编辑这些文件。
- 仅保留旧片段兼容锚点，不改写冻结/历史文档引用；仓库中纯文字旧章节号的系统性更新属于后续 L2/旧文裁定，不能把历史引文改成现行声明。
- D1 冻结的显式固定确认文字与现行自动跟随/降级采用既有复议口径，冻结原文未改；L1 索引明确当前适用的实现语义。

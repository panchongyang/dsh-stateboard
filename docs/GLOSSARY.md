# 术语表

本表提供跨模块读词入口，每项一句话；字段、状态与权限以链接的 [L1 契约](<CONTRACT.md>) 为准。

| 术语 | 一句话含义与契约入口 |
|---|---|
| Project（项目） | 持久状态机边界，聚合任务、计划、文档与策略，并由本机绑定关联工作区，见[领域词汇](<CONTRACT.md#11-词汇表>)。 |
| Task（任务） | 唯一工作单元，携带状态、修订号、验收项、证据与依赖，见[任务状态机](<CONTRACT.md#12-任务状态机>)。 |
| Plan（计划） | initiative 级容器，由可写 head 与不可变版本组成，见[计划模型](<CONTRACT.md#13-计划模型>)。 |
| Step / Stage（阶段） | 计划内有序推进和集中审查的任务分组，没有独立状态机，见[计划模型](<CONTRACT.md#13-计划模型>)。 |
| stageWork | 按当前计划版本推导的阶段工作提示，不改变操作资格，见[查询](<CONTRACT.md#查询>)。 |
| Head（管理头） | 计划当前可写管理面，保存标题、状态与 currentVersion，见[计划模型](<CONTRACT.md#13-计划模型>)。 |
| Version（计划版本） | 已发布计划的不可变快照，成员变化通过新版本表达，见[计划命令](<CONTRACT.md#223-plan-v2-命令>)。 |
| focusPlanId（焦点） | 人类的活动计划关注偏好，不限制项目只有一个计划，见[计划模型](<CONTRACT.md#13-计划模型>)。 |
| Orphaned（游离任务） | 从计划版本移出的保留任务，不表示任务被删除，见[计划命令](<CONTRACT.md#223-plan-v2-命令>)。 |
| Lease（租约） | 带期限、宽限和 fencing token 的单任务运行时执行权，见[任务状态机](<CONTRACT.md#12-任务状态机>)。 |
| Fencing token（栅栏令牌） | 领取时递增、写入时与当前租约匹配的代际令牌，见[任务状态机](<CONTRACT.md#12-任务状态机>)。 |
| Owner（持久归属） | 任务记录中的会话与令牌信息，不等同于有效运行时租约，见[只读诊断](<CONTRACT.md#health--fsck-只读诊断>)。 |
| SessionBinding（会话绑定） | 受信入口建立的 sessionId/agentId、epoch 与活性记录，见[领域词汇](<CONTRACT.md#11-词汇表>)。 |
| WorkIntent（执行意图） | 副作用前记录的执行 WAL，未结意图须停止结算或中断对账，见[Intent 结算](<CONTRACT.md#221-intent-结算rfc-3>)。 |
| Attempt（执行尝试） | begin 开启的材料轮次，会退休此前尝试的证据，见[验收项与证据](<CONTRACT.md#验收项与证据>)。 |
| Acceptance（验收项） | 任务的显式验收条目及可选材料种类要求，见[任务状态机](<CONTRACT.md#12-任务状态机>)。 |
| Evidence（证据） | 提交者材料和服务端内容观测，不是命令执行或交付正确性的担保，见[验收项与证据](<CONTRACT.md#验收项与证据>)。 |
| Active evidence（活动证据） | 尚未 supersede、用于当前材料覆盖与审计的证据行，见[验收项与证据](<CONTRACT.md#验收项与证据>)。 |
| Verify（验收） | 获授权主体对 review 任务记录接受，不是系统证明交付正确，见[任务状态机](<CONTRACT.md#12-任务状态机>)。 |
| Audit gate（审计门） | 要求 agent 验收者具备会话级独立性并提供自述报告的任务标记，见[任务状态机](<CONTRACT.md#12-任务状态机>)。 |
| scopeDigest（验收范围指纹） | 绑定任务实质范围、材料和 worker 集合的验收锚点，见[任务状态机](<CONTRACT.md#12-任务状态机>)。 |
| Doc（文档） | 由稳定 docId 标识的 inline 档案或 external 登记，见[文档](<CONTRACT.md#24-文档>)。 |
| Binding（工作区绑定） | 本机目录到项目的定位关系，也是外置文档 locator 的根来源，见[文档](<CONTRACT.md#24-文档>)与[生命周期](<CONTRACT.md#262-生命周期>)。 |
| Locator（定位符） | 外置文档的 bindingId 与 relPath 组合，不是正文内容身份，见[文档](<CONTRACT.md#24-文档>)。 |
| metaRev（元数据修订） | 外置登记的修订计数，与 rev 同值但不代表正文版本，见[文档](<CONTRACT.md#24-文档>)。 |
| Confirmation（确认基线） | 对完整重读的正文 hash 建立的基线，与管理状态和可用性独立，见[文档](<CONTRACT.md#24-文档>)。 |
| Fixed / pinned（固定内容） | 绑定项目来源、Git commit/path/blob 与字节 hash 的历史内容身份，见[验收项与证据](<CONTRACT.md#验收项与证据>)。 |
| current-only（当前文件） | 固定条件不满足时仅记录当前文件观测并附降级原因的证据档，见[兼容与降级](<CONTRACT.md#4-兼容与降级>)。 |
| Commit（日志提交） | 带 seq、prev/hash、actor、cmdId 和事件批次的 JSONL 记录，见[存储格式](<CONTRACT.md#25-存储格式与事件兼容>)。 |
| cmdId（命令身份） | 用于已提交命令去重的稳定 ID，见[命令信封](<CONTRACT.md#21-命令信封错误码与-http-映射>)。 |
| Rev / projectRev（修订/项目水位） | 实体变更计数与项目提交序号，用于并发比较而非内容正确性判断，见[命令信封](<CONTRACT.md#21-命令信封错误码与-http-映射>)。 |
| Snapshot（存储快照） | 带 seq/hash 的状态加速文件，不替代完整日志校验，见[存储格式](<CONTRACT.md#25-存储格式与事件兼容>)。 |
| Blob（内容寻址字节） | 以 sha256 定位的 inline 正文存储，不收纳固定 Git 正文，见[文档](<CONTRACT.md#24-文档>)。 |
| Digest（项目简报） | 同 state/sessionId/includeRules 输入产生同文的有界纯文本摘要，见[Digest](<CONTRACT.md#digest>)。 |
| Health / fsck（健康诊断） | 只读状态和内容诊断，不执行材料、不修复数据，见[只读诊断](<CONTRACT.md#health--fsck-只读诊断>)。 |
| Coverage（知识覆盖） | 声明已验证/索引水位、材料可用性与截断范围的读取信息，见[知识读取与检索](<CONTRACT.md#历史知识读取与检索>)。 |
| Source ref（知识来源引用） | 携带项目、提交和内容身份的稳定回读定位，不以缓存行号充当身份，见[知识读取与检索](<CONTRACT.md#历史知识读取与检索>)。 |

结构落点见[十二模块地图](<ARCHITECTURE.md#22-模块路由>)；字段兼容不等于权限或可信度提升，见[兼容与降级](<COMPATIBILITY.md>)。

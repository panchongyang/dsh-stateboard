# 证据模块内部契约

> 文档定位：L4；对外准入、错误与验收权威见 [L1 验收项与证据](<../../CONTRACT.md#验收项与证据>)。取舍见[模块设计](<design.md>)。

## 1. 归一化与替换

[normalizeEvidence](<../../../lib/core/evidence.js>) 由服务端确定证据材料与字节身份，不采纳调用方的固定字段。`file` 按本次开库的实际工作区物理根做包含、普通文件与哈希检查；普通文件引用不是外置文档 locator，不应共享更宽松的路径策略。内嵌正文按 `docId@rev` 和 blob 身份回读；迁移映射保留原哈希域。外置 `@rev` 只是元数据后缀。

同一 active identity 的证据只退休提交前的旧行，不让同批新行相互替换。替换不得使验收覆盖缺失。成功的覆盖检查不证明材料正文可读或结论正确；命令组装仍需对完整 active 集合做内容审计。

## 2. 字节、版本与降级

- [留存命令端口](<../../../lib/core/adapters/retained-documents.js>) 从已登记且获准的 locator 新鲜读取原始字节。所属工作区可发布内容寻址正文；默认集中布局没有这条对象存储路径。
- `workspaceVersion` 绑定日志中的正文版本和对象地址。审计按原定位和当前授权核验该对象，不读取当前文件作为替代。未留存但原始 hash 已可靠取得时可返回 `current-only` 及原因；[auditCurrentOnlyDoc](<../../../lib/core/documents/fixed-auto.js>) 复查当前字节，不冒充快照。
- 原始 hash 不可得不算成功。对象缺失、损坏、权限拒绝和内容漂移分别表达。人工刷新与豁免走 [L1 任务状态机](<../../CONTRACT.md#12-任务状态机>)。

## 3. 历史 Git 记录

[fixed schema v1](<../../../lib/shared/fixed-schema.js>) 与[固定索引](<../../../lib/core/documents/fixed-reference.js>) 继续核对结构、项目、内容标识及同提交屏障；旧记录不重写。Git 对象标识与记录的 blob 内容 SHA-256 是不同的域。

[get_fixed](<../../../lib/core/documents/fixed-content.js>) 只返回精确匹配的已记录来源；`fixed` 与完整 `commitOid/pathAtCommit` 互斥。不接受 HEAD、分支名或缩写，不根据 `bindingId` 授予读权。返回 `legacy-git-record-only`，无正文、未经重新核验；审计时这是非阻断警告，不是内容通过。结构或记录身份错误仍拒绝。

<a id="4-副作用与同-commit-固定屏障"></a>

## 4. 命令与提交边界

[命令取证](<../../../lib/core/commands/task-evidence.js>) 产生值操作，不直接写事件。正文对象先发布或核验，正文版本与任务证据同一日志提交；未提交的对象不是公开版本。写入失败、容量受限和无权限不覆盖先前对象，见[文档内部契约](<../documents/contract.md>)。

含旧固定引用的日志仍验证匹配 `doc/content-fixed`，已有同 ID 同内容证据行保留时不要求重复屏障。兼容读取不生成该事件、证据、确认基线或新来源。产品不读取 Git 对象或调用 Git；[发布门禁](<../../../scripts/check-release-purity.mjs>) 拒绝运行时代码的子进程/开发 Git 适配器调用依赖。

<a id="8-兼容类别"></a>

## 5. 兼容与验证

外置协议、固定引用结构、版本对象与项目事件是不同校验域。冻结域现行适用范围见 [L1 冻结索引](<../../CONTRACT.md#3-冻结子契约索引1c>)。兼容读端能查看记录来源，不恢复原 Git 写入或正文；低能力构建的回退需匹配完整备份。

验证入口：[内容审计](<../../../test/docs/evidence-audit.test.mjs>)、[历史固定兼容](<../../../test/docs/doc-fixed-evidence.test.mjs>)、[只读表面](<../../../test/docs/doc-fixed-surfaces.test.mjs>)、[留存对象](<../../../test/storage/p2-objects.test.mjs>)。

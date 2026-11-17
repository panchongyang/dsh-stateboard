# 历史知识读取模块内部契约

> 文档定位：L4；对外输入、错误与限额只定义于 [L1](<../../CONTRACT.md#历史知识读取与检索>)；取舍见[设计](<design.md>)。

## 1. 调用与副作用

[reader](<../../../lib/core/knowledge/reader.js>) 在已授权项目上执行 search/read；[shared schema](<../../../lib/shared/knowledge.js>) 统一 DSH/MCP 参数、来源枚举与预算。只读路径不要求 claim/begin/verify，不打开 writer、不续租；派生 SQLite/cache 写入与权威日志、快照和证据事务隔离。

## 2. 引用与读取域

[reference](<../../../lib/core/knowledge/reference.js>) 核验项目、来源与位置，不能拿另一个项目的引用或数据库行号读取。原文使用现有公开投影：剔除内部租约、执行凭据、本机绑定根和绝对文件引用；省略字段、截断或分页必须明示。外置正文与 Git 对象继续服从 documents/evidence 的安全边界和授权，不因曾命中索引而获得额外读取权。

## 3. 覆盖、关联与并发

搜索结果中的直接命中、已有关系发现和调用者 discovery 线索分别标识；零命中不证明不存在，coverage 不证明正确性。一次原文展开至多自动附带一跳已有关系，模型可自行提出新查询，不把动态联想写成正式关系，不设置累计思考轮次门禁。

[快照采样](<../../../lib/core/knowledge/snapshot.js>) 与返回前复核绑定同一已发布前缀；内容 hash/metaRev/fixed 身份变化不能继续宣称匹配。取消、超时、预算耗尽与来源不可用显式返回或失败，不伪造空原文或完整覆盖。

## 4. 兼容与验证

索引是派生数据，可损坏后重建，但不得改变持久引用身份、领域事件或验收准入。SQLite/FTS5 缺失降为有界关键词扫描，不能把扫描排序标成 BM25。实现/安全/故障矩阵与测试入口见[验证记录](<../../decisions/history-knowledge-validation-2026-11-14.md>)，不是线上授权或真实性证明。

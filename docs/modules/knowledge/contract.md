# 历史知识读取模块内部契约

> 文档定位：L4；对外输入、错误与限额只定义于 [L1](<../../CONTRACT.md#历史知识读取与检索>)；取舍见[设计](<design.md>)。

## 1. 调用与副作用

[reader](<../../../lib/core/knowledge/reader.js>) 在已授权项目上执行 search/read；[shared schema](<../../../lib/shared/knowledge.js>) 统一 DSH/MCP 参数、来源枚举与预算。只读路径不要求 claim/begin/verify，不打开 writer、不续租；派生 SQLite/cache 写入与权威日志、快照和证据事务隔离。

## 2. 引用与读取域

[reference](<../../../lib/core/knowledge/reference.js>) 验证日志来源（kb1）或工作区/留存来源（kb2）的身份；引用本身不是授权。正文与精确关系每次复核工作区授权、来源身份和版本。旧 Git 来源只交付记录，缺字节不回退当前内容。原文公开投影剔除内部租约、凭据、物理根和绝对文件引用。

## 3. 覆盖、关联与并发

搜索结果中的直接命中、已有关系发现和调用者 discovery 线索分别标识；零命中不证明不存在，coverage 不证明正确性。一次原文展开至多自动附带一跳已有关系，模型可自行提出新查询，不把动态联想写成正式关系，不设置累计思考轮次门禁。

[快照采样](<../../../lib/core/knowledge/snapshot.js>)固定验证前缀；发现与索引有各自水位。返回前重验权限和本次要交付的正文，改变的来源不能沿用缓存命中。取消、超时、缺对象和截断如实表达。

## 4. 呈现边界

[model-material](<../../../lib/core/knowledge/model-material.js>) 只复用请求内已经通过校验的正文。可补充模型摘录的素材不进入结构对象；[knowledge-text](<../../../lib/host/tools/knowledge-text.js>) 在共享总字符预算内优先直接证据和少量已知关联，去重并显式披露裁切。MCP 只在传输层选择一种文本表示，参见 [L1 传输契约](<../../CONTRACT.md#267-可选本机-mcp>)。

## 5. 兼容与验证

索引是派生数据，重建不能改变同一来源的持久定位。SQLite/FTS5 缺失时有界扫描，不把扫描排序标成 BM25。验证入口：[来源清单与重建](<../../../test/core/knowledge-sources.test.mjs>)、[故障隔离](<../../../test/core/knowledge-faults.test.mjs>)、[双端与模型呈现](<../../../test/host/knowledge-parity.test.mjs>)。

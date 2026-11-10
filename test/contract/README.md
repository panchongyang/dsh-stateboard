# contract 模块测试

## 范围

公开 API、共享契约一致性、工具 schema、审计治理与门策略迁移。

| 文件 | 职责 | suite |
|---|---|---|
| [api-surface.test.mjs](api-surface.test.mjs) | 冻结 ProjectHandle 的公开成员、命令结果键和正常任务事件顺序。 | `test:core` |
| [contract-parity.test.mjs](contract-parity.test.mjs) | 保证命令注册、领域枚举、客户端标签和 HTTP 路径共享冻结契约。 | `test:core` |
| [gate-migration-v3.test.mjs](gate-migration-v3.test.mjs) | 约束 v2 人工门到 v3 审计门迁移的离线预检、备份与可续跑性。 | `test:core` |
| [review-governance.test.mjs](review-governance.test.mjs) | 维护第三方审计门的身份独立、不可变交付范围和人工兜底验收契约。 | `test:core` |
| [tool-schema-snapshot.test.mjs](tool-schema-snapshot.test.mjs) | 冻结模型可见工具名称、描述、参数 schema 与声明 manifest 的一致性。 | `test:core` |

## 不覆盖

不访问真实用户 store/profile，不替代其他模块的领域测试或人工 UI 验收；本目录不是产品运行入口。

## 外部前置

Node 22+，可写临时目录和 Node 子进程；具体 Git/链接等前置见文件头。

## 运行

在仓库根执行：

```powershell
node --test test/contract/*.test.mjs
```

suite 归属不由目录名推断，以表格和根 [测试索引](../README.md) 为准；默认 core/client/host 接线由递归 discovery 门禁检查。

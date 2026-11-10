# docs 模块测试

## 范围

内嵌/外置文档、固定 Git 内容、迁移与证据审计；包含文档的 core 和 host 表面。

| 文件 | 职责 | suite |
|---|---|---|
| [doc-external-compat.test.mjs](doc-external-compat.test.mjs) | 维护外置文档事件、旧读者拒绝策略和快照投影的兼容边界。 | `test:core` |
| [doc-external-edges.test.mjs](doc-external-edges.test.mjs) | 封住绑定变更、确认上下文和内容过滤器对外置文档观测的竞态漏洞。 | `test:core` |
| [doc-external-routes.test.mjs](doc-external-routes.test.mjs) | 约束外置文档 HTTP 协议、鉴权及拒绝请求不得触发冷开恢复的边界。 | `test:host` |
| [doc-external-tools.test.mjs](doc-external-tools.test.mjs) | 约束 project_doc 工具到外置文档命令的映射及中文渲染保留的诊断信息。 | `test:host` |
| [doc-external.test.mjs](doc-external.test.mjs) | 约束外置文档登记、管理、确认及读取只操作元数据的完整生命周期。 | `test:core` |
| [doc-fixed-auto.test.mjs](doc-fixed-auto.test.mjs) | 保证提交文档证据自动固定可信 Git 内容，能力不足时带明确原因降级。 | `test:core` |
| [doc-fixed-edges.test.mjs](doc-fixed-edges.test.mjs) | 限制历史固定证据、快照及 Git 内容读取的真实性边界。 | `test:core` |
| [doc-fixed-evidence.test.mjs](doc-fixed-evidence.test.mjs) | 保证固定证据身份由系统产生，历史对象审计不退回当前文件或异源仓库。 | `test:core` |
| [doc-fixed-git.test.mjs](doc-fixed-git.test.mjs) | 保证 Git blob 身份与工作区洁净判断只读且不执行用户内容转换程序。 | `test:core` |
| [doc-fixed-head-race.test.mjs](doc-fixed-head-race.test.mjs) | 防止洁净校验期间 HEAD 前移造成旧提交与当前字节混配。 | `test:core` |
| [doc-fixed-surfaces.test.mjs](doc-fixed-surfaces.test.mjs) | 保证工具和 HTTP 暴露只读固定字节查询，提交证据仍由系统自动固定。 | `test:core` |
| [doc-inline-write-boundaries.test.mjs](doc-inline-write-boundaries.test.mjs) | 防止被拒绝的内嵌写请求先创建项目或冷开恢复已有工作。 | `test:host` |
| [doc-inline-write-policy.test.mjs](doc-inline-write-policy.test.mjs) | 维护内嵌文档默认只读归档策略及唯一人工授权开关。 | `test:core` |
| [doc-migration-write.test.mjs](doc-migration-write.test.mjs) | 保证获授权的内嵌转外置迁移保留身份和历史档案，失败可恢复且零部分写入。 | `test:core` |
| [doc-migration.test.mjs](doc-migration.test.mjs) | 保证内嵌迁移盘点完整枚举历史字节和引用，并保持只读导出。 | `test:core` |
| [doc-read.test.mjs](doc-read.test.mjs) | 约束工作区文档安全定位、原始字节哈希、严格解码与有界预览。 | `test:core` |
| [evidence-audit.test.mjs](evidence-audit.test.mjs) | 约束证据材料、跨尝试替代、内容漂移与人工验收的真实性边界。 | `test:core` |
| [evidence-restart.test.mjs](evidence-restart.test.mjs) | 保证历史签名材料与旧 auto 策略冷重放不改历史，新工作遵守人工验收。 | `test:core` |
| [evidence-runner.test.mjs](evidence-runner.test.mjs) | 证明 command/test/note/url 都是材料，不会因 ref 或 execution 自报而被执行或判真。 | `test:core` |

## 不覆盖

不访问真实用户 store/profile，不替代其他模块的领域测试或人工 UI 验收；本目录不是产品运行入口。

## 外部前置

部分用例需要系统 Git 或平台链接权限；缺能力的既有显式 skip 仍以运行结果为准。文档 host 表面另需 DSH peer。

## 运行

在仓库根执行：

```powershell
node --test test/docs/*.test.mjs
npm run test:host  # 文档 host 表面也接入此 suite
```

suite 归属不由目录名推断，以表格和根 [测试索引](../README.md) 为准；默认 core/client/host 接线由递归 discovery 门禁检查。

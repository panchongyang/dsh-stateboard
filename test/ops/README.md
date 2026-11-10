# ops 模块测试

## 范围

测试环境、恢复演练、CI/发布门禁、性能、架构/工具链和测试发现/说明/干净导出门禁。

| 文件 | 职责 | suite |
|---|---|---|
| [architecture-map.test.mjs](architecture-map.test.mjs) | 让架构文档的模块路径清单与磁盘文件保持可解析的一致性。 | `test:core` |
| [ci-config.test.mjs](ci-config.test.mjs) | 防止 CI 配置移除强制质量门禁、离线子集或客户端产物一致性检查。 | `test:core` |
| [core-performance.test.mjs](core-performance.test.mjs) | 约束两千任务 brief 体积及项目枚举零 handle/锁预算；不进入 core/fast。 | `test:perf` |
| [client-build-tsx.test.mjs](client-build-tsx.test.mjs) | 约束 build-client 对 .tsx 入口、单 bundle、classic JSX、source map 换行与参数拒绝的契约。 | `test:core` |
| [client-layers.test.mjs](client-layers.test.mjs) | 约束前端分层 import 方向、唯一 fetch、规模上限、迁移豁免及解析边界。 | `test:core` |
| [project-list-performance.test.mjs](project-list-performance.test.mjs) | 约束项目列表热路径零日志读取，冷重放离线程且受缓存、并发和截止预算限制。 | `test:perf` |
| [prompt-health-isolation.test.mjs](prompt-health-isolation.test.mjs) | 保证 Prompt/brief 热路径只读内存，深证据审计隔离运行且不复用过期健康结果。 | `test:perf` |
| [recovery-drill.test.mjs](recovery-drill.test.mjs) | 证明有界合成恢复演练覆盖备份、冷恢复和后续业务继续，禁止真实根参数。 | `test:recovery` |
| [release-purity.test.mjs](release-purity.test.mjs) | 校验公开源码及 npm 包边界不夹带维护 CLI、私密文本或不可信客户端产物。 | `test:core` |
| [release-readiness.test.mjs](release-readiness.test.mjs) | 约束候选 tarball 发布就绪判断、元数据/条目类型和 README 链接解析的保守边界。 | `test:core` |
| [release-tag.test.mjs](release-tag.test.mjs) | 约束发布候选 tag 决策与消息记录，兼容声明不足或门禁失败时拒绝。 | `test:core` |
| [scripts.test.mjs](scripts.test.mjs) | 约束维护脚本权限沙箱、安装所有权、失败回滚和卸载保留用户数据。 | `test:core` |
| [test-discovery.test.mjs](test-discovery.test.mjs) | 防止 tracked 测试入口漏接默认/core/host/CI 门禁及遗漏矩阵 worker。 | `test:core` |
| [hermetic-gate.test.mjs](hermetic-gate.test.mjs) | 保证公开 Git 安全回归在只有 HEAD 已跟踪文件的干净树中仍可执行。 | `test:core` |
| [test-docs.test.mjs](test-docs.test.mjs) | 让所有公开测试入口持续满足中文说明结构，并证明检查器会拒绝缺项而非空扫通过。 | `test:core` |
| [test-typecheck.test.mjs](test-typecheck.test.mjs) | 证明测试侧 TS 入口能检查 helpers/fixtures，且显式类型错误负例会让编译器非零退出。 | `test:core` |
| [test-env-seed.test.mjs](test-env-seed.test.mjs) | 保证独立测试环境播种幂等且 URL/认证解析不接触生产源或执行注入脚本。 | `test:core` |
| [test-env.test.mjs](test-env.test.mjs) | 约束独立测试环境的目录所有权、环境隔离、监督进程及安全停止/重置。 | `test:core` |
| [typescript-toolchain.test.mjs](typescript-toolchain.test.mjs) | 保证隔离 TypeScript 工具链支持后端 JS/TS 共存并隔离浏览器和 Node 类型。 | `test:core` |
| [typescript-client-toolchain.test.mjs](typescript-client-toolchain.test.mjs) | 约束客户端 tsconfig、classic JSX、DOM/Node 边界与 noEmit 类型检查。 | `test:core` |

## 不覆盖

不访问真实用户 store/profile，不替代其他模块的领域测试或人工 UI 验收；本目录不是产品运行入口。

## 外部前置

工具链测试需要 tools/typescript 依赖；干净导出门禁使用已提交 HEAD。其他前置以各文件四字段头注释为准。

## 运行

在仓库根执行：

```powershell
node --test test/ops/*.test.mjs
```

suite 归属不由目录名推断，以 [suite manifest](<../suite-manifest.mjs>)为唯一来源；根 [测试索引](<../README.md>)说明 unit/integration/cli/ops 的范围和预算。core 聚合离线四层；host 独立且需要 peer；三份性能入口只在 `test:perf`、恢复演练只在 `test:recovery` 执行，strict 串行调用，CI 独立执行。目录 glob 是手工全 ops 运行，不等于默认 core。

[test-gates.test.mjs](<test-gates.test.mjs>)验证规模门禁及超时失败路径；默认 core 先执行 [规模门禁](<../../scripts/check-test-size.mjs>)。新文件物理行 ≤600，函数 AST 行 ≤150；四个精确既有 baseline 只能保持/缩小，不能增长，≤600 后移除例外。coverage 复用 manifest 全部 tracked 入口，阈值 line/branch/functions 为 90/80/90，SKIP 数和未覆盖能力单独报告，详见根索引。

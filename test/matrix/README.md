# R3 核心矩阵 worker

## 范围

三个 worker 由 `test/core/core-matrix.test.mjs` 在隔离子进程中启动，穷举任务命令的状态、角色、租约、token、版本、意图结清与归档边界：

| 文件 | 职责 |
|---|---|
| [core-matrix.mjs](core-matrix.mjs) | 状态 × 身份 × 租约 × token × 版本 × 意图的笛卡尔契约。 |
| [core-boundaries.mjs](core-boundaries.mjs) | 独立 oracle 穷举租约、角色、token、归档和必填字段边界的命令原子性。 |
| [core-lifecycle.mjs](core-lifecycle.mjs) | 真实命令链补齐归档、重领、意图重试及驳回复用租约的交互边界。 |

## 不覆盖

- host/client/UI；矩阵只管核心命令状态机。
- 真实 store/真实项目数据；worker 使用合成隔离根。
- 不能单独代替 `test:core`：它们是 `core-matrix.test.mjs` 的子 worker，必须由 launcher 启动。

## 外部前置

- 由 `test/core/core-matrix.test.mjs` 启动；`test/ops/test-discovery.test.mjs` 会检查 launcher 是否包含全部 worker。
- 子进程使用隔离 HOME/TEMP 和合成 store；不要手工指向真实根。

## 运行

```powershell
node --test test/core/core-matrix.test.mjs
npm run test:core            # 包含 core-matrix
```

新增/删除 worker 时同时更新 launcher；`test-discovery` 会拒绝遗漏。

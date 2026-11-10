# 日志抢救/前缀修复 worker

## 范围

本目录是 `test/storage/salvage-log.test.mjs` 启动的隔离 worker，不是独立测试套件：

| 文件 | 职责 |
|---|---|
| [prefix.mjs](prefix.mjs) | 损坏日志的只读有效前缀显式标非当前；修复必须备份并人工确认数据丢失。 |

## 不覆盖

- 常规日志写入/状态机（见 `test/core/core.test.mjs`、`test/storage/store-faults.test.mjs`）。
- 真实用户 store 或自动丢弃数据；只允许合成根。
- 不能直接作为产品 CLI 使用；worker 通过 `--test` 由 launcher 启动。

## 外部前置

- 由 `test/storage/salvage-log.test.mjs` 启动；需要 Node 子进程和隔离根。
- 只读 CLI 依赖 Node permission/沙箱，不能跳过；修复路径必须显式授权并验证后缀。

## 运行

```powershell
node --test test/storage/salvage-log.test.mjs
```

抢救/修复是高风险路径；失败时保留备份与现场，不要用自动重试覆盖。

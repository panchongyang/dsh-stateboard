# 故障注入 worker

## 范围

这里不是独立测试套件，而是由 `test/storage/store-faults.test.mjs` 通过子进程启动的故障注入 worker：

| 文件 | 职责 |
|---|---|
| [store-faults.mjs](store-faults.mjs) | JSONL/blob/meta/快照故障中的提交确定性、回滚边界和冷恢复幂等。 |
| [framing.mjs](framing.mjs) | 不确定 WAL 尾部先验证再修帧；完整无 LF 记录不丢失、不完整残片不公开。 |
| [cold-replay.mjs](cold-replay.mjs) | 与 writer 无共享缓存的冷重放进程，拒绝隔离根外的 store 参数。 |

## 不覆盖

- 产品正常路径（由各领域测试覆盖）。
- 真实 store/真实用户数据；必须在合成隔离子进程里运行。
- 独立的 `npm test` 入口；不要单独运行这些文件并当作完整测试。

## 外部前置

- 必须由 `test/storage/store-faults.test.mjs` 的故障 fixture 启动，并传入隔离根与项目 id。
- 需要可启动 Node 子进程；会校验隔离根，越界参数应被拒绝。

## 运行

```powershell
node --test test/storage/store-faults.test.mjs
```

故障注入 worker 的失败通常先看子进程 diagnostic，再看 `test/helpers/fault-*` 的隔离约束。

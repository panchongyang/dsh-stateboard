# 容量基准：10k / 100k 提交

- 日期：2026-10-28
- 脚本：[scripts/bench-capacity.mjs](../scripts/bench-capacity.mjs)
- 结论用途：先测后定容量预算；本文件不是性能承诺。

## 方法

生成模式与测量模式分开：

```bash
# 1) 生成一次（临时目录，不写仓库）
node scripts/bench-capacity.mjs --generate --size 10000
node scripts/bench-capacity.mjs --generate --size 100000

# 2) 对生成目录测量（--dir 用上一步输出的 dir）
node scripts/bench-capacity.mjs --measure --size 10000  --dir <dir> --repeats 3
node scripts/bench-capacity.mjs --measure --size 100000 --dir <dir> --repeats 2
```

数据集：每条 commit 一个 `task/created`（首条 `project/created`），任务状态 ready、单条 acceptance；生成后写一次 `snapshot.json`。测量冷启动时 snapshot 已在。100k 数据集只在本地跑，**不在 CI**；CI 只跑常规单测。

测量项：

- 冷启动：`new JsonlStore(dir, meta, {lock:false}).open()`，含读全量日志、`validateCommits`、读 snapshot、重放尾部；
- `listProjects`：`ProjectService.listProjects()`（本项目一个项目）；
- 首条命令：打开 handle 后第一条 `task.update`；
- 稳态：50 条 `task.update` 的 p50/p95；
- RSS：在 cold/list/open/命令阶段采样，取最大值（采样峰值，不是 OS 级峰值）。

测量会把生成目录复制到独立临时目录后再写入 51 条 commit；源数据集保持 pristine，所以同一 `--dir` 可重复运行。

## 环境

- 机器：AMD Ryzen 9 7950X3D 16-Core，67.8 GB RAM
- 系统：win32 x64
- Node：v22.20.0
- 数据集：10k（9,999 任务）/ 100k（99,999 任务），单项目，无文档/证据/计划

## 结果

| 指标 | 10k | 100k | 倍数 |
|---|---:|---:|---:|
| commits.jsonl | 8.17 MB | 82.42 MB | 10.1× |
| snapshot.json | 9.01 MB | 90.46 MB | 10.0× |
| 冷启动 p50 | 149 ms | 1,503 ms | 10.1× |
| listProjects p50 | 154 ms | 1,512 ms | 9.8× |
| 首条命令 | 72 ms | 756 ms | 10.5× |
| 稳态命令 p50 | 64 ms | 730 ms | 11.4× |
| 稳态命令 p95 | 79 ms | 836 ms | 10.6× |
| RSS 峰值（采样） | 368 MB | 2,114 MB | 5.7× |

100k 的测量会再追加 51 条 commit（首条 + 50 条稳态），所以测量输出里的 `commitsBytes` 比生成时略大；上表用生成时/测量时同一量级，不把 51 条当异常。

## 归因

1. **冷启动是全量读 + 全量校验，不是只读尾部。** `readJsonLines` 一次读完整文件，`validateCommits` 对每条 commit 校验 v/seq/prev/hash；snapshot 只让重放从 `snapshot.seq` 开始，**不跳过对全量日志的读取和校验**。所以 100k 冷启动 1.5s，接近日志大小线性。
2. **状态全量驻留。** `state.tasks` 保存每个任务的完整快照，`commits` 与 `timeline` 也保留全量事件；100k 任务时 RSS 采样到 2.1 GB，内存随任务数近似线性。
3. **每条命令 structuredClone 整个 state。** `ProjectHandle.command()` 在 `_execute` 前 `structuredClone(realState)`，并克隆整个 lease 表；100k 任务时单条命令 p50 730ms，10k 时 64ms。命令延迟主要花在克隆，不在 JSON 序列化/fsync。
4. **listProjects 对每个项目完整 open。** 虽然 `lock:false` 不抢锁，但仍读全量日志并重放；本项目 100k 时 1.5s。项目数增加会线性叠加。
5. 首条命令 756ms 与稳态同量级，说明打开 handle 后的首条命令没有额外的一次性成本；成本来自克隆。

## 边界

- 这是单项目、任务字段固定、无文档/证据/计划/租约历史的合成数据；真实项目 100k commit 的实体分布更杂，内存/时间可能更高。
- 100k 只跑了 2 次（10k 3 次）；RSS 是采样峰值，不是精确峰值。
- 没有测 1M；没有测多项目并行。
- 没有在此任务里做索引/分段/流式优化；是否值得做由后续容量决策任务定。

## 结论（给决策任务的输入）

- 10k 提交仍可在交互范围（冷启动 ~150ms，命令 ~64ms）。
- 100k 提交已不适合“每条命令全量克隆”：命令 ~0.7s、RSS ~2GB、listProjects ~1.5s。
- 若目标支持 100k 长期项目，优先考虑：命令状态差量/写时复制、日志分段+索引、snapshot 尾部读取（仍校验哈希链但避免全量 parse）、listProjects 摘要缓存。
- 若暂不优化，应把 100k 明确写成“可打开、不可高频交互”的容量边界，而不是承诺交互性能。

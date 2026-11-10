# 静态 fixture 与子进程脚本

## 范围

本目录提供测试用的静态数据、子进程脚本和 fake 可执行文件，不是测试入口：

| 文件/目录 | 用途 |
|---|---|
| [fake-git/](fake-git/README.md) | 参数忽略的假 Git，可执行时写 `PB_GIT_MARKER`；供 Git 执行面安全测试使用。 |
| [evidence-restart-child.mjs](evidence-restart-child.mjs) | `evidence-restart` 的冷重启子进程。 |
| [identity-create-child.mjs](identity-create-child.mjs) | 共享根上的并发 `createProject` 子进程。 |
| [lock-child.mjs](lock-child.mjs) | 锁竞争测试的子进程，带 release barrier。 |
| [legacy-execution.mjs](legacy-execution.mjs) | 历史签名格式 fixture，只用于回放，不被运行时 import。 |
| [tool-schema.json](tool-schema.json) | 模型可见工具 schema 快照。 |

## 不覆盖

- 不是产品发布内容；`npm pack` 不包含本目录。
- 不含真实凭据/真实项目数据。
- 不要让产品代码 import 这些文件。

## 外部前置

- 大多数子进程需要从测试传入隔离根/参数；fake-git 的构建方式见其自己的 README。
- Store 回放测试在临时目录生成合成基线。维护者比较获准的隔离样本时，用 `--baseline <文件>` 指定本地基线。仅在建立可信基线时使用 `--update`。默认本地基线由 Git 忽略，`--gate` 无需基线。

## 运行

没有独立测试；由对应测试使用，例如：

```powershell
node --test test/git/git-exec.test.mjs
node --test test/core/identity-conflicts.test.mjs
node --test test/storage/stores-replay.test.mjs
```

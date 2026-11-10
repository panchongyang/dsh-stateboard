# 共享 fixture 与隔离环境

## 范围

本目录是测试支持代码，不是测试入口，不直接产生 `test()` 结果：

| 文件 | 用途 |
|---|---|
| [client-bundle-fixture.mjs](<client-bundle-fixture.mjs>) | 逐例加载真实客户端 bundle，提供 React/hook 替身、树遍历及合成卡片/表单数据；不注册测试，不访问 DOM。 |
| [fixed-fixture.mjs](fixed-fixture.mjs) | 固定证据/Git 测试共享的临时 Git 仓库、字节哈希与来源引导 fixture。 |
| [service-fixture.mjs](service-fixture.mjs) | docs/core 共用的临时 service、create/open 项目、命令载荷与失败清理。 |
| [core-lifecycle-fixture.mjs](core-lifecycle-fixture.mjs) | 四个 core 域与 core-performance 共用的原样 setup/命令/计划 helper；不注册测试，不改变原有清理语义。 |
| [git-poison.mjs](git-poison.mjs) | 四个 Git 安全测试共用的 fake Git、marker、PATH、根/子目录/linked worktree 与 tracked CLI。 |
| [core-matrix-fixture.mjs](core-matrix-fixture.mjs) | 核心矩阵 worker 的内存/隔离 store fixture。 |
| [core-matrix-oracle.mjs](core-matrix-oracle.mjs) | 从 CONTRACT/DESIGN 独立转写的矩阵期望，不复用生产守卫。 |
| [fault-fixture.mjs](fault-fixture.mjs) | 故障注入的合成项目与子进程启动。 |
| [fault-fs.mjs](fault-fs.mjs) | 仅对合成项目生效的实例级文件故障适配器，不 patch 全局 fs。 |
| [fault-isolation.mjs](fault-isolation.mjs) | 隔离 HOME/USERPROFILE/DSH/TEMP 等环境，并断言默认根在 fixture 内。 |

## service 与 Git 安全 fixture API

- `makeService(t, options)` 返回 `svc/base/stateDir/board/wsDir/workspacePath`；`withProject(t, options)` 再返回 `h`。默认构造全新临时 board/workspace，`projectId` 显式选择 open，`clock`、`privilegedInlineWrites` 等选项原样传给 service，不自动 attach 或 seed。
- `command(op, extra)` 复用 fixed-fixture 的命令载荷默认值；调用点可显式覆盖 actor/cmdId。固定来源仍只能显式调用 `fixed-fixture.bootstrapPin`；fresh、首次只读及 HEAD race 构造不隐式 bootstrap。
- 必传测试上下文 `t`。同一用例先逆序 close 全部 service，再清临时目录；init/create/open 或断言失败也执行清理。只删除 service fixture 自己创建的 base；显式传入的 rootDir/workspacePath 始终借用不删除。Git root 由创建它的 `fixed-fixture.repository(format, t)` / `temp(t)` 登记清理，不转交 service 所有权。主动 `svc.close()` 不删目录，允许真正冷重开。清理使用异步删除及 Windows EPERM/ENOTEMPTY 有界重试，失败仍抛错。
- `git-poison` 的 `plant/FAKE_EXE/FAKE_NAME` 统一跨平台陷阱；`poison` 修改父进程 PATH/marker，必须 `finally restore()`；`withPath` 是同步作用域，恢复变量原始存在性并复位解析缓存。不得在同进程并行修改环境。
- `poisonedRepo(t, {bin})` 提供 `root/oid/bin/child/marker/env`；`temp(t)/repository(t)/markerPath(t)` 登记失败清理。`addWorktree/realGit` 在无陷阱 cwd 执行合成仓库准备；`runCli(RELEASE, args, cwd, marker, entries)` 使用 tracked release-tag，`poisonEnv` 只改子进程环境，`runsMarker` 只提供对照结果而不替代测试断言。
- 临时 board 不读真实 HOME/store；这里不是全进程环境沙箱。Git bootstrap 仍复用 fixed-fixture，系统 Git/PATH/global config 继承边界未扩张为全套隔离保证。

## 不覆盖

- 不替代任何领域测试；没有独立 suite。
- 不保证真实 store/真实宿主行为；只提供合成环境。
- 不要把 fixture 的默认值当作产品契约。

## 外部前置

- 由测试文件 import；不要在 `test:core`/`test:host` 中单独注册。
- 故障相关 helper 需要 Node 子进程；隔离 helper 会校验环境变量。

## 运行

没有独立命令；跟随使用它的测试运行，例如：

```powershell
node --test test/core/core-matrix.test.mjs
node --test test/storage/store-faults.test.mjs
```

# 贡献指南

产品是 `dsh-stateboard@0.2.0`（BSD-3-Clause）的 UI + agent 插件，不提供第三种 CLI 入口。先读 [README](<../README.md>) 的产品边界与[支持矩阵](<../README.md#支持环境>)，再读 [CONTRACT](<CONTRACT.md>)、[架构模块地图](<ARCHITECTURE.md>)。安装见 [安装入口](<INSTALL.md>)，备份/故障恢复见 [RECOVERY](<RECOVERY.md>)，搬迁/升级见 [MIGRATION](<MIGRATION.md>)。

## 开工与环境

按[测试分级规范](<TESTING-POLICY.md>)确定风险和候选基线。只用独立合成 fixture；不为了测试安装真实 profile、读写真实 store 或重启共享宿主。高风险变更用明确基线派生的独立候选与数据环境；分支/worktree 是贡献者选择的工程手段，不是项目板提供的产品隔离或复验能力。

- 验证平台 Windows 11 x64；macOS/Linux 未测。
- DSH 支持带 `0.2.1-rc.2` 至 `0.2.2-rc.1`，上界不跟随 latest。DSH `0.2.2-rc.1` 宿主需要 Node >=24.9；插件 engines Node >=22 只代表 core/client 基线，不承诺 Node22 Web宿主。支持带内未逐一实测的组合必须说明限制。
- 干净环境先安装下列隔离 TypeScript 开发工具链，再跑 `npm run test:ci`，无需安装本插件或创建宿主 profile。
- host 测试需能解析兼容 `@deepseek-ai/*` 开发依赖；由维护者显式配置独立宿主依赖路径/链接，不要求某个作者 checkout 或固定 junction。缺依赖的失败/可选测试 SKIP 不能算 host 通过。
- 根目录没有构建/类型检查依赖。客户端 esbuild 与 TypeScript 分别在 `tools/build/`、`tools/typescript/` 隔离安装；不要在根目录执行 npm install/ci。core/host 仍是直接运行的 JS ESM，客户端产物随源码提交。共享/后端配置、宽松检查范围与浏览器继承方式见 [TypeScript 开发工具链](<TYPESCRIPT.md>)；现有 JS 不做全量语义类型检查。

```text
npm --prefix tools/typescript ci --ignore-scripts  # 默认测试需要的开发期检查器
npm run typecheck                # 后端配置；不 emit
npm run test:types               # 工具链正反例
npm --prefix tools/build ci       # 需要构建客户端时
npm run build:client
npm run test:ci                   # core + client
npm run test:host                 # 兼容宿主开发依赖装配后
npm run audit:check
npm run check:architecture
npm run check:release
npm run check:release:readiness
```

全量冻结候选门禁由维护者统一安排，并按[隔离测试指南](<TEST-ENV.md>)隔离 HOME/USERPROFILE/DSH/XDG/npm/TEMP；stores gate 的 SKIP 必须单列，不能当真实数据验证。客户端构建后需由操作者在获准测试环境重启/刷新验收；离线通过不等于现有 GUI 已更新。没有明确许可不做浏览器自动化探针。

## 分层与改动入口

| 层 | 职责 | 禁止 |
|---|---|---|
| shared | 零依赖契约、命令名/错误码 | 引入其它层 |
| core | 状态机、日志、租约、文档、读模型 | import DSH/host/client |
| host | 工具/HTTP 参数与错误翻译 | 复制领域守卫 |
| client | React UI、纯逻辑、样式 | Node/core/host、innerHTML |

机器校验清单见[架构 §2.1](<ARCHITECTURE.md#21-机器可校验的清单arch-map>)。文件 ≤450行、普通函数 ≤80行、组件 ≤200行；新增运行时依赖需先讨论，不直接加入。后端阅读链、每个函数的中文用途说明口径及分批范围见[后端可读性基线](<BACKEND-READABILITY.md>)；参数/返回/数据形状的 TS 类型说明随中文用途同批渐进补，复杂逻辑另说明不变量、副作用与失败路径。类型说明不替代中文用途，也不等于授权重构、改变生产加载或 emit。

加任务命令：共享契约 → core allowedOps/命令守卫/注册表 → host 工具参数 → client transport/视图；同步 [CONTRACT](<CONTRACT.md>)、schema 快照与正负路径测试。事件顺序和 command 返回形状也是契约。不要在 UI 拼接另一套命令白名单。

加视图：纯逻辑抽独立模块并写直接 import 的单测；组件接收 props，网络操作走 transport。样式使用现有 token，修改客户端须重建提交产物，交互由人按[UI清单](<DOCS-UI-CHECKLIST.md>)点检。

新增测试必须接 `test:core` 或 `test:host`（客户端纯逻辑接现有 client 入口）；不要让文件存在但默认测试永远不执行。涉及日志、租约或状态的改动要跑重放/并发/锁相关回归。新增/搬移模块同步架构清单。

## 文档与提交

现行文档就地写当前事实，不能叠加日期更正或旧操作步骤。历史材料保留为明确标注的档案；不硬删文件、不改写共享历史。内部路径、真实任务ID、私网地址和私密材料不进入公共说明。npm README 必须自包含；不链接未打包文档，也不借未公开网页掩盖断链。

提交前核对：行为与契约是否同步、定向测试与跳过项是否如实记录、客户端产物是否匹配、`git diff --check` 是否通过。一次提交只做一件事，说明影响面与代码+数据回退方式；提交消息使用 `docs:` / `fix(scope):` / `feat(scope):` 等现有风格。

## 发布班车与 CI

发布班车把多项已审变更汇入约定的远端分支（`release` 或指定日期的 `release-YYYY-MM-DD`），该分支是班车 PR 的来源。任务指定班车为交付终点时，在卡片记录实际远端合入 SHA、验证和独立审查。班车分支的更新、PR 合入目标分支和正式发布分开管理。

1. **入队。** 记录任务、班车目标、基线和候选提交。合入前重新读取远端班车。基线有变时，在自己的候选分支同步、解决冲突并重新验证和审查。
2. **核对班车。** 变更进入班车 PR 的来源分支后，核对远端实际提交及对应的离线和 Ubuntu、Windows 性能检查。涉及宿主的改动附同一结果的隔离 `npm run test:host` 证据。
3. **交接给本机。** 约定的远端班车通过检查后，[CI](../.github/workflows/ci.yml) 在运行摘要里记录可同步的 SHA。本机在线时，维护者核对当前班车水位，把已审的源码变更同步到本地 `master`。内部与公开历史不同时，导入经审的差异并记录两边的 SHA。冲突回候选解决和验证。
4. **部署并冒烟。** 按已授权的开发 DSH profile、安装来源及备份回退点部署本地 `master` 的集成结果。确认服务启动、看板可打开、受影响流程可用，再记录实际运行的提交、冒烟结果和开发人员可查看的入口。部署失败按[发布与部署边界](RELEASE.md)回退并记录。工作站离线时，交接保留在 CI 摘要，等工作站上线再执行。

## 发布不等于部署

详见[维护者发布流程](<RELEASE.md>)。本地 commit、技术门禁、人工验收、公开仓/registry 发布与目标宿主部署各自独立。`private:true` 是人工发布闸，readiness 红时记录所有 technical blockers 和 manual gates，不能改 private 伪造通过。任何检查都不是 push、tag、publish、公开仓转换或重启授权。

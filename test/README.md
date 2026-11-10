# 测试索引

本目录是 ProjectBoard 的全部测试入口与支持脚本。先看本页的模块表，再按需进入子目录 README。

全部测试入口使用统一的中文头注释：`测试职责 / 典型流程 / 覆盖边界 / 外部前置`；每个 `test()` 上方有 `// 责任：`。

## 规模

- `119` 个 tracked `.mjs` 文件，含 `96` 个 `.test.mjs` 入口、host preflight、worker、helpers/fixtures 与 manifest；测试接线和预算的唯一来源是 [suite-manifest.mjs](<suite-manifest.mjs>)；discovery 比较 Git tracked 清单，新增入口必须显式登记，未跟踪文件不执行。
- 中文注释 checker 递归检查入口与 worker；helpers/fixtures 不算入口。
- 静态 `test()` 调用点含 `skip`/`todo`，不等于运行展开后的 pass 数；运行数量以各层 TAP 汇总为准。
- 没有浏览器自动化探针；客户端以纯逻辑测试和离线 bundle 冒烟为主。

## Suite 入口

| 命令 | 内容 | 何时用 |
|---|---|---|
| `npm run test:core` | 规模门禁 → unit → integration → cli → ops，包含客户端；不含 host/perf/recovery | 提交前默认 |
| `npm run test:unit` | 客户端纯逻辑/竞态、契约枚举、时钟/摘要/交付的小范围测试；预算 480 秒 | 局部逻辑反馈 |
| `npm run test:integration` | core/storage/docs/Git/契约与离线 bundle 集成；预算 480 秒 | 跨模块合成 fixture |
| `npm run test:cli` | 安装/卸载、release-tag、CLI Git 根限制；预算 300 秒 | 维护 CLI |
| `npm run test:ops` | CI/发布、架构/工具链、测试环境与门禁自身；预算 300 秒 | 工程接线 |
| `npm run test:client` | 三份 bundle/styles/render 契约 + client/unit，均已包含在 core | 客户端定向反馈 |
| `npm run test:host` | preflight 与宿主 HTTP/工具/路由/身份；预算 300 秒，需要本机 DSH peer | 改 host 层或发布前 |
| `npm run test:fast` | unit + integration；不含 cli/ops/host/perf/recovery | 本地领域反馈 |
| `npm run test:perf` | 大看板 brief、Prompt/项目列表性能；串行，预算 300 秒 | 改热路径后 |
| `npm run test:recovery` | 合成恢复演练；预算 300 秒 | strict 与 CI 独立步骤 |
| `npm run test:stores -- --gate` | 经授权的 store 副本回放；无数据时是 SKIP | 隔离 HOME 中运行 |
| `npm run test:coverage` | manifest 全部 wired tracked 入口（含 client/unit、host preflight、perf/recovery）；预算 1800 秒 | 全量 V8 覆盖核对 |
| `node scripts/check-test-docs.mjs` | 校验本目录所有入口的注释结构 | 改测试说明后 |

各叶层由 [run-suite.mjs](<../scripts/run-suite.mjs>)以最多 4 个文件并发执行（perf/recovery 固定 1），层与层串行，输出实际耗时/预算/退出码；超时回收本次子进程树并返回 124。预算是宽松的 wall-clock 上限，不是性能 SLA。`npm test` 为 core + host；`test:ci` 仅 core（已含全部 client，不重复执行）；`check:strict` 为 audit:check → npm test → perf → recovery → stores gate → release，使用 `&&` 顺序且失败即停。

### 覆盖率口径

`test:coverage` 先将 manifest 与 `git ls-files` 比对，拒绝漏接、重复与未跟踪入口；命令传递显式路径而非 glob。Node V8 阈值为 **line ≥90%、branch ≥80%、functions ≥90%**，任一不足非零退出。输出完整 TAP 的 skipped 数及用例名，SKIP 回调没有执行、不贡献覆盖，不能当 covered；real-store opt-in 未授权时保留 SKIP，不能以合成 fixture 或总覆盖率宣称真实数据覆盖。

保留 Node 原生 loaded-project 分母：已加载产品 JS 与维护脚本，Node 默认排除测试文件和 node_modules，具体路径以逐文件报告为准；不是只统计产品源码的独立阈值。V8 报告逐文件数据；手工 spawn 的 worker 和 `new Function` bundle 不保证按原源码计入，不能以总百分比替代相应能力验证。host 不在离线 CI；完整 coverage 需要本机 peer，缺依赖时必须报告失败/未执行，不能删除入口或把缺 peer 算 covered。

### 规模门禁

[check-test-size.mjs](<../scripts/check-test-size.mjs>)扫描 tracked `test/**/*.test.mjs`（helpers/fixtures 的非 `.test.mjs` 支持脚本不纳入），物理行包含注释/空行；**新文件最多 600 行，所有函数最多 150 行**。函数用隔离 tools/typescript 的 AST 识别，包含匿名回调、方法、多行箭头，无运行时依赖。core/离线 CI/strict 均执行本门禁。

四个既有文件用精确路径的不可增长上限保留：client/unit/bundle-logic 781、client/unit/external-docs 607、client/unit/logic 883、docs/evidence-audit 860 行；它们不是新文件的合规上限。任何 +1 行失败，不自动更新 baseline；降到 ≤600 后必须移除 stale exception。它们按领域拆分另行安排，本任务不修改既有产品测试 body/skip。[test-gates.test.mjs](<ops/test-gates.test.mjs>)证明 601 行、各 baseline +1、151 行函数与预算超时均会红。

## 模块地图

| 模块 | 范围 | 文件数 |
|---|---|---|
| `core` | 状态机、计划、租约、锁、意图、身份、矩阵 launcher | 23 |
| `storage` | store、日志完整性、提交边界、回放、迁移、修复、salvage | 8 |
| `docs` | 文档、外置文档、固定证据、证据审计 | 19 |
| `git` | Git 只读执行面、配置解析、换行属性 | 5 |
| `host` | HTTP API、宿主工具、宿主启动/身份接线 | 8 |
| `client` | 客户端纯逻辑、页面接线与离线 bundle 契约 | 11 |
| `ops` | 测试环境、CI/发布门禁、性能、恢复演练、前端分层/TS 工具链、测试自身的门禁 | 21 |
| `contract` | 公开 API、契约枚举、工具 schema、审查/迁移治理 | 5 |
| `matrix` | R3 核心矩阵 worker（独立目录，归核心 suite） | 3 |
| `faults` / `salvage` | launcher 启动的隔离支持 worker | 4 |
| `helpers` / `fixtures` | 共享 service/bundle/Git poison/隔离 helper 与静态 fixture（checker 排除） | 14 |

## core · 状态机、计划、租约、锁、意图、身份、矩阵

| 文件 | 职责 | suite |
|---|---|---|
| [alias-guard.test.mjs](core/alias-guard.test.mjs) | 保证 handle 与 store 共享同一个状态对象，避免提交后读模型丢写。 | `test:core` |
| [archived.test.mjs](core/archived.test.mjs) | 约束项目和计划归档时的写屏障、活跃工作保护与恢复时机。 | `test:core` |
| [clock-ttl.test.mjs](core/clock-ttl.test.mjs) | 用注入时钟约束租约 TTL、宽限期与续期截止时间。 | `test:core` |
| [core-matrix.test.mjs](core/core-matrix.test.mjs) | 确保默认门禁在最小隔离环境的子进程中运行 R3 核心矩阵。 | `test:core` |
| [task-lifecycle.test.mjs](core/task-lifecycle.test.mjs) | 约束任务发布、领取、交付、驳回与归属恢复。 | `test:core` |
| [plan-lifecycle.test.mjs](core/plan-lifecycle.test.mjs) | 约束计划草案、发布、版本、焦点与成员。 | `test:core` |
| [store-integrity.test.mjs](core/store-integrity.test.mjs) | 守住日志重放、完整性、单写者与项目搬迁。 | `test:core` |
| [lease-edit.test.mjs](core/lease-edit.test.mjs) | 约束租约身份、证据边界、轻编辑与创建者来源。 | `test:core` |
| [delivery.test.mjs](core/delivery.test.mjs) | 约束交付摘要中的身份尾码、时间线裁剪、检查点和文本净化。 | `test:core` |
| [digest.test.mjs](core/digest.test.mjs) | 阻止项目和任务文本伪造摘要规则块，并保持可控长度与可省略规则的稳定输出。 | `test:core` |
| [fsck-intents.test.mjs](core/fsck-intents.test.mjs) | 让健康检查只读诊断意图、工作引用、owner 和归档活跃工作的不变量。 | `test:core` |
| [handle-lifecycle.test.mjs](core/handle-lifecycle.test.mjs) | 维护同进程多 service 共享 handle 的引用计数与锁释放时机。 | `test:core` |
| [identity-conflicts.test.mjs](core/identity-conflicts.test.mjs) | 保证项目身份冲突、导入与创建中断不造成覆盖历史或重复看板。 | `test:core` |
| [identity.test.mjs](core/identity.test.mjs) | 维护随机稳定项目 id、路径绑定、旧路径哈希兼容与 worktree 发现规则。 | `test:core` |
| [intent-settlement.test.mjs](core/intent-settlement.test.mjs) | 约束开放工作意图退出时必须显式结清，未知结果只能中断后对账。 | `test:core` |
| [lease-reclaim.test.mjs](core/lease-reclaim.test.mjs) | 防止命令内租约回收投影被旧任务快照覆盖，并提供受限的过期工作恢复入口。 | `test:core` |
| [lease-renew.test.mjs](core/lease-renew.test.mjs) | 限制显式续租与隐式 touch 的无进展占用时间，保护会话/epoch 边界。 | `test:core` |
| [lock-race.test.mjs](core/lock-race.test.mjs) | 保证多进程抢锁、死锁接管和 claim 清理不会形成双 writer。 | `test:core` |
| [lock.test.mjs](core/lock.test.mjs) | 维护 JSONL store 单写锁的活进程保护、死进程接管与 nonce 校验。 | `test:core` |
| [matrix/core-boundaries.mjs](matrix/core-boundaries.mjs) | 用独立 oracle 穷举租约、角色、token、归档和必填字段边界的命令原子性。 | `test:core (via core-matrix)` |
| [matrix/core-lifecycle.mjs](matrix/core-lifecycle.mjs) | 用真实命令链补齐归档、重领、意图重试及驳回复用租约的交互边界。 | `test:core (via core-matrix)` |
| [matrix/core-matrix.mjs](matrix/core-matrix.mjs) | 穷举任务命令状态、身份、租约、token、版本与意图结清的笛卡尔契约。 | `test:core (via core-matrix)` |
| [plan-acceptance.test.mjs](core/plan-acceptance.test.mjs) | 守住计划物化任务必须有验收点，既有任务修订不得无意丢失验收要求。 | `test:core` |
| [plan-concurrency.test.mjs](core/plan-concurrency.test.mjs) | 保证多个活动计划交错修改时各自版本、成员、焦点与归档互不污染。 | `test:core` |
| [restart-expiry-audit.test.mjs](core/restart-expiry-audit.test.mjs) | 保证冷启动清理持久 owner 时与任务恢复同提交记录 lease/expired 审计。 | `test:core` |
| [state-machine.test.mjs](core/state-machine.test.mjs) | 封住终态编辑、依赖成环、过期版本与跨项目任务修订的非法转移。 | `test:core` |

## storage · store、日志完整性、提交边界、回放、迁移、修复、salvage

| 文件 | 职责 | suite |
|---|---|---|
| [commit-boundary.test.mjs](storage/commit-boundary.test.mjs) | 区分已持久化的业务提交与后续 meta/快照写失败，避免误报回滚或重复项目。 | `test:core` |
| [event-compat.test.mjs](storage/event-compat.test.mjs) | 冻结事件分类与未知事件 fail-closed 的重放/修复边界。 | `test:core` |
| [migration-replay.test.mjs](storage/migration-replay.test.mjs) | 保证 store 副本的版本、任务、计划、焦点和健康结果可重复重放，源目录保持只读。 | `test:core` |
| [repair-log.test.mjs](storage/repair-log.test.mjs) | 保证分叉日志修复规划只选可验证链，对非分叉损坏拒绝猜测修复。 | `test:core` |
| [replay-snapshot.test.mjs](storage/replay-snapshot.test.mjs) | 兼容缺 planHeads/currentPlans 的旧快照，使后续计划事件仍可正确重放。 | `test:core` |
| [salvage-log.test.mjs](storage/salvage-log.test.mjs) | 确保日志抢救和显式修复 worker 只在合成隔离环境执行。 | `test:core` |
| [store-faults.test.mjs](storage/store-faults.test.mjs) | 确保 R3 存储故障与 framing 测试在最小隔离子进程运行。 | `test:core` |
| [stores-replay.test.mjs](storage/stores-replay.test.mjs) | 验证 store 门禁的事件覆盖、定位诊断、基线比较与副本隔离。 | `test:core` |

## docs · 文档、外置文档、固定证据、证据审计

| 文件 | 职责 | suite |
|---|---|---|
| [doc-external-compat.test.mjs](docs/doc-external-compat.test.mjs) | 维护外置文档事件、旧读者拒绝策略和快照投影的兼容边界。 | `test:core` |
| [doc-external-edges.test.mjs](docs/doc-external-edges.test.mjs) | 封住绑定变更、确认上下文和内容过滤器对外置文档观测的竞态漏洞。 | `test:core` |
| [doc-external-routes.test.mjs](docs/doc-external-routes.test.mjs) | 约束外置文档 HTTP 协议、鉴权及拒绝请求不得触发冷开恢复的边界。 | `test:host` |
| [doc-external-tools.test.mjs](docs/doc-external-tools.test.mjs) | 约束 project_doc 工具到外置文档命令的映射及中文渲染保留的诊断信息。 | `test:host` |
| [doc-external.test.mjs](docs/doc-external.test.mjs) | 约束外置文档登记、管理、确认及读取只操作元数据的完整生命周期。 | `test:core` |
| [doc-fixed-auto.test.mjs](docs/doc-fixed-auto.test.mjs) | 保证提交文档证据自动固定可信 Git 内容，能力不足时带明确原因降级。 | `test:core` |
| [doc-fixed-edges.test.mjs](docs/doc-fixed-edges.test.mjs) | 限制历史固定证据、快照及 Git 内容读取的真实性边界。 | `test:core` |
| [doc-fixed-evidence.test.mjs](docs/doc-fixed-evidence.test.mjs) | 保证固定证据身份由系统产生，历史对象审计不退回当前文件或异源仓库。 | `test:core` |
| [doc-fixed-git.test.mjs](docs/doc-fixed-git.test.mjs) | 保证 Git blob 身份与工作区洁净判断只读且不执行用户内容转换程序。 | `test:core` |
| [doc-fixed-head-race.test.mjs](docs/doc-fixed-head-race.test.mjs) | 防止洁净校验期间 HEAD 前移造成旧提交与当前字节混配。 | `test:core` |
| [doc-fixed-surfaces.test.mjs](docs/doc-fixed-surfaces.test.mjs) | 保证工具和 HTTP 暴露只读固定字节查询，提交证据仍由系统自动固定。 | `test:core` |
| [doc-inline-write-boundaries.test.mjs](docs/doc-inline-write-boundaries.test.mjs) | 防止被拒绝的内嵌写请求先创建项目或冷开恢复已有工作。 | `test:host` |
| [doc-inline-write-policy.test.mjs](docs/doc-inline-write-policy.test.mjs) | 维护内嵌文档默认只读归档策略及唯一人工授权开关。 | `test:core` |
| [doc-migration-write.test.mjs](docs/doc-migration-write.test.mjs) | 保证获授权的内嵌转外置迁移保留身份和历史档案，失败可恢复且零部分写入。 | `test:core` |
| [doc-migration.test.mjs](docs/doc-migration.test.mjs) | 保证内嵌迁移盘点完整枚举历史字节和引用，并保持只读导出。 | `test:core` |
| [doc-read.test.mjs](docs/doc-read.test.mjs) | 约束工作区文档安全定位、原始字节哈希、严格解码与有界预览。 | `test:core` |
| [evidence-audit.test.mjs](docs/evidence-audit.test.mjs) | 约束证据材料、跨尝试替代、内容漂移与人工验收的真实性边界。 | `test:core` |
| [evidence-restart.test.mjs](docs/evidence-restart.test.mjs) | 保证历史签名材料与旧 auto 策略冷重放不改历史，新工作遵守人工验收。 | `test:core` |
| [evidence-runner.test.mjs](docs/evidence-runner.test.mjs) | 证明 command/test/note/url 都是材料，不会因 ref 或 execution 自报而被执行或判真。 | `test:core` |

## git · Git 只读执行面、配置解析、换行属性

| 文件 | 职责 | suite |
|---|---|---|
| [git-config-parse.test.mjs](git/git-config-parse.test.mjs) | 确保分离 git-dir 的 worktree 所有权取自完整 Git 配置且未知时拒绝执行。 | `test:core` |
| [git-exec-repo-root.test.mjs](git/git-exec-repo-root.test.mjs) | 保证从子目录或 linked worktree 启动 CLI 时先发现全部禁执行仓库根。 | `test:core` |
| [git-exec-surface.test.mjs](git/git-exec-surface.test.mjs) | 封住点前缀目录、junction 与 Windows 短路径别名绕过 Git 执行根限制的漏洞。 | `test:core` |
| [git-exec.test.mjs](git/git-exec.test.mjs) | 保证所有核心 Git 调用复用工作区与运行仓库外的绝对可信可执行路径。 | `test:core` |
| [gitattributes-eol.test.mjs](git/gitattributes-eol.test.mjs) | 保证仓库文本在 autocrlf 主机检出后仍具有固定 LF 原始字节。 | `test:core` |

## host · HTTP API、宿主工具、宿主启动/身份接线

| 文件 | 职责 | suite |
|---|---|---|
| [host-audit.test.mjs](host/host-audit.test.mjs) | 校验宿主安装元数据、审计载荷翻译与 project:brief 字面文本注入边界。 | `test:host` |
| [host-preflight.mjs](host/host-preflight.mjs) | 保证插件在宿主冷启动时完整注册工具，并等待 webServer 后补挂路由和 token。 | `test:host` |
| [host-tools.test.mjs](host/host-tools.test.mjs) | 验证宿主工具从计划发布到任务交付、历史文档读取和会话事件的集成接线。 | `test:host` |
| [identity-host.test.mjs](host/identity-host.test.mjs) | 保证宿主会话在主 checkout 和 linked worktree 共用项目且证据根不漂移。 | `test:host` |
| [mcp-http.test.mjs](host/mcp-http.test.mjs) | 验证本机 MCP 传输、来源、鉴权和响应限制。 | `test:host` |
| [mcp-lifecycle.test.mjs](host/mcp-lifecycle.test.mjs) | 验证默认关闭、只读入口、插件配置和卸载释放。 | `test:host` |
| [mcp-write.test.mjs](host/mcp-write.test.mjs) | 验证项目写授权、工作会话、领卡重试、意图和证据提交、失败回滚与租约恢复。 | `test:host` |
| [routes.test.mjs](host/routes.test.mjs) | 验证项目 HTTP API 的成功主流程、鉴权、输入校验与错误状态映射。 | `test:host` |

## client · 客户端纯逻辑、页面接线与离线 bundle 冒烟

| 文件 | 职责 | suite |
|---|---|---|
| [client-races.test.mjs](client/client-races.test.mjs) | 限制请求竞态、轮询退避及页面停止后的迟到数据写回。 | `test:core` |
| [bundle-contract.test.mjs](<client/bundle-contract.test.mjs>) | 冻结 loader、依赖、公开 API 与插槽接线。 | `test:client` |
| [styles-contract.test.mjs](<client/styles-contract.test.mjs>) | 冻结 CSS 字节、主题、尺寸和动效。 | `test:client` |
| [views-render.test.mjs](<client/views-render.test.mjs>) | 冻结离线组件树与页面接线，不使用真实 DOM。 | `test:client` |
| [unit/bundle-logic.test.mjs](<client/unit/bundle-logic.test.mjs>) | 冻结出货 bundle 内纯逻辑；与三份契约合计保留 407 个静态 assert，逐 section 映射见 [client 索引](<client/README.md#断言映射>)。 | `test:unit:client` |
| [unit/client/doc-view.test.mjs](client/unit/doc-view.test.mjs) | 约束文档列表的单一提醒信号、分组/筛选与默认信息层级。 | `test:client` |
| [unit/client/external-docs.test.mjs](client/unit/external-docs.test.mjs) | 保证外置文档 UI 的状态维度、写载荷和乐观并发草稿始终 fail closed。 | `test:client` |
| [unit/client/logic.test.mjs](client/unit/logic.test.mjs) | 冻结客户端 Markdown/图表/流程图、筛选分组、命令载荷与计划编辑的纯逻辑契约。 | `test:client` |
| [unit/client/page-lifecycle.test.mjs](client/unit/page-lifecycle.test.mjs) | 约束页面读取生命周期、写后尾读、项目定位及认证失败恢复。 | `test:client` |
| [unit/client/page-navigation.test.mjs](client/unit/page-navigation.test.mjs) | 保证项目导航保留未确认丢弃的嵌套草稿，并隔离迟到写完成回调。 | `test:client` |
| [unit/client/page-wiring.test.mjs](client/unit/page-wiring.test.mjs) | 在真实出货页面接线中验证加载/失败、项目身份与认证恢复不会误清草稿。 | `test:client` |

## ops · 测试环境、CI/发布门禁、性能、恢复演练、测试自身的门禁

| 文件 | 职责 | suite |
|---|---|---|
| [architecture-map.test.mjs](ops/architecture-map.test.mjs) | 让架构文档的模块路径清单与磁盘文件保持可解析的一致性。 | `test:core` |
| [ci-config.test.mjs](ops/ci-config.test.mjs) | 防止 CI 配置移除强制质量门禁、离线子集或客户端产物一致性检查。 | `test:core` |
| [core-performance.test.mjs](ops/core-performance.test.mjs) | 约束两千任务 brief 体积及项目枚举零 handle/锁预算；不进入 core/fast。 | `test:perf` |
| [project-list-performance.test.mjs](ops/project-list-performance.test.mjs) | 约束项目列表热路径零日志读取，冷重放离线程且受缓存、并发和截止预算限制。 | `test:perf` |
| [prompt-health-isolation.test.mjs](ops/prompt-health-isolation.test.mjs) | 保证 Prompt/brief 热路径只读内存，深证据审计隔离运行且不复用过期健康结果。 | `test:perf` |
| [recovery-drill.test.mjs](ops/recovery-drill.test.mjs) | 证明有界合成恢复演练覆盖备份、冷恢复和后续业务继续，禁止真实根参数。 | `test:recovery` |
| [release-purity.test.mjs](ops/release-purity.test.mjs) | 校验公开源码及 npm 包边界不夹带维护 CLI、私密文本或不可信客户端产物。 | `test:core` |
| [release-readiness.test.mjs](ops/release-readiness.test.mjs) | 约束候选 tarball 发布就绪判断、元数据/条目类型和 README 链接解析的保守边界。 | `test:core` |
| [release-tag.test.mjs](ops/release-tag.test.mjs) | 约束发布候选 tag 决策与消息记录，兼容声明不足或门禁失败时拒绝。 | `test:core` |
| [scripts.test.mjs](ops/scripts.test.mjs) | 约束维护脚本权限沙箱、安装所有权、失败回滚和卸载保留用户数据。 | `test:core` |
| [test-discovery.test.mjs](ops/test-discovery.test.mjs) | 防止 tracked 测试入口漏接默认/core/host/CI 门禁及遗漏矩阵 worker。 | `test:core` |
| [hermetic-gate.test.mjs](ops/hermetic-gate.test.mjs) | 保证公开 Git 安全回归在只有 HEAD 已跟踪文件的干净树中仍可执行。 | `test:core` |
| [test-docs.test.mjs](ops/test-docs.test.mjs) | 让所有公开测试入口持续满足中文说明结构，并证明检查器会拒绝缺项而非空扫通过。 | `test:core` |
| [test-env-seed.test.mjs](ops/test-env-seed.test.mjs) | 保证独立测试环境播种幂等且 URL/认证解析不接触生产源或执行注入脚本。 | `test:core` |
| [test-env.test.mjs](ops/test-env.test.mjs) | 约束独立测试环境的目录所有权、环境隔离、监督进程及安全停止/重置。 | `test:core` |
| [typescript-toolchain.test.mjs](ops/typescript-toolchain.test.mjs) | 保证隔离 TypeScript 工具链支持后端 JS/TS 共存并隔离浏览器和 Node 类型。 | `test:core` |

## contract · 公开 API、契约枚举、工具 schema、审查/迁移治理

| 文件 | 职责 | suite |
|---|---|---|
| [api-surface.test.mjs](contract/api-surface.test.mjs) | 冻结 ProjectHandle 的公开成员、命令结果键和正常任务事件顺序。 | `test:core` |
| [contract-parity.test.mjs](contract/contract-parity.test.mjs) | 保证命令注册、领域枚举、客户端标签和 HTTP 路径共享冻结契约。 | `test:core` |
| [gate-migration-v3.test.mjs](contract/gate-migration-v3.test.mjs) | 约束 v2 人工门到 v3 审计门迁移的离线预检、备份与可续跑性。 | `test:core` |
| [review-governance.test.mjs](contract/review-governance.test.mjs) | 维护第三方审计门的身份独立、不可变交付范围和人工兜底验收契约。 | `test:core` |
| [tool-schema-snapshot.test.mjs](contract/tool-schema-snapshot.test.mjs) | 冻结模型可见工具名称、描述、参数 schema 与声明 manifest 的一致性。 | `test:core` |

## support · 测试辅助脚本/故障注入/fixture（不是产品测试）

| 文件 | 职责 | suite |
|---|---|---|
| [faults/cold-replay.mjs](faults/cold-replay.mjs) | 提供与 writer 无共享缓存的冷重放进程，拒绝隔离根外的 store 参数。 | 支持脚本 |
| [faults/framing.mjs](faults/framing.mjs) | 保证不确定 WAL 尾部先验证再修帧，完整无 LF 记录不丢失、不完整残片不公开。 | 支持脚本 |
| [faults/store-faults.mjs](faults/store-faults.mjs) | 约束 JSONL/blob/meta/快照故障中的提交确定性、回滚边界和冷恢复幂等。 | 支持脚本 |
| [fixed-fixture.mjs](helpers/fixed-fixture.mjs) | 为固定证据相关入口提供独立本地 Git 仓库、字节哈希和自动来源引导 fixture。 | 支持脚本 |
| [service-fixture.mjs](helpers/service-fixture.mjs) | 为 doc-fixed 与 core lifecycle 提供临时 service、create/open、命令载荷和失败清理；不隐式 bootstrap。 | 支持脚本 |
| [client-bundle-fixture.mjs](<helpers/client-bundle-fixture.mjs>) | 为客户端契约及 unit 逐例重建 bundle、React/hook 替身和合成数据；不注册测试。 | 支持脚本 |
| [core-lifecycle-fixture.mjs](helpers/core-lifecycle-fixture.mjs) | 为拆分后的四域与 core-performance 原样保留 setup/命令/计划 helper；不注册测试。 | 支持脚本 |
| [git-poison.mjs](helpers/git-poison.mjs) | 为四个 Git 安全测试提供跨平台陷阱、marker、PATH 与 tracked CLI/仓库拓扑 fixture。 | 支持脚本 |
| [salvage/prefix.mjs](salvage/prefix.mjs) | 保证损坏日志的只读有效前缀显式标非当前，修复必须备份并人工确认数据丢失。 | 支持脚本 |

## 文件夹说明

| 文件夹 | 说明 |
|---|---|
| [`core/`](core/README.md) | core 模块范围与运行入口 |
| [`storage/`](storage/README.md) | storage 模块范围与运行入口 |
| [`docs/`](docs/README.md) | docs 模块范围与运行入口 |
| [`git/`](git/README.md) | git 模块范围与运行入口 |
| [`host/`](host/README.md) | host 模块范围与运行入口 |
| [`client/`](client/README.md) | client 模块范围与运行入口 |
| [`ops/`](ops/README.md) | ops 模块范围与运行入口 |
| [`contract/`](contract/README.md) | contract 模块范围与运行入口 |
| [`client/unit/`](client/unit/README.md) | 客户端纯逻辑与页面接线测试 |
| [`matrix/`](matrix/README.md) | R3 核心矩阵 worker |
| [`faults/`](faults/README.md) | 故障注入/冷重放辅助脚本 |
| [`salvage/`](salvage/README.md) | 日志抢救/前缀修复辅助脚本 |
| [`helpers/`](helpers/README.md) | 共享 fixture/隔离环境 |
| [`fixtures/`](fixtures/README.md) | 静态 fixture 与子进程脚本 |

## 读测试的顺序

1. 先看本页模块表，确定改动属于哪个模块。
2. 打开对应模块的文件，先读文件头四字段，再读每个 `test()` 上方的 `// 责任`。
3. 需要跑的时候用对应 suite；不要先跑全量。
4. 失败时先看断言和“覆盖边界”，区分产品行为和测试环境/基线问题。

每个 tracked `.test.mjs` 仅放入一个模块目录；[test-discovery.test.mjs](<ops/test-discovery.test.mjs>)核对 manifest 的唯一叶 suite 与 core/client 等别名。perf 与 recovery 仅归独立 suite，不进入 core/fast；strict 串行调用，CI 单独执行。矩阵 worker 保持 `matrix/`，通过 core launcher 显式启动。

## 新增测试的写法

文件头：

```js
/**
 * 测试职责：一句话说明负责的系统行为。
 * 典型流程：准备 fixture → 执行命令/操作 → 断言结果/副作用。
 * 覆盖边界：覆盖 具体行为；不覆盖 明确排除的范围。
 * 外部前置：无 / 需要 Git / 需要 DSH peer / 需要 junction 等。
 */
```

每个用例：

```js
// 责任：说明这条用例验证的关键动作、断言对象和期望结果。
test('...', () => {});
```

写完跑 `node scripts/check-test-docs.mjs`；缺字段或缺责任行会直接失败。

## 已知基线/边界

- Git 安全测试只依赖 tracked 入口；`ops/hermetic-gate.test.mjs` 从 HEAD 创建干净导出验证，需先提交候选，未提交的布局不会进入导出。
- `test:host` 需要未公开发布的 DSH peer，因此不在 CI 的 offline 子集里；发布前必须在有 peer 的本机跑。
- `test:stores -- --gate` 在默认根没有项目时是 SKIP；显式根不存在或无有效日志时失败。SKIP 不算真实数据覆盖。
- 无浏览器自动化探针；UI 视觉/点击仍按人工验收。

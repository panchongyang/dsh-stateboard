# 测试隐式契约与外部依赖清单

本文是测试分层、规模门禁和覆盖率口径的现行设计输入，不是运行证据档案。**只盘点，不改变测试接线、行为或产品契约**；表中“处置”均为后续任务建议，不表示已经落地。安全边界遵循[产品方针](<../PRODUCT-PRINCIPLES.md>)、[测试分级](<../TESTING-POLICY.md>)和[隔离环境](<../TEST-ENV.md>)。

## 1. 清单来源与计数口径

以候选基线 `4b5766c` 的 [package scripts](<../../package.json>) 为入口，用 `git ls-files 'test/**/*.test.mjs'` 获取公共源码集合，展开 `test:unit:client` 的通配符，与[测试索引](<../../test/README.md>)逐项对照。审读每个文件的四字段头、责任/分段职责、fixture、命令链、断言及清理路径；同时扫描环境变量、进程、私有路径、文件读写、临时目录和全局替换，追读共享 helper/脚本入口。

| 接线入口 | 唯一 `.test.mjs` 文件数 | 说明 |
|---|---:|---|
| `test:core` | 74 | 包含 core/storage/docs/git/ops/contract 及 client-races，不等于纯 core 单测 |
| `test:host` | 7 | 另有前置脚本 host-preflight，不算 `.test.mjs` |
| `test:unit:client` | 6 | 通配符实际展开数 |
| **合计** | **87** | tracked=87、wired=87、漏接=0、重复接线=0 |

| 目录模块 | 文件数 | 静态 `test()` 调用点 |
|---|---:|---:|
| core | 20 | 208 |
| storage | 8 | 29 |
| docs | 19 | 183 |
| git | 5 | 32 |
| host | 4 | 10 |
| client（含 unit） | 7 | 126 |
| ops | 19 | 133 |
| contract | 5 | 32 |
| **合计** | **87** | **753** |

静态调用点使用 [check-test-docs](<../../scripts/check-test-docs.mjs>) 的 `checkSource().testCount` 计算，含 skip/todo 的注册语法、不展开循环；不是运行后的测试数量。顶层直接断言脚本也算一个测试文件，但可能没有任何 `test()`。全目录 checker 统计为 **96 个入口文件、789 个静态调用点**，还包括下面的非 `.test.mjs` 入口，不能与 87/753 混用。

范围补足：

- 客户端装配冒烟由 `test:client` 运行，执行出货 bundle 的离线 React/存储替身断言；依赖构建产物，不是浏览器验收。
- [host-preflight](<../../test/host/host-preflight.mjs>) 由 `test:host` 先跑，验证延迟 webServer 注入、五工具及 token，依赖 peer、合成 ctx 和 50ms 等待。
- [core matrix launcher](<../../test/core/core-matrix.test.mjs>) 启动 [状态矩阵](<../../test/matrix/core-matrix.mjs>)、[边界矩阵](<../../test/matrix/core-boundaries.mjs>)、[生命周期矩阵](<../../test/matrix/core-lifecycle.mjs>)，子入口不能因不匹配 `.test.mjs` 而从覆盖率分母消失。
- [fault launcher](<../../test/storage/store-faults.test.mjs>) 启动 [store-faults worker](<../../test/faults/store-faults.mjs>)、[framing worker](<../../test/faults/framing.mjs>)；后者相关冷重放使用 [cold-replay](<../../test/faults/cold-replay.mjs>)。[salvage launcher](<../../test/storage/salvage-log.test.mjs>) 启动 [prefix worker](<../../test/salvage/prefix.mjs>)。worker 与 launcher 保持成组、只从隔离入口运行。

## 2. 表格读法与共享依赖

每个文件一行，固定五类信息：规则、顺序/副作用、外部入口、HOME/store、手工前置；最后给出主处置及理由。没有列出的真实数据能力不得由“测试已通过”推导出来。

**主处置：** A＝**显式 fixture/断言/文档**（保留公共门禁，把假设显式化）；B＝**替换为 tracked 入口**；C＝**移出公共门禁**（本地/opt-in 的宿主能力组，合成纯逻辑部分仍可保留）。C 不是删除测试，也不撤销发布前宿主门禁。

**环境记号：**

- **S**：显式临时 board/workspace 或纯内存合成对象；未主动读真实 HOME/profile/store。多数 `mkdtemp(os.tmpdir())` 仍使用调用者的系统 TEMP/TMP/TMPDIR，**不等于已经隔离所有环境变量**。
- **I**：子进程由白名单环境重建 HOME/USERPROFILE/DSH/APPDATA/XDG/npm/TEMP 等；调用者只提供临时隔离根。参见 [matrix fixture](<../../test/helpers/core-matrix-fixture.mjs>)、[fault isolation](<../../test/helpers/fault-isolation.mjs>)，两套白名单并不完全相同。
- **G**：系统 Git；测试生成本地仓库，不访问远端。除显式隔离段外，fixture 的裸 Git 可能继承用户全局配置/系统配置、PATH、签名或属性设置；不能把“仓库是临时的”说成“真实 HOME 完全不可达”。
- **F**：[fixed-fixture](<../../test/helpers/fixed-fixture.mjs>)，创建 Git 仓库、提交、禁 hooks、配置作者与 autocrlf；`bootstrapPin` 通过 create→claim→begin→submit 建来源。必须区分“已 bootstrap”与“首次只读”。
- **P**：可导入的 DSH peer（不意味着要启动真实 DSH）；**L**：平台链接能力；**T**：当前 Node 子进程/worker 能力。开发工具依赖不是产品运行时依赖。

所有测试至少要求[包声明](<../../package.json#L13-L15>)的 Node >=22；涉及 permission、mock timers、worker_threads 的组另做能力预检。当前宿主的 Node 要求另见[安装隔离说明](<../TEST-ENV.md#5-安装渠道的真实宿主验证>)，不要用 core 的最低版本代替宿主支持矩阵。下表“无”指无额外人工准备，不要求先人工 seed；seed 均由 fixture 内部完成。

## 3. core（20）

| 文件 | 业务规则/隐式假设 | 顺序与副作用 | 外部入口 | HOME/store | 手工前置 | 主处置与理由 |
|---|---|---|---|---|---|---|
| [alias-guard](<../../test/core/alias-guard.test.mjs>) | handle/store 必须是同一状态对象；拒绝不涨 rev | init→create→commit/reject；人为克隆后恢复原引用再 close；临时树清理 | 直接 core handle/service | S | 无 | A：保留对象身份及拒绝零写断言，fixture 负责恢复别名 |
| [archived](<../../test/core/archived.test.mjs>) | 归档阻断活工作；暂停/active 重设不清租约；解归档恢复原子 | attach→manual policy→publish→claim/begin→结清→archive；读日志大小；部分仅成功路径 close | core service；特权内嵌 fixture | S，临时目录有残留风险 | 无 | A：显式 active/paused/archived 和有无 intent fixture；失败也 close |
| [clock-ttl](<../../test/core/clock-ttl.test.mjs>) | TTL 与 grace 不同，过宽限才回收；touch 从当前时刻延长 | 固定 START→claim→tick→claim/touch；精确事件顺序；close | core service 注入 clock | S | 无，不等真实 TTL | A：时钟/边界常量显式，不能换真实等待 |
| [core-matrix](<../../test/core/core-matrix.test.mjs>) | 公共门禁必须实际执行全部三个 R3 worker | 创建隔离根→最小 env→Node --test→校验 error/signal/status→finally 清理；120s 预算 | 三个 matrix worker、matrix fixture | I | T | A：保留 launcher+worker+oracle 整组及环境断言，拆分不直跑 worker |
| 原 core 单文件 | 任务/计划/证据/发现/日志主契约混合；submit 只到 review；human verify 才解依赖 | setup 特权内嵌；大量 create/attach/claim/begin/submit/reopen 链；直接改 state/log/snapshot；同 cmdId 去重；链接反例；多处结尾 close 非 finally | core service/store/model/fsck；[legacy 签名 fixture](<../../test/fixtures/legacy-execution.mjs>) | S；不依赖真实 execution key；临时树/锁需收口 | L（junction 场景） | A：先抽 teardown/命令链，再按任务、计划、读模型、重放分组；保留少量端到端主链 |
| [delivery](<../../test/core/delivery.test.mjs>) | actor/session/cmd 尾码、时间线最多5条、verified最多3条、文本不可伪造规则块 | 纯对象渲染＋临时 handle 写 checkpoint 后重复 digest；close | core digest、host tools/shared（纯渲染，无 peer） | S | 无 | A：精确快照是输出契约，纯渲染与持久 checkpoint 分开 |
| [digest](<../../test/core/digest.test.mjs>) | 控制字符展平、长度封顶、includeRules 只裁尾；数据不能冒充规则 | 发布危险标题→重复摘要→计数/长度断言；close | core digest/service | S | 无 | A：保留负载反例，字符串常量改动要声明契约原因 |
| [fsck-intents](<../../test/core/fsck-intents.test.mjs>) | I6/I22、owner/intent/work 引用与归档活工作不变量；只读不修复 | 冻结/克隆状态→checkState；合法历史命令→close→追加合成升级→冷开；对比日志字节 | core fsck/model/store/service | S | 无 | A：纯诊断与磁盘历史兼容分组，拒绝必须同时比较 state/log |
| [handle-lifecycle](<../../test/core/handle-lifecycle.test.mjs>) | 同根多 service 共享实例且最后引用才释放锁 | A create→B open→A close→B 仍写→B close；手动 close 后重开缓存 | service/handle 全局共享缓存 | S；多个 service 必须全部关闭，setup 的 B 也要收尾 | 无 | A：显式共享句柄 fixture+统一 finally，不把“冷开”与缓存重用混淆 |
| [identity-conflicts](<../../test/core/identity-conflicts.test.mjs>) | copied marker 要 connect/fork；import/relocate 不覆盖历史；未知 genesis 不重建身份 | 快照日志/marker/registry→拒绝比对；注入写失败、append 窗口；启动子进程争同根；链接反例 | identity ops、[identity-create-child](<../../test/fixtures/identity-create-child.mjs>) | S，导入源也是合成 store | T、L | A：按冲突/导入/原子创建拆组；共享 registry race harness 先抽 |
| [identity](<../../test/core/identity.test.mjs>) | 随机稳定 ID、旧路径哈希兼容、worktree 归主项目；磁盘绑定新鲜度 | 造 legacy log→显式迁移/搬迁→close/reopen；临时 Git 主树/worktree；不自动写 marker | identity discover/ops/registry、G | S＋G 配置继承 | Git worktree 能力 | A：身份纯规则与 Git 发现分层，保留旧 schema 原字节 fixture |
| [intent-settlement](<../../test/core/intent-settlement.test.mjs>) | open intent 退出须 stopped+sideEffects；unknown 只能 interrupt→reconcile | attach/manual/publish→claim/begin→退出/恢复；读 log/rev/lease；旧 token 不能复用 | core service | S；sideEffects 仅记录，不实际执行 | 无 | A：统一 stopped/unknown fixture；每种拒绝显式比较零副作用 |
| [lease-reclaim](<../../test/core/lease-reclaim.test.mjs>) | 回收投影不能被旧快照覆盖；过期 owner 恢复例外；失败零写 | 双会话、注入 clock→lapse→update/interrupt/reconcile；克隆 state/lease/log；直接设 manual | core service、host fail 纯函数 | S；模块 serial 共享但非业务顺序 | 无 | A：过期时钟/owner/intent 组合显式化，保持 snapshot oracle |
| [lease-renew](<../../test/core/lease-renew.test.mjs>) | renew/touch 内存续期不提交，无进展封顶，进展重置，epoch/session 隔离 | claim→tick→renew/touch/begin→计数/owner/log 对照；close | core service 注入 clock | S | 无 | A：续租计数与截止时间 fixture 独立，禁止真实心跳替代 |
| [lock-race](<../../test/core/lock-race.test.mjs>) | 多进程最多单 writer；死锁接管、claim 替换和异主机拒抢 | 子进程报告屏障→同时 open→释放；临时伪锁；全局替换 fs.renameSync 后 finally 恢复；kill/await 子进程 | [lock-child](<../../test/fixtures/lock-child.mjs>)、JsonlStore | S | T、进程存活探测 | A：保持真实竞态组，独立进程并显式屏障；不可同进程并发 monkey patch |
| [lock](<../../test/core/lock.test.mjs>) | 活 PID 不抢锁、死 PID 可接管、nonce 防误删，失锁拒绝 append | seed→close→forgeLock→open；创建活/死 Node PID；20ms heartbeat＋150ms 等待；活子进程 finally kill | JsonlStore、T | S，系统 hostname/PID/时钟真实观测 | T；计时预算 | A：真实定时器与纯锁规则分组；补 finally close/等待退出，不能硬编码活 PID |
| [plan-acceptance](<../../test/core/plan-acceptance.test.mjs>) | 计划物化任务必有验收点；修订省略/更新空列表保留要求 | publish 正反例→revise 或 claim/update→比 acceptance；close | core service | S | 无 | A：小而内聚，保持文件，显式 omitted/empty 区别 |
| [plan-concurrency](<../../test/core/plan-concurrency.test.mjs>) | 多计划独立 CAS、归属/孤儿、focus human-only；摘要确定 | 双计划交错 revise/adopt/release/focus/archive→比较 sibling→close/reopen | core service | S；并发是命令交错，不是真多进程 | 无 | A：维持交互组，不能拆散前后状态使独立版本断言失效 |
| [restart-expiry-audit](<../../test/core/restart-expiry-audit.test.mjs>) | 冷开 owner 清理必须与 interrupted/readied 同提交记 lease/expired；归档延迟恢复 | attach 双会话→claim/begin→完整 close→新 service open→检查日志；解归档再恢复 | core service、JSONL | S | 无 | A：冷开 fixture 必须断言旧 handle/锁已释放；不能改成同缓存 open |
| [state-machine](<../../test/core/state-machine.test.mjs>) | 终态不可编辑、依赖不能成环、stale 不泄漏过期事件、计划不得引外来 taskId | fresh→合法前置→非法命令→比较旧字段/rev/events；手工调 lease.expiresAt | core service | S；部分用 Date.now 合成过期 | 无 | A：保留拒绝原子性，过期注入统一时钟 |

## 4. storage（8）

| 文件 | 业务规则/隐式假设 | 顺序与副作用 | 外部入口 | HOME/store | 手工前置 | 主处置与理由 |
|---|---|---|---|---|---|---|
| [commit-boundary](<../../test/storage/commit-boundary.test.mjs>) | WAL 持久化后 meta/快照失败不能报回滚或创建第二项目 | 备份 meta→用目录占位阻写→relocate/commit→close→恢复旧 meta→冷开自愈；finally 还原占位 | core service/store | S | 无 | A：保持持久化边界场景整体，统一故障/还原 fixture |
| [event-compat](<../../test/storage/event-compat.test.mjs>) | applied/additive/migration/refuse 分类；未知事件即使被快照覆盖仍拒绝 | 合成链/注册表→memory/disk replay；比较拒绝前后 bytes/lock/tmp；finally 清临时树 | shared events、store format/model | S | 无 | A：纯分类与磁盘拒绝分组，保留未知事件 fail-closed |
| [migration-replay](<../../test/storage/migration-replay.test.mjs>) | store 复制重放事实一致，源只读；快照 focus 单独比较 | 先 hash→copy→无锁打开→再 hash；真实分支可由 env/argv 激活 | service/JsonlStore；PB_MIGRATION_PROJECT/DIR/ROOT | S 默认；**继承 opt-in 时会查真实 os.homedir 默认 store** | 真实数据另授权，默认不得 seed 真实数据 | A：保留合成复制；真实分支 C 移显式 opt-in；公共 launcher 清空并断言所有迁移变量 |
| [repair-log](<../../test/storage/repair-log.test.mjs>) | 分叉默认保尾/显式保头；连续哈希损坏、非 genesis、空链不得猜修 | 构造两分支→planRepair/checkChain；不写磁盘 | core repair/store | 纯内存 | 无 | A：纯算法小组保持，计划与执行修复不要混算 |
| [replay-snapshot](<../../test/storage/replay-snapshot.test.mjs>) | 缺 planHeads/currentPlans 的合法快照须规范化并重放尾部 | publish/draft→close→手写 seq2 快照→冷开验证 rev3 与 draft head | service/model | S | 无 | A：保留快照锚点与尾事件一组，显式兼容 fixture |
| [salvage-log](<../../test/storage/salvage-log.test.mjs>) | 修复 worker 只能运行在合成隔离环境 | 临时根→I env→prefix worker→断言 status；launcher 未回收根，保留输出 | fault-isolation、prefix worker | I；留临时故障材料 | T | A：launcher/worker 同组，明确保留/清理策略及子测试覆盖采集 |
| [store-faults](<../../test/storage/store-faults.test.mjs>) | 磁盘/framing 故障只在隔离 fixture 中执行 | 临时根→I env→两个 worker→检查 error/status；120s/4MiB 预算；根保留 | fault-isolation、fault workers | I | T | A：维持故障隔离组，单独报 worker 断言数与故障命中率 |
| [stores-replay](<../../test/storage/stores-replay.test.mjs>) | 数据 hash 排除锁/心跳/快照；日志实体数防丢投影；gate 不比 baseline | 合成 project→close→CLI --root/--baseline --update→污染 baseline→compare 红→gate 绿；finally 清理 | [stores-replay CLI](<../../scripts/stores-replay.mjs>) | S；这里显式 root/baseline，**不等于裸 test:stores 安全** | T，无真实 seed | A：保留合成 CLI 流程；默认 HOME 风险另设公共 runner 断言 |

## 5. docs（19）

| 文件 | 业务规则/隐式假设 | 顺序与副作用 | 外部入口 | HOME/store | 手工前置 | 主处置与理由 |
|---|---|---|---|---|---|---|
| [doc-external-compat](<../../test/docs/doc-external-compat.test.mjs>) | 新事件 applied；旧读者/坏结构/伪快照 fail-closed；历史 inline links 兼容 | 合成链→snapshot/strict-prefix→开失败零写；生成真实格式日志；末组 Git 状态变化 | events/store/repair/fsck、G | S＋G 配置继承 | Git 缺失用例 skip | A：纯重放兼容与 Git 观测拆开；记录 skip 能力缺口 |
| [doc-external-edges](<../../test/docs/doc-external-edges.test.mjs>) | 跨 service 绑定以磁盘为准；confirm 上下文不能复用；filter 不执行 | prime cache→另一 service unbind/bind→inspect；readFileSync 钩子改文件后 finally 恢复；G filter 标记 | external-observe/git、identity ops、G | S＋G | Git filter 场景可 skip | A：绑定/读竞态与 Git 转换边界分组；同进程 patch 串行 |
| [doc-external-routes](<../../test/docs/doc-external-routes.test.mjs>) | 外置 HTTP 状态/鉴权/schema；坏请求不得冷开恢复 | 先 seed 冷任务和 inline→close→apply/等30ms→注入 token→loopback→顺序 rev1..5；finally 关 server/dispose/清树 | P、HTTP fetch | S；合成 token，非真实 DSH URL | P＋回环监听 | C：宿主适配能力组；先抽独立 cold seed/HTTP harness 再按协议拆场景 |
| [doc-external-tools](<../../test/docs/doc-external-tools.test.mjs>) | 工具白名单/CAS、外置无 body hash、诊断与 metadata-only | 特权 seed inline→close→apply/等30ms→publish→register/inspect/confirm/relocate/unregister；复用 docId/metaRev；finally dispose | P、core seed | S | P | C：本地 host gate 保留；拆场景前每例独立 seed，不能跨 test 共享 rev 链 |
| [doc-external](<../../test/docs/doc-external.test.mjs>) | 登记只元数据；管理状态/CAS、基线上下文、30s 观测缓存；cwd 不换证据根 | 注入 clock＋inline privilege；register→inspect→edit→confirm；比较 workspace tree/blob；绑定变更；一些 setup 不 close | service、external-observe、identity ops | S | L，不能链接可 skip | A：生命周期/定位/缓存三组，统一 fixture 所有权与 teardown |
| [doc-fixed-auto](<../../test/docs/doc-fixed-auto.test.mjs>) | 干净 Git 文档自动 pinned；能力不足 current-only 带理由；审批/屏障/证据同提交 | F→register→claim/begin/submit 或 reconcile；PATH 暂隐藏；严格事件排序；旧读者拒绝；close | F、core fixed/evidence | S＋G；临时 PATH 修改 finally 还原 | G | A：自动固定与降级矩阵一起保留，显式首次固定/后续复用及事件原子性 |
| [doc-fixed-edges](<../../test/docs/doc-fixed-edges.test.mjs>) | 首条 fixed 须同提交屏障；历史对象不回退当前文件、不自动 fetch；预览/属性只读 | F bootstrap→篡改快照/记录；临时挪 blob→finally 放回；本地 promisor 副本；CRLF/过滤器反例 | F、fixed-reference/content/git/worktree | S＋G；无外网需求 | G | A：对象缺失、事件结构、预览分组，但历史行+屏障保持成对 |
| [doc-fixed-evidence](<../../test/docs/doc-fixed-evidence.test.mjs>) | fixed 不能自报；来源迁移同源认领；无来源首次只读也应成功；历史固定可重放 | 普通 setup bootstrap，但 freshProject 专测首次读；moveMain→rebindDocs；替换 spawnSync+同步 ESM 后恢复；日志零写 | F、fixed-content/evidence/store | S＋G | G；故障执行边界由 fixture 替换 | A：先分清 bootstrapped/fresh/read-only fixture，防辅助引导遮蔽首次使用缺口 |
| [doc-fixed-git](<../../test/docs/doc-fixed-git.test.mjs>) | SHA1/SHA256 身份、clean path、EOL、属性/filter/LFS/textconv 不执行 | F 提交→修改属性/本地配置；withGlobalConfig 临时替 HOME/USERPROFILE/GIT_CONFIG_* 后 finally 还原 | F、fixed-git/worktree | S；局部临时 HOME，**不是全文件全局配置隔离** | 支持 SHA256 的 G | A：Git 真实集成单独能力组；配置替换串行，显式所有 config 域 |
| [doc-fixed-head-race](<../../test/docs/doc-fixed-head-race.test.mjs>) | HEAD A→clean B 必须 head-changed，不可混配；最后 filemode 后仍复核 | F 建 A/B→替换 cp.spawnSync→syncBuiltinESMExports→auto/submit/reconcile→t.after 恢复 | F、child_process 全局 seam | S＋G | G | A：保留确定性竞态，独立文件进程；不与其他全局 patch 用例并发 |
| [doc-fixed-surfaces](<../../test/docs/doc-fixed-surfaces.test.mjs>) | get_fixed 只读；工具自动证据；HTTP 坏引用开项前拒绝 | 动态 import P；setup 同时注册 tools/routes、F bootstrap；两例都依赖 registerTools；service close | P、F、内存 Readable HTTP | S＋G；缺 peer 时两例 t.skip | P＋G | C：从 core 能力组迁 host；HTTP 纯部分可先解耦工具 setup，避免无 peer 连 HTTP 也零覆盖 |
| [doc-inline-write-boundaries](<../../test/docs/doc-inline-write-boundaries.test.mjs>) | 被拒 inline put/link 不得先 create/open，合法 board 读才可触发冷恢复 | seed claim→close→apply/等30ms→坏请求→只读重放比较；valid board 为恢复对照；disposer 未统一收尾 | P、service/replay | S | P | C：host 入口副作用门；显式 pre-open 拒绝与 valid-open 两套 fixture |
| [doc-inline-write-policy](<../../test/docs/doc-inline-write-policy.test.mjs>) | 默认 archive-only；仅 human+授权+rev 可开写；fixture 特权不属于外部入口 | setup 默认禁写/特权 seed→比树 hash+mtime→命令/内存 HTTP；暂设 PROJECT_BOARD_INLINE_WRITES 验证无效并 finally 还原；多例缺 close | commandsRoute、service（无 peer） | S | 无 | A：纯 policy 留公共门禁；默认/授权/fixture 三构造明确区分 |
| [doc-migration-write](<../../test/docs/doc-migration-write.test.mjs>) | D6 metadata-only、历史档案不可变；授权/可恢复备份；WAL 失败零部分写、可续跑 | 特权 seed 多 rev→copy backup→restoreTested→mapping→migrate；注入 blob/append 失败→冷开；CLI 显式 store；t.after close/清树 | [doc-migration CLI](<../../scripts/doc-migration.mjs>)、migration/backup/archive、stores scan | S；“授权”是合成参数，不是生产授权 | T | A：备份/WAL/档案兼容分组；backup 构造先验证不可变哈希域 |
| [doc-migration](<../../test/docs/doc-migration.test.mjs>) | 盘点所有历史字节/链接/证据；缺 blob 明示；默认 CLI 合成、真实读取需授权 | migrationFixture→inventory/export→损坏 blob/冲突目标；未换行 log；树哈希/mtime；CLI cwd 为仓库 | [migration fixture](<../../lib/core/documents/migration-fixture.js>)、doc-migration CLI | S，无真实 store 参数 | T；从仓库 cwd 启动 | A：纯 inventory 与磁盘/CLI 拆组，显式 cwd，保留原始字节不套预览解码 |
| [doc-read](<../../test/docs/doc-read.test.mjs>) | 16MiB/256KiB 上限、原字节 hash、严格 UTF8、路径/ADS/链接拒绝；读不写 | 临时文件＋每次调用注入 io；两次 stat/根变化/替换；检查句柄关闭、完整字符截断 | locate/read/evidence hash（无 peer/Git） | S；io 多为局部对象不是全局 fs patch | L，可 skip | A：安全定位、读取竞态、预览三组；保留共用错误表与反例，不放宽链接边界 |
| [evidence-audit](<../../test/docs/evidence-audit.test.mjs>) | 材料不自动执行/判真；跨 attempt supersede；doc@rev 历史、bare doc 跟 head；漂移人类可处理 | 特权 seed/claim/begin/submit→edit/reject/reopen→audit/verify；人工 refresh/waive；大量顺序命令与直接 blob 修改 | evidence/service、legacy 签名 fixture | S，无真实签名 key | 无 | A：材料、覆盖/替代、漂移人审、历史 doc 四组；先抽 task/review/attempt fixture |
| [evidence-restart](<../../test/docs/evidence-restart.test.mjs>) | 历史 signed/auto 记录不改写；新 attempt 仍 manual；坏/缺 key 不修写 | 手造历史 commit→close→冷重放子进程→比较历史 hash、execution.key→新 submit | [evidence-restart-child](<../../test/fixtures/evidence-restart-child.mjs>)、legacy 签名 | S；execution.key 是合成根内文件，非真实 key | T | A：保持旧记录＋新工作对照，显式无锁/冷进程边界与 key 不存在断言 |
| [evidence-runner](<../../test/docs/evidence-runner.test.mjs>) | command/test/note/url 是材料、execution 清空、不会跑 ref；requiredKinds 不匹配原子拒绝 | setup→claim/begin→submit/reconcile；恶意命令字符串对应 marker 必须不存在；finally close | core evidence/service；无实际 runner | S | 无 | A：保留不执行反例，小型参数矩阵无需按 kind 拆碎 |

## 6. git（5）

| 文件 | 业务规则/隐式假设 | 顺序与副作用 | 外部入口 | HOME/store | 手工前置 | 主处置与理由 |
|---|---|---|---|---|---|---|
| [git-config-parse](<../../test/git/git-config-parse.test.mjs>) | separate-git-dir 的 owner 必须由完整配置解析；未知 owner 执行前拒绝 | G 建 separate/linked→植入陷阱→追加 config（last-value）→findRepository/CLI dry-run→marker 不存在 | tracked [release-tag CLI](<../../scripts/release-tag.mjs>)、[fake-git.exe](<../../test/fixtures/fake-git/fake-git.exe>)、F | S＋G；PATH/env 传给子进程 | G，Windows 执行 tracked exe；POSIX shell trap | A：配置解析与 CLI 集成可拆；无私有 wt 依赖需要替换 |
| [git-exec-repo-root](<../../test/git/git-exec-repo-root.test.mjs>) | 子目录、gitfile/commondir/别名必须枚举所有禁止执行根 | 先可信 cwd 跑 G→plant→污染 PATH→发现/CLI→marker；链接不支持 skip；cache reset | tracked release-tag、test-env lifecycle versionInfo、fake-git.exe、F | S＋G；真实运行仓库只定位，不读 board | G＋L | A：根拓扑 fixture 先抽，保留 fake control 与安全调用成对 |
| [git-exec-surface](<../../test/git/git-exec-surface.test.mjs>) | 点前缀不是越界；junction/8.3 等价；缓存必须复核允许根 | withPath→reset cache→resolve→finally 恢复；shortAlias 来自 raw TEMP/realpath 差异；CLI dry-run | tracked release-tag、versionInfo、fake-git.exe、F | S＋G；实际 TEMP 拼写影响覆盖 | G＋L；Windows 8.3 不可用 skip | A：平台能力分层记录 skip；禁止把别名组未执行算安全覆盖 |
| [git-exec](<../../test/git/git-exec.test.mjs>) | 只用 workspace/运行仓库外绝对可信 Git；无候选 fail；缓存可复用 | poison PATH/PB_GIT_MARKER→control 真触发→fixed/observe/discover 不触发→finally env/cache restore | F、fake-git.exe、Git resolver | S＋G；PATH/模块缓存全局修改 | G；POSIX 可执行脚本或 Windows exe | A：进程隔离保留；控制陷阱有效性和不执行断言不可拆丢 |
| [gitattributes-eol](<../../test/git/gitattributes-eol.test.mjs>) | 原字节是文档身份；autocrlf=true 也应按 LF；二进制豁免 | 读 tracked [.gitattributes](<../../.gitattributes>)→临时 G 配置→commit LF→改文件→checkout→比 hash；无规则 CRLF 对照 | G，无远端 | S＋G 配置继承 | G | A：保持正例/无规则反例，属性解析与字节结果同时验收 |

## 7. host（4；其余三个 host wired 文件在 docs 表）

| 文件 | 业务规则/隐式假设 | 顺序与副作用 | 外部入口 | HOME/store | 手工前置 | 主处置与理由 |
|---|---|---|---|---|---|---|
| [host-audit](<../../test/host/host-audit.test.mjs>) | bundle/D6 路径、audit 载荷/身份、raw intake 早拒绝、Prompt 字面不插值 | discoverHost 读安装 manifest；安装子进程临时 HOME/DSH；自定义 profile 安装/卸载；合成 runtime；真实 peer Prompt 组装 | P app-boot/home-paths、[install CLI](<../../scripts/install.mjs>)、T | 安装写入合成 profile；**宿主发现读取本机安装与 PATH**；子 env 为 spread，非全白名单 | P＋L；本机 DSH 包完整，不需服务运行 | C：拆纯翻译到公共组，真实宿主装配/发现留显式 host gate，补 env 白名单 |
| [host-tools](<../../test/host/host-tools.test.mjs>) | 工具任务主链、计划 CAS/归档、历史文档读、错误/摘要去重与审计接线 | 特权 seed→close→apply/等30ms→共享 ctx/tools/eventHandlers 顺序操作；按 rev/会话记忆去重；finally dispose/清树 | P、service seed | S，临时 artifact；无真实 profile | P | C：先抽 boot+ready+dispose，再按 task/plan/doc/session 分组，保留端到端主链 |
| [identity-host](<../../test/host/identity-host.test.mjs>) | main/linked cwd 共项目；证据必须 main 根；copied marker 给可操作拒绝 | G 创建主树/worktree→apply/等30ms→init→发布/提交；host helper 不统一 dispose | P、G | S＋G；不读真实工作区 | P＋G | C：host 身份组保持；先补句柄/临时 Git 树收尾再并行 |
| [routes](<../../test/host/routes.test.mjs>) | HTTP 鉴权/origin/path/body/error 映射；多计划 CAS，foreign lock 只读 | apply/等30ms→inject token→回环 listen(0)→顺序 create/commands/reads；伪 foreign lock；finally server.close/dispose/清树 | P、HTTP fetch、host util | S，合成 token/store；非主实例 | P＋回环监听 | C：鉴权/输入/领域表面拆组；冷开/锁反例不得为省 setup 共用状态 |

## 8. client（7）

| 文件 | 业务规则/隐式假设 | 顺序与副作用 | 外部入口 | HOME/store | 手工前置 | 主处置与理由 |
|---|---|---|---|---|---|---|
| [client-races](<../../test/client/client-races.test.mjs>) | 最新请求栅栏、退避封顶、drawer key、stop 后不发布迟到数据 | 受控 Promise→reload→stop→resolve；transport 源码 regex；AbortController | [transport](<../../src/client/api/transport.ts>) 及纯模块 | 纯对象，无网络/storage | 无 | A：保持纯竞态小组；源码 regex 只算接线不算 transport 行为覆盖 |
| [doc-view](<../../test/client/unit/doc-view.test.mjs>) | 四维信息选择、单提醒、分组/筛选、确认入口、技术字段不能丢 | 固定 NOW/合成 record/view→纯 selector→精确 labels/tone/sections；日期格式局部宽匹配 | [doc-view](<../../src/client/model/doc-view.ts>) | 纯对象，无 localStorage/HOME | 无 | A：显示契约保持一组；日期时区预期显式，不以文本测试代替视觉 |
| [external-docs](<../../test/client/unit/external-docs.test.mjs>) | schema fail-closed、草稿旧 rev 不偷换、confirm hash/截断确认失效、tombstone 优先 | 纯载荷/selector＋两段 esbuild hook runner；data URL import；global fetch/config/hookStore 修改后清理；20ms flush | tools/build esbuild、真实源模块、React stub | 合成全局；无真实网络/HOME；部分清理 delete 而非恢复先前值 | esbuild 缺失两 hook 用例真实 skip | A：纯逻辑与 hook 集成拆开；公共 hook 门禁应预检工具链，恢复全局旧值 |
| [logic](<../../test/client/unit/logic.test.mjs>) | Markdown/安全链接、chart/flow 几何、筛选/分组、载荷/计划编辑保持验收要求 | 直接 import 真实 ES 模块，合成输入；不读真实 localStorage；多个无关职责合并 | src/client 纯模块 | 纯对象，无 DOM/网络/HOME | 无 | A：按渲染解析、任务选择器、载荷、计划编辑拆组；正反例与安全规则保持同组 |
| [page-lifecycle](<../../test/client/unit/page-lifecycle.test.mjs>) | 读合并/写后尾读、stop/认证失败不误成功，项目定位与 reload 确认 | fake EventTarget/timer/Promise；flush 微任务；替 global fetch/config；page-access 单例跨调用；t.after 恢复 | source transport/page-read/location/access、host auth 纯函数 | 合成对象；不请求真实服务 | 无 | A：读取状态机与认证状态分组；先抽单例 reset、全局 restore，不开启同进程并发 |
| [page-navigation](<../../test/client/unit/page-navigation.test.mjs>) | 未确认导航保留嵌套草稿；迟到写完成不得跨编辑 scope | 读 bundle→new Function 注入 fake React/fetch/timer→hook 顺序及 key 实例→写后 resolve/replay/unmount；t.after stop | [出货 bundle](<../../lib/client.js>)、本地 hook runner | 全合成，无 DOM/network/storage | 需要与源码一致的 bundle；构建后再验 | A：保持导航/写完成交互组；hook runner 共享须先有自身回归，不能当真实 React 调度证明 |
| [page-wiring](<../../test/client/unit/page-wiring.test.mjs>) | 慢/失败不成空成功、项目身份/认证恢复不清草稿；迟到响应栅栏 | bundle fake runner→render/effect/settle(30微任务)→手控响应/会话事件→replay/stop | 出货 bundle、fake React/transport | 全合成，无真实服务 | bundle 需先构建 | A：与 navigation 共用能力明示，保留页面装配覆盖而非改纯函数 mock |

## 9. ops（19）

| 文件 | 业务规则/隐式假设 | 顺序与副作用 | 外部入口 | HOME/store | 手工前置 | 主处置与理由 |
|---|---|---|---|---|---|---|
| [architecture-map](<../../test/ops/architecture-map.test.mjs>) | arch-map 路径可解析、无重复/遗漏、通配符有实物 | 读真实 map→构造缺文件/非法格式树→检查路径/最小规模→finally 清树 | [check-architecture](<../../scripts/check-architecture.mjs>)、[架构文档](<../ARCHITECTURE.md>) | S；只读当前源码 | 无 | A：规模下界只是哨兵，不能充当覆盖率；保持文档/解析反例 |
| [ci-config](<../../test/ops/ci-config.test.mjs>) | CI 必须硬门禁、离线 core/client、双平台 perf、构建零漂移；host 有缺 peer 说明 | 读取 CI YAML 和 package 文本 regex；不执行 workflow | [CI 工作流](<../../.github/workflows/ci.yml>) | 仓库只读，无 HOME/store | 无 | A：文本接线层独立；命令重排时显式更新匹配，不宣称 runner 已通过 |
| [client-build-tsx](<../../test/ops/client-build-tsx.test.mjs>) | 单 bundle/classic JSX、仅 React external、sourcemap CRLF 归一；单 entry 不覆盖产物 | Node build --entry/--outfile 临时输出→比 bundle/map；坏参数比 production 原字节；t.after 清理 | [build-client](<../../scripts/build-client.mjs>)、[TSX fixture](<../../test/fixtures/client-tsx/entry.tsx>)、tools/build | S；只读 production bundle | tools/build 依赖先安装/链接，T | A：构建工具链能力组，不跟纯 client 单测混同 |
| [client-layers](<../../test/ops/client-layers.test.mjs>) | import 方向、唯一 fetch、规模上限、legacy 豁免、TS/JSX 解析 fail | 大量合成源码树→checker→规则码；最后读当前仓库 migration 模式；t.after 清树 | [check-client-layers](<../../scripts/check-client-layers.mjs>)、tools/typescript AST | S＋当前源码只读 | **实际需要隔离 TypeScript**，测试头“仅 Node”不完整 | A：显式工具链预检并修说明；规则单测与真实树验收分组，豁免有名单不能因改路径静默消失 |
| [hermetic-gate](<../../test/ops/hermetic-gate.test.mjs>) | HEAD 干净树三 Git 回归不得依赖私有工具 | worktree add --detach HEAD→查私有 CLI 缺席→子回归→finally remove --force；失败 rm/prune | 系统 G、三个 tracked Git 回归 | 合成 checkout；**写当前仓库共享 Git worktree 元数据**；env 继承 | 候选先提交；T＋G；工作树内容必须已在 HEAD | A：高风险共享副作用；改显式 archive 导出或独立临时仓库，过渡串行且禁止全局 prune |
| [project-list-performance](<../../test/ops/project-list-performance.test.mjs>) | 热列表零正文 I/O；冷10MiB离线程、single-flight、缓存失效；全局 worker/队列预算 | 造700条 padding log→close/reopen；mock fs/Worker+sync ESM；fake timers；延迟 terminate；t.after 还原 | worker_threads、service project-list、projectsRoute | S；部分 service root=os.tmpdir，仅内部 replay 且未 init，非真实 board 扫描 | T；worker 与性能预算能力 | A：结构性零I/O与墙钟预算分层；全局池测试独立进程，先还原 mock 再收尾 |
| [prompt-health-isolation](<../../test/ops/prompt-health-isolation.test.mjs>) | brief 字面动态、零同步 I/O；深审计 single-flight/失效，不冒充即时健康 | F bootstrap 或 MemoryStore→mock fs/spawn/health→sync ESM→finally restore；真实隔离审计＋回环 HTTP/20ms timer/750ms预算 | F、installPrompt、healthRoute（不要求 peer） | S＋G；合成对象复制证据，不是生产规模样本 | G＋回环监听＋T | A：热路径结构断言与响应预算拆层，时间预算留串行环境，不能删安全断言求绿 |
| [recovery-drill](<../../test/ops/recovery-drill.test.mjs>) | 有界11场景全通过、备份存在、冷恢复继续业务；拒真实 root 参数 | I env→脚本子进程→读临时报告→比 pass/fail/skip/backups；wrapper root/材料留存 | [recovery-drill](<../../scripts/recovery-drill.mjs>)、fault isolation | I；报告在临时根，不是 .evidence 输入 | T，150s预算 | A：独立 R3 演练层；保持备份/冷恢复/继续业务整链，显式残留策略 |
| [release-purity](<../../test/ops/release-purity.test.mjs>) | 包白名单/身份字节/README链接、私密文本和 Git allowlist；不执行不可信 bundle | 读现有可信 bundle/LICENSE/package→合成恶意条目/代码→拒绝；比安全 Git 调用表 | [check-release-purity](<../../scripts/check-release-purity.mjs>)、Git args validator | 仓库只读；bin/private/.evidence 是拒绝样本，不执行/读取 | 当前 bundle 存在且匹配源码 | A：纯检查器保留；硬编码版本/路径是显式发布契约而非业务覆盖 |
| [release-readiness](<../../test/ops/release-readiness.test.mjs>) | 技术 ready 与 private 人工门分离；tar 类型/链接配对；JSON 错误可解析 | 合成 package→系统 tar 或手写 tar→CLI --tarball；fake npm failure；源码 README计数；t.after 清理 | release-readiness/check-release-purity、系统 tar | S；CLI spread env；无 registry 请求，假 npm 为合成文件 | tar（Windows 优先系统 tar.exe）＋T | A：纯 evaluator 与 tar/CLI 能力组分开；没有 tar 不应伪报包完整校验 |
| [release-tag](<../../test/ops/release-tag.test.mjs>) | tag 命名/compat/失败拒绝/消息；只在合成仓库操作 | 临时 G commit→dry-run→**stub gate 后真实创建合成 tag**；PB_RELEASE_GATE_CMD；finally 最多30s清树重试 | tracked release-tag CLI、G、shell gate | S＋G；继承 env；不触真实仓库 tag/remote | G＋T；platform shell | A：修头注释“仅dry-run”事实错误，保留临时 tag 行为；禁止对当前仓库执行此流程 |
| [scripts](<../../test/ops/scripts.test.mjs>) | Node permission 只读限制不许降级；安装所有权/幂等/备份/失败回滚；卸载保留数据 | permission 子进程拒写/拒spawn→合成 profile assemble/uninstall/fault→还原；missing host 显式 absent | install/guards、Node permission | S；discoverHost 此处仅显式不存在根，不扫真实宿主 | permission 标志可用、L＋T | A：权限边界与安装纯组拆开；无能力应红而不是跳过或裸跑 |
| [test-discovery](<../../test/ops/test-discovery.test.mjs>) | 每个 tracked 测试接线；私有 split path 禁执行；CI/strict/matrix 完整 | 读 package→git ls-files（失败目录回退）→源码路径构造检查；固定三个 matrix worker | G（可回退）、package、launchers | 当前仓库只读，无 board | 无；Git 回退需明确 | A：未来改 suite 先升级接线 oracle，覆盖通配符和非 test() 入口；private 字符串样本不是依赖 |
| [test-docs](<../../test/ops/test-docs.test.mjs>) | 四字段/责任行/skip/todo、词法忽略、非空扫；不能证明说明准确 | checker 扫 tracked→内存反例→无Git临时树回退→finally 清理 | check-test-docs、G可回退 | S＋源码只读 | 无 | A：保持 checker 正反例；统计取解析器，不拿责任行数量冒充断言数量 |
| [test-env-seed](<../../test/ops/test-env-seed.test.mjs>) | seed 幂等不重置历史；合成 audit 门；URL/JSON 注入不可跳生产源；busy 拒绝 | createEnvironment/prepare→seed→关闭后再 seed；合成生命周期锁；解析 opener/verifier，不开浏览器 | test-env environment、seed/open/verify helpers | S，显式 board；不启动或读取 DSH CLI | L；不需预先 seed、不启真实宿主 | A：注入合成 cliPath 消除潜在本机默认值；URL 纯逻辑与磁盘 seed 分组 |
| [test-env](<../../test/ops/test-env.test.mjs>) | owner/link 防伪、环境白名单、安全 stop/reset、锁互斥；不能按旧PID杀进程 | 临时假 CLI→prepare→mock child/control HTTP→run/status/stop→reset 轮换；server t.after关闭 | test-env environment/lifecycle、loopback、mock EventEmitter | S；env 注入合成 CLI，子进程 mock，不运行真实 DSH | L＋回环监听 | A：目录所有权/控制协议/生命周期拆组，保留端点身份与零误杀断言 |
| [test-typecheck](<../../test/ops/test-typecheck.test.mjs>) | helpers/fixtures 正例通过，故意类型错误必须使同编译器红 | typecheck-test 子进程→临时 bad.mjs --checkJs→检查诊断与非零→t.after 清理 | [typecheck-test](<../../scripts/typecheck-test.mjs>)、[测试 TS 配置](<../../tsconfig.test.json>)、tools/typescript | S，无真实 HOME/store/network | tools/typescript＋T，120s/60s预算 | A：保持正反例同组，不能只保留正例；不是全测试源码 strict 化 |
| [typescript-client-toolchain](<../../test/ops/typescript-client-toolchain.test.mjs>) | DOM/classic JSX/noEmit、无 Node ambient、props 类型错误拒绝 | 真实配置→临时 TSX/React shim→tsc 正反例→实际 client typecheck；t.after 清理 | tools/typescript、[typecheck-client](<../../scripts/typecheck-client.mjs>)、[client config](<../../tsconfig.client.json>) | S＋当前源码只读 | tools/typescript＋T | A：工具链组独立，noEmit/无jsx-runtime口径别与构建用例混算 |
| [typescript-toolchain](<../../test/ops/typescript-toolchain.test.mjs>) | 后端 JS/TS 共存/noEmit；base 不泄漏 DOM/Node；CI接线不增 runtime依赖 | require 隔离 TS→真实 config diagnostics→临时 JS/TS→故意 TS2322→CLI；t.after清理 | tools/typescript、[typecheck](<../../scripts/typecheck.mjs>)、[backend config](<../../tsconfig.backend.json>) | S＋源码只读 | TS/@types/node 安装或链接＋T | A：保持正反例和配置隔离；checkJs:false/strict:false 不能写成全库类型保证 |

## 10. contract（5）

| 文件 | 业务规则/隐式假设 | 顺序与副作用 | 外部入口 | HOME/store | 手工前置 | 主处置与理由 |
|---|---|---|---|---|---|---|
| [api-surface](<../../test/contract/api-surface.test.mjs>) | handle 公开成员、结果键及任务事件顺序冻结；失败 rev/log 不动 | create→claim→begin→签名材料→submit（只到 review）；精确 entityRev1/2/3；finally close/清树 | core service、legacy 签名 fixture | S，无真实 execution key | 无 | A：字面顺序/结果键是契约，不随拆分随意重排；签名仅兼容样本 |
| [contract-parity](<../../test/contract/contract-parity.test.mjs>) | shared/command registry/state 对象/labels/端点一致；own-key dispatch 防原型 | 顶层 import/源码读取/直接 assert；bundle var 名和排版 regex；无 test() | shared、commands、host源码、出货 bundle | 仓库只读，无真实 HOME | bundle先构建 | A：行为集合与源码接线分开报，bundler变量名不是领域契约，逐步换显式导出断言 |
| [gate-migration-v3](<../../test/contract/gate-migration-v3.test.mjs>) | v2拒绝→迁v3；备份/hash前缀/幂等/可续跑；历史 createdBy 不改 commit | 手造所有任务状态和 draft→dry-run→apply→close/replay；损坏备份/side file恢复；临时材料部分留存 | [migrate-gate-v3](<../../scripts/migrate-gate-v3.mjs>)、store format | S，无真实迁移源 | 无 | A：迁移数据安全组保持，不将“任务各状态都出现”当转移覆盖 |
| [review-governance](<../../test/contract/review-governance.test.mjs>) | agent独立性/历史生产者禁止自审；human兜底；scope冻结；schema3/intake拒绝 | worker/auditor/human fixture→claim/begin/submit/verify/reject；篡改历史/快照/scope；snapshot bytes/lease/blob；t.after close | audit/model/fsck/command-shape、Memory/JsonlStore | S；command ref 明确不执行，report 是自述 | 无 | A：按准入、独立性、不可变scope、兼容分组；保留跨尝试与人工兜底端到端场景 |
| [tool-schema-snapshot](<../../test/contract/tool-schema-snapshot.test.mjs>) | 工具名/描述/JSON schema 与 manifest 冻结 | dynamic import P；**缺 peer console SKIP＋process.exit(0)**；否则 apply/等30ms→排序比fixture→dispose | P、[tool-schema fixture](<../../test/fixtures/tool-schema.json>) | S；显式 stateDir，无真实 store | P；无 peer 当前当成功退出 | C：移 host/opt-in 并使用真实 skip/缺能力报告；离线CI不得把 exit0 当 schema 已验证 |

## 11. 风险与建议（优先级顺序）

### 11.1 假绿和能力缺口

1. **core 含宿主假绿。** [tool-schema-snapshot:24–32](<../../test/contract/tool-schema-snapshot.test.mjs#L24-L32>) 缺 `@deepseek-ai/*` 时打印 SKIP 并 exit0；[接线](<../../package.json#L22-L28>)使 `test:ci` 经过 `test:core` 把它当成功，而不是 schema 已执行，也不是 node:test 的真实 skip 统计。处置 **C**：迁到必须有 peer 的 host 套件或显式 opt-in；若保留降级入口，改用 `t.skip` 并输出缺能力清单，host preflight 必须在发布门失败而不是假绿。
2. **core 另有隐藏 peer 组。** [doc-fixed-surfaces:13–17](<../../test/docs/doc-fixed-surfaces.test.mjs#L13-L17>)可忽略缺 peer，且[两例都以 registerTools 为跳过条件](<../../test/docs/doc-fixed-surfaces.test.mjs#L49-L80>)，连 HTTP 只读边界也一并跳过。处置 **C**：先移宿主能力组；后续拆 setup，让不依赖 peer 的路由单测可独立执行。[external-docs:408–435](<../../test/client/unit/external-docs.test.mjs#L408-L435>)的 esbuild 缺失则是明确 skip；公共构建组应预检安装，不能把 hook 跳过算全 client 通过。处置 **A**。

### 11.2 真实 HOME/store、环境继承与平台前置

3. **环境变量能激活真实数据分支。** [migration-replay:149–181](<../../test/storage/migration-replay.test.mjs#L149-L181>)从 `PB_MIGRATION_PROJECT`、`PB_MIGRATION_DIR` 或 argv 取源，`PB_MIGRATION_ROOT` 缺省回落 `os.homedir()/.dsh/project-board`；原目录 hash+copy 虽不写源，仍然是未经当次授权的真实读取/复制风险。处置 **A（合成）＋C（真实分支）**：公共 runner 清空并断言三个变量和真实 argv，真实副本入口只 opt-in，显式 source+授权+一致性副本，不允许“继承了 env 就视为授权”。[裸 stores CLI 默认根](<../TEST-ENV.md#6-离线门禁与入口>)同样需隔离；不要因为 [stores-replay 测试:78–80](<../../test/storage/stores-replay.test.mjs#L78-L80>)传了临时 root 就推断 strict 默认安全。
4. **临时 repo 不等于 Git 配置隔离。** [F Git helper](<../../test/helpers/fixed-fixture.mjs#L17-L35>)禁 hooks 并设局部作者/autocrlf，但裸 Git 可继承真实 HOME/system/global config 与注入环境。[doc-fixed-git:15–30](<../../test/docs/doc-fixed-git.test.mjs#L15-L30>)只在局部测试暂换 HOME/USERPROFILE/GIT_CONFIG_*，不是全套件隔离。处置 **A**：先抽统一 trustedGit fixture/env，临时 HOME、明确 system/global config、清 NODE_OPTIONS/GIT 注入域、禁签名/网络与 hooks；特测“全局配置参与”时仅装合成全局配置。不可删除此类安全反例来回避平台差异。
5. **链接/8.3/Node/工具依赖会改变覆盖面。** [git-exec-surface:49–60](<../../test/git/git-exec-surface.test.mjs#L49-L60>)依赖 TEMP raw 与 realpath 的别名差异；[doc-read:127–141](<../../test/docs/doc-read.test.mjs#L127-L141>)链接权限不足跳过。SHA256 Git、系统 tar、Node permission、mock timers、隔离 TS/esbuild 都是开发门禁的明确能力，不是“零依赖产品”违规。处置 **A**：能力清单预检和分平台 skip 原因；可复现平台组保留本地/CI矩阵，不人工开启8.3或提权作为公共单测默认前置。非必需平台变体可 opt-in，但核心拒绝规则必须有确定性替身断言。

### 11.3 共享状态、调用顺序与清理

6. **干净门禁本身写共享 Git 元数据。** [hermetic-gate:25–39](<../../test/ops/hermetic-gate.test.mjs#L25-L39>)对当前仓库 worktree add/remove，异常路径还 prune。linked worktree 的 common Git 元数据被同仓库多个会话共享，不因独立 checkout 而隔离。且它只测试 HEAD，不测试未提交源码。处置 **A**：优先 `git archive HEAD` 临时导出（按需在临时导出内 init 合成仓库）；不能导出时串行独占、只收自己创建的元数据，不全局 prune。验收需证明 common Git 元数据前后未变及脏候选不被误覆盖。
7. **全局替换不允许随意同进程并行。** [Git PATH/cache 恢复](<../../test/git/git-exec.test.mjs#L37-L56>)、[HEAD race spawnSync+ESM](<../../test/docs/doc-fixed-head-race.test.mjs#L17-L26>)、[深审计 fs/spawn 补丁](<../../test/ops/prompt-health-isolation.test.mjs#L78-L97>)、[Worker 构造补丁](<../../test/ops/project-list-performance.test.mjs#L168-L184>)影响进程内其他用例；client 的 page-access、global fetch/config/hookStore 同理。处置 **A**：保持文件进程隔离或严格串行；共享 helper 必须保存/恢复存在性和原值，`delete` 不等于还原。teardown 同时 `mock.restoreAll()` 和 `syncBuiltinESMExports()`；超时/抛错也要恢复。
8. **setup/close/open 决定是否真的冷恢复；长脚本有顺序耦合。** [handle-lifecycle:22–30](<../../test/core/handle-lifecycle.test.mjs#L22-L30>)有两个 service，共享 handle；原 core 测试 setup开启 inline fixture 特权；[host-tools:41–56](<../../test/host/host-tools.test.mjs#L41-L56>)必须 seed close 后 apply；[外置工具:173–254](<../../test/docs/doc-external-tools.test.mjs#L173-L254>)依赖前次 metaRev 和路径变动。处置 **A**：先抽 dispose stack、task/review/cold-project fixtures，再拆用例；每例可独立运行/乱序，拒绝前后比较 state/rev/log/blob/lease，冷开前断言所有引用已关闭。小文件不因拆分目标强行拆开完整主链。
9. **时间/调度/产物是可见前置。** host 多文件固定等30/50ms；[schema等待](<../../test/contract/tool-schema-snapshot.test.mjs#L52-L54>)不保证慢机 ready；[锁心跳](<../../test/core/lock.test.mjs#L121-L131>)、[响应预算](<../../test/ops/prompt-health-isolation.test.mjs#L100-L133>)涉及墙钟；[page runner](<../../test/client/unit/page-navigation.test.mjs#L29-L31>)依赖出货 bundle 而非只测最新 source。处置 **A**：显式 await runtime.ready/事件屏障，注入逻辑 clock；真实 heartbeat/性能预算独立串行组；bundle 先构建再零 diff。不能把新源码＋旧 bundle 的绿当候选验证。
10. **头注释不能替代正文。** [release-tag 头:1–5](<../../test/ops/release-tag.test.mjs#L1-L5>)称仅 dry-run、不创建 tag，但[正文:145–158](<../../test/ops/release-tag.test.mjs#L145-L158>)确实用 stub gate 在**合成仓库**创建 tag 并验证消息。处置 **A**：修头注释/职责与副作用说明，保留这个有价值行为测试；不得删正文来让注释“正确”。这里只是盘点，没有运行创建 tag 的测试。类似“无前置”仅对指定纯子组成立时，也要拆清源码事实与组级说明。

### 11.4 私有/ignored 文件审计结论

当前 wired 源码未发现必须执行 `bin/wt.mjs`、`lib/scripts/*`、`test/wt.test.mjs` 或从 ignored `.evidence` 读取材料的依赖。它们出现在拒绝样本/检测规则不算执行依赖：[private-path guard](<../../test/ops/test-discovery.test.mjs#L44-L74>)区分完整清单字符串与可执行 path 构造；[hermetic 缺席断言](<../../test/ops/hermetic-gate.test.mjs#L27-L32>)只检查不存在。Git 安全组已调用 tracked release-tag/versionInfo，Windows fake-git 的 [exe](<../../test/fixtures/fake-git/fake-git.exe>)和 [源码](<../../test/fixtures/fake-git/fake-git.cs>)均 tracked。不要把维护者机器中私有工具的存在算门禁前置。

处置 **B=0：当前公共 wired 集合已无私有入口执行依赖，因此没有待替换项**，不是漏统计，也不是要新增依赖。后续 clean export 出现缺文件时，先核对 tracked 清单，再选择 tracked CLI/直接 lib，禁止把 ignored 私有工具接回公共门禁。宿主 peer、tools/*/node_modules 则是显式安装能力，不随源码导出附带，应在各能力组预检。网络仅有本机回环；合成 URL/ref、LFS/promisor 标记和 release gate 样本不代表应访问外网。

## 12. 处置统计

按**每文件一个主处置**计数，避免同一依赖在不同章节被反复计数：

| 模块 | A 显式 fixture/断言/文档 | B tracked 替换 | C 本地/opt-in 宿主组 | 合计 |
|---|---:|---:|---:|---:|
| core | 20 | 0 | 0 | 20 |
| storage | 8 | 0 | 0 | 8 |
| docs | 15 | 0 | 4 | 19 |
| git | 5 | 0 | 0 | 5 |
| host | 0 | 0 | 4 | 4 |
| client | 7 | 0 | 0 | 7 |
| ops | 19 | 0 | 0 | 19 |
| contract | 4 | 0 | 1 | 5 |
| **合计** | **78** | **0** | **9** | **87** |

C 的9文件＝当前 host suite 的7文件＋core 中 tool-schema-snapshot/doc-fixed-surfaces 两文件。host 的7项属于**维持本地能力边界**，不是称它们进入了离线 CI。migration-replay 真实分支的 C、external-docs 缺构建能力的 skip 等是**文件内细分处置**，不另加到文件计数；实施时按子组统计真实执行/跳过/移位，不能宣称只有9个风险点。

## 13. 后续拆分粒度、顺序与验收信号

### 13.1 先决条件与推荐批次

**先修假绿/环境泄漏/共享副作用，再拆文件；按数据语义依赖先 docs/core/storage，host/client 的集成 fixture 先于各自大文件拆分。** 不按目录名把所有 `test:core` 当 unit，不以“每文件更短”替代隔离和独立断言。

| 顺序 | 粒度与依赖 | 验收信号（后续任务执行，不是本文结果） |
|---|---|---|
| 0 | 固化清单和能力表；移清两项 core peer 混入；公共 runner 禁迁移 opt-in、隔离 HOME/Git config；消除 hermetic common Git 写；修 release-tag 职责说明 | 初始唯一文件基数87、静态调用点753可追溯；每个缺能力是真 skip/预检失败；未装 peer 不报 schema pass；默认无真实 HOME/store 读取；common Git 元数据不变 |
| 1 | 抽 tracked fixture：临时根/dispose stack、clock、命令/角色/token/rev、review/attempt/cold、Git可信执行/配置；保留 bootstrap 与 fresh 首次只读两构造 | fixture 不导入测试注册、不改生产行为；失败路径也清理；单例/env/ESM补丁原值恢复；每组独立入口与乱序运行；fixture 类型正反例继续有牙齿 |
| 2 | docs 先以 doc-read（定位/读取/预览）与 external（元数据/CAS、绑定/cache）收口，再 fixed（Git对象/洁净、auto/屏障、首次只读/来源、HEAD race），最后 evidence（材料、attempt/覆盖、漂移人审）与 D6 迁移 | 19个原文件逐一映射新组；每个原责任/断言有去向；first-read 无 bootstrap、拒绝无写、来源/屏障同提交、历史hash/回放均保持；Git/链接 skip 独立列明 |
| 3 | core 大文件按 task 生命周期/权限与准入、plan草案/物化/归属、读模型/摘要/发现拆；clock/renew/reclaim/intent/restart 作为同领域关联文件；archived 横跨场景保留交互组 | 20个原文件无遗漏；不得把“submit到review”误改自动done；allowedOps与守卫同验；完整 close→cold open 真执行；计划 sibling CAS和终态零写仍可追溯 |
| 4 | storage 与 contract 保持安全域：event/schema兼容、snapshot/replay、commit边界、repair纯计划、faults/salvage/recovery隔离执行；review-governance按准入/独立性/scope/兼容；不拆散 launcher/worker/oracle | 8 storage＋5 contract 原项映射；WAL故障/拒绝字节/备份/冷恢复各有信号；worker 断言实际执行、不能只看launcher退出；真实store opt-in 单独记录不挤公共分母 |
| 5 | host 先抽 boot/ready/dispose 与 stream/loopback request、cold seed；再按 task/plan/doc/session、auth/input/error/HTTP协议拆；schema snapshot 与 fixed-surfaces归 peer 能力组 | 有peer的独立 host 门必须执行而非跳过；无peer离线报告明确未覆盖；初始化屏障不用30ms猜测；坏请求在 create/open 前拒绝；只监听自己的回环端口且全部关闭 |
| 6 | client 先拆纯 logic（Markdown/chart/flow、filters/selectors、payload、plan-edit）；external-docs分纯逻辑/hook；page生命周期/导航/装配保持行为组合；复用runner前先验证runner自身 | 7个原文件及client-smoke映射完整；真实bundle先构建、产物零diff；fetch/global access状态复原；迟到写/草稿/认证失效组仍走真实出货装配；无DOM/视觉覆盖声明不扩大 |
| 7 | ops按静态接线、工具链、安装/测试环境、发布包、性能/恢复层收口；统一 suite manifest 与规模规则；接线检查器同批更新 | 19个原文件有层级；87是起点不硬钉永久文件数；新增/拆分文件与suite清单一致无重复/漏接；静态调用点与动态展开分别报告；每步相关门禁+diff --check+clean gate |

对小而单一的文件（alias-guard、plan-acceptance、repair-log、replay-snapshot、gitattributes-eol、test-typecheck）保持整体；不要求每个文件拆成多个文件。对强顺序场景保留一个端到端主链，独立规则另建 fixture，不把一条链拆成依赖执行顺序的多个 `test()`。所有大组拆分优先按领域责任，不按固定行数机械切段。

### 13.2 规模门禁与覆盖率口径

1. **文件接线**：从单一 tracked manifest/确定性发现导出 core/host/client/能力子组，保留默认/CI/strict/perf 关系校验。每步报告原→新文件映射、唯一文件数、缺失/重复数；文件数增加本身不是退步，漏接或静默移出才是。
2. **规模**：分别量化文件行数、最大用例/fixture、职责域数、静态注册数、运行展开数、子进程worker数；“753”不是789，更不是一次运行的pass数。先记录实际分布再确定上限/明确豁免，禁止只锁总行数逼出跨文件隐式共享。
3. **覆盖率**：V8 的主进程覆盖、Node --test 子进程、手工 spawn 的 worker 与 new Function 出货 bundle 需分别采集和校验。`test:coverage` 从[共享 manifest](<../../test/suite-manifest.mjs>)显式选择全部 wired tracked 入口，包含 client/unit、host preflight、perf/recovery；不执行 untracked。V8 loaded-project 行/分支/函数阈值为 90/80/90%，分母是 Node 原生已加载产品/维护脚本（默认排除测试文件和 node_modules），不能当产品源码独立指标；会涉及host与真实opt-in风险，不直接等同离线CI口径。缺 peer、缺 esbuild、平台skip、真实store未授权均列**未执行能力**，不能凭exit0算覆盖；没有真实数据就是无真实数据覆盖。
4. **分母**：明确按产品源码层（shared/core/host/src-client）与维护脚本分开；bundle/source map 不与源代码双计。源码regex/工作流文本/文档结构测试只能算接线/静态约束，不能替代相应业务分支执行。fixture/launcher 覆盖不能掩盖worker产品路径未采集。
5. **每批 clean gate**：独立候选先提交，干净导出仅用tracked入口；相关组通过且无非预期skip；确认只改获准面、产物一致、common Git/真实HOME/store无副作用；需要完整门禁时用已隔离runner而不是裸 strict。任何跳过/预算失败都给具体能力与范围，不弱化断言换绿。

### 13.3 需要主控决定的边界

- 将 schema snapshot/fixed-surfaces 全部归 host，还是先把纯HTTP部分解耦留公共组；两种都必须消除 core 的宿主假绿。
- `git archive` 无 `.git` 导出是否在临时树 init，以支持需要仓库身份的检查；不能借此回到修改共享 common Git。
- 性能与恢复入口独立于默认 core；strict 串行 perf → recovery，CI 单独执行，接线断言与 manifest 同步。
- 规模采用新文件物理行 600、函数 AST 行 150；四个精确既有不可增长 baseline 及覆盖率口径见[测试分级规范](<../TESTING-POLICY.md#5-可执行测试分层规模与覆盖率>)。真实 store/profile 验证仍须独立授权，不由本清单授权。

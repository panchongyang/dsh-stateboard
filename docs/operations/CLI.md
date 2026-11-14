# 开发 CLI 与维护命令

> 状态：现行；仓库开发/运维入口，不随 npm 包发布，不是产品 API。

测试风险分级、基线保护与完整门禁见[测试策略](<../governance/TESTING-POLICY.md>)；所有测试使用[隔离测试环境](<../governance/TEST-ENV.md>)和合成 fixture，不碰真实 profile/store。真实数据只在单独授权的副本上验证。

## 1. 开发 CLI

`node scripts/deck.mjs <cmd> ...`，至少：

~~~text
init --workspace <path> [--name]
plan --workspace <path> --file <plan.json>
claim --workspace <path> --task <id>
begin --workspace <path> --task <id> --summary ...
submit --workspace <path> --task <id> --note ... --evidence <kind>:<ref>
verify --workspace <path> --task <id> --human
board --workspace <path>
brief --workspace <path>
health --workspace <path>
~~~

用 `--json` 输出机器可读；用 `--root <stateDir>` 指定隔离存储根，否则使用 `DSH_HOME/project-board` 或用户目录下的 `.dsh/project-board`。CLI 只用于开发、诊断与 dogfood，不是产品接口；产品使用形态包括 UI、DSH agent 工具与可选本机 MCP。维护脚本独立于安装包。

离线损坏诊断与维护（参数不提供真实 store 默认值）：

```text
node scripts/salvage-log.mjs --root <absolute root> --project <id> --view board|health|events
node scripts/repair-log.mjs --root <absolute root> --project <id> [--keep head|tail] [--apply] [--force]
node scripts/repair-log.mjs --root <absolute root> --project <id> --truncate-to-valid-prefix
node scripts/repair-log.mjs --root <absolute root> --project <id> --truncate-to-valid-prefix --apply --confirm-data-loss <validHash>
```

- salvage 只读指定项目的 meta 与日志，不初始化 ProjectService/ProjectHandle，不 restore/recover，不使用 snapshot，不获取/清理锁，不写 root、meta、snapshot、tmp 或日志。返回 JSON，所有视图均标 `mode=read-only-prefix`、`current=false` 与显著“只读前缀，非当前状态”；`validSeq/validHash` 标明最后完整理解的 commit。边界诊断为 `partial`、exit 2（包括未知事件/版本），合法前缀输出 exit 0，读取/投影/参数失败 exit 1。事件兼容拒绝沿用 `reason:"unknown-event"`，附普通打开的诊断文案、项目 ID、事件类型、seq、分类和处理提示。health 只检查前缀的状态不变量，不证明当前日志健康、blob 内容或证据可用。events 包含前缀的全部事件索引。无一致读锁的在线观察可能随并发写变化，维护前应人工停写。
- `repair-log` 是唯一显式日志修复入口：普通模式修复可验证的 fork，不支持任意坏 JSON/hash；所有 dry-run 零写。prefix 模式仅支持坏 JSON（含不完整半尾）、seq、prev 或 hash 边界，保留原字节前缀，丢弃坏物理行及全部后继，拒绝空前缀、未知事件与不支持版本；不跳过坏行拼接尾部。输出丢弃物理行/字节范围、validSeq/validHash；后继 seq 不可信，RPO=validSeq，所有后继已发生业务状态可能丢失，外部副作用不会回滚。
- prefix apply 必须再次确认 validHash；任何现有 `lock.json`/`lock.json.claim`（含 stale）都拒绝，不允许 `--force`。人工先停写，再复用合作写锁，确认日志未变，以独占备份文件保存并 fsync 原字节后复核锁/原字节，再 tmp+fsync+rename。只清理本次自身锁，不自动删旧锁；不承诺对无视锁的 OS 写者提供原子隔离，也不承诺目录 fsync 的断电持久性。I/O 失败可能留下备份/tmp 供人工核对，不能盲目重试。恢复备份是独立人工决定，不可在新写入后盲目覆盖；代码回退不恢复被丢弃的状态。

## 2. 必须通过的测试语义

`npm test` = `test:core` + `test:host`；`test:ci` = `test:core`，两者的具体测试集合由 suite 注册表决定，不从旧数量推断覆盖。客户端检查显式运行 `npm run test:client`。真实 store 回放用例在未设置 `PB_MIGRATION_PROJECT` 时跳过。测试数量以本次运行输出为准。

1. publish → 任务状态正确（无 deps ready / 有 deps backlog）。
2. claim 成功；第二次 claim → lease-held。
3. expectedRev 过期 → stale-revision，状态不变。
4. cmdId 重复 → deduped，只有 1 个 task/claimed。
5. done 级联：依赖任务 ready。
6. submit 缺 evidence → missing-evidence。
7. file evidence hash 不符 → 拒绝。
8. interrupted 恢复：写一条 begin 后模拟重启 → recover 后 interrupted；reconcile(completed) → review。
9. 重放：同一 commits → 深相等 state；snapshot+tail = full replay。
10. 截断尾行：最后一行不完整 → 打开成功，最后合法 commit 生效。
11. 并发：10 个并发 claim 同一 task → 恰好 1 成功。
12. 进度：done/total 推导；没有手动百分比。
13. 多计划并发：两个 active 计划交错 revise（各自 baseVersion CAS）、focus 切换、archive 拒绝 live work、adopt/release version+1、orphan 归位、digest 字节稳定。
14. 迁移/回放：复制项目 store 到 temp 后 open，rev/任务数/planHeads/focus/health 与复制前一致；副本可重复 open；原目录逐字节不变（真实 store 用例用 `PB_MIGRATION_PROJECT` 选择加入，CI 可重入）。
15. 计划外/orphan 任务：副本上计数并断言保持不变；不 adopt、不自动归位。

### 补充入口

- `node test/client/client-smoke.mjs`：fake ModuleLoader/React/slots 验证 4 个 slot、重复 apply、样式注入幂等、纯逻辑与组件测试面；命令/端点断言读取共享契约，不由 bundle 导出白名单；不使用真实 DOM。
- `node test/host/host-preflight.mjs`：fake ctx 注册 7 个工具，断言名称与 schema。
- `node --test test/ops/architecture-map.test.mjs`：架构地图与磁盘一致。
- `npm run test:ci`：不依赖本机 DSH junction 的 core suite；客户端另跑 `npm run test:client`。
- `npm run check:release`：发布白名单、README 自包含与包纯净度；通过不构成发布授权。

## 3. 开发与编码约束

- 全部 ESM，Node 22；后端允许 JS/TS 共存，Node 直接加载运行入口；TypeScript 检查是开发期 `noEmit`。
- 客户端源码是 TS/TSX，classic JSX，样式只写 `src/client/styles.css`；改源码后运行 `npm run build:client`，esbuild 0.28.2 隔离在 `tools/build/`，运行时不打包。
- 后端 `npm run typecheck` 与客户端 `npm run typecheck:client` 分开；客户端 strict/allowJs:false，现有后端 JS 未全量语义检查。详见[TypeScript 工具链](<../governance/TYPESCRIPT.md>)。
- 根目录 `node_modules/@deepseek-ai` 是开发期宿主 junction，不在根目录运行 `npm install`。

- 不引入第三方运行时依赖（除 `@deepseek-ai/dsh-tools` / `dsh-home-paths` 等宿主已有包）。
- 时间/随机可注入，便于测试。
- 文件写入用 `fs.writeFileSync` + `fsyncSync`；原子替换用 tmp + rename。
- 源码规模门禁：单文件 ≤ 450 行、普通函数 ≤ 80 行、React 组件 ≤ 200 行
  （`npm run audit:check`）。

历史维护工具与测试数量描述见[口径档案](<../decisions/contract-legacy-surfaces.md>)，不作为当前入口。

## 4. Schema 升级与故障验证

运行时仅 schema v3；v2/缺版本返回 `schema-migration-required`，在修尾前拒绝，没有运行时旧门字段解析器。停宿主后使用发布包外维护脚本：

```text
node scripts/migrate-gate-v3.mjs --store <absolute-store-dir> [--apply] [--backup <outside-source-dir>]
```

默认 dry-run 零写；apply 先备份，再追加 `project/updated` schemaVersion3、全量 `task/updated` 与受影响草稿的既有 `plan/updated`，不新增事件、不重写历史；meta/snapshot 升至3。回滚只恢复迁移前备份+旧构建，流程见[迁移](<MIGRATION.md>)。

局部真实磁盘故障测试通过 `storeFactory: (dir, meta) => new JsonlStore(dir, meta, { fs: adapter })` 注入每 store 写适配器，覆盖 append/sync、snapshot、blob 和 relocate meta；默认原生 fs，锁和读保持真实，不修改全局 fs。`test/storage/store-faults.test.mjs` 用最小环境白名单启动合成 fixture worker，纳入默认与 CI 测试。

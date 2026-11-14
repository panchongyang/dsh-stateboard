# ProjectBoard 独立测试环境

遵守[分级测试与基线保护规范](<TESTING-POLICY.md>)。工具存在不代表实例已运行、候选已验收、允许合入或部署。每个 worktree 的运行根固定为自身的 `.test-env/`；不得覆盖已验收参考环境或复用其登录与数据。

## 1. 准备与实例边界

R3 使用专用候选分支/worktree。下列命令只在获准的候选目录执行，不在 master、日常部署目录或参考工作树执行；本轮离线集成不启动实例。需要实例时须另外明确授权。

```bash
npm run env:test:prepare
npm run env:test:seed
npm run env:test:run -- --cli "DSH_CLI_PATH"
```

- prepare 只创建专用目录与插件链接，不下载依赖、不复制凭据。seed 幂等，不覆盖已有项目历史。
- run/start 要求通过 `--cli` 提供兼容 DSH 安装中 `@deepseek-ai/dsh/lib/bin.js` 的绝对路径，命令中的 `DSH_CLI_PATH` 为占位符。默认测试端口 3081，端口占用即失败。可传 `--port 0` 选择空闲端口，随后用 status 核对实际地址。3080 为保留端口。
- 默认合成数据：一个项目、一个计划、三个任务（两个 ready、一个人审 review）及说明文档。需要真实数据副本须单独授权、一致性导出和脱敏；不得直接挂真实 store。
- home、agents、操作系统用户配置、临时目录、workspace、board/执行密钥、日志、认证均独立。只复用既有 CLI、依赖与本候选源码/产物，不自动下载或升级。
- 子进程采用系统变量白名单，不继承生产模型密钥、代理、自定义 Node 注入或原 DSH 配置；命令证据自动执行默认关闭。离线 R3 runner 还须隔离 XDG、npm cache 和 npm user/global config，并禁止真实迁移 opt-in。

## 2. 打开、核对与停止

```bash
npm run env:test:status
npm run env:test:open
npm run env:test:verify
npm run env:test:stop
```

open 读取本实例私有授权 URL 并打开浏览器，不打印 token；首次不要只点裸地址。测试 Cookie 独立，不能复制生产 Cookie 或关闭鉴权。status 显示地址、启动 commit、DSH 版本与就绪耗时，不显示 token。verify 检查匿名拒绝、独立认证、完整 BOOT、插件 API、合成项目和当前工作树前端产物；它不证明源码已正确构建，也不代替 UI 人工验收。

前端变更须显式构建、核对产物，在获准的测试实例重新启动后刷新；不承诺自动 HMR。主 DSH 不需要为离线测试重启。

stop 只经私有控制端点验证 supervisor 身份后停止其子进程，不按磁盘旧 PID 杀进程。主动停止对外成功，原始退出信息保留；意外退出非零。同一环境有生命周期锁时，第二次 run、prepare、seed、reset 均拒绝。

## 3. 人工验收

1. 核对地址、commit 和项目，仅有合成数据，无真实项目/会话。
2. 编辑测试任务、查看历史；刷新后确认保留。
3. 阅读 review 样例证据，由用户验收进入 done。
4. 打开内嵌档案，确认只读提示可见、保存/编辑关联不可用；登记一个工作区文件为外置文档并编辑其元数据。
5. 经授权停止并重开测试实例，确认任务、人审和文档持久化。
6. 执行 verify；记录候选、步骤、预期、实际及错误。UI 交互由用户手验，不新增浏览器探针。

## 4. 重置与故障处理

```bash
npm run env:test:stop
npm run env:test:reset
npm run env:test:seed
```

reset 只在确认停止且持有独占生命周期锁时，把 board/workspace 旋转为备份，不直接删除；不清空测试 home 会话或设置。彻底清理须人工核对专用目录，不对真实 home 操作。

标记缺失/不匹配、受管路径含链接或插件链接不是本工作树时拒绝；唯一允许的链接是指向本候选的插件链接。stale/busy 或异常退出时，不自动删锁、猜测接管或按旧 PID 强杀；交人工核实归属与活实例。

这不是 OS 沙箱，同账号仍有本机权限。不得打开真实工作区、输入生产密钥、运行陌生命令。原始日志/私有状态可能含本测试实例授权 URL，不复制到公开报告。

内嵌写入默认禁用，测试环境的入门文档也按只读档案处理。需要覆盖"已有内嵌档案仍可读"的合成夹具时，seed/测试代码显式使用 `ProjectService({privilegedInlineWrites:true})` 这条特权构造路径；它不受 `doc.inline_policy` 影响，也不能从 HTTP、agent 工具、配置文件或环境变量打开。生产代码不得设置该选项。

## 5. 安装渠道的真实宿主验证

安装验证与本页的本地 supervisor 是不同边界：不能用已有源码 junction 的预检，代替陌生用户的安装。对已授权的候选，使用系统临时目录（规范化的 Windows 长路径，避免 8.3 别名），从系统变量白名单重建环境；同时隔离 HOME、USERPROFILE、DSH_HOME、DSH_AGENTS_HOME、APPDATA、LOCALAPPDATA、TEMP/TMP、XDG 与 npm 配置/cache，不复制真实 profile、store、登录或模型密钥。

- npm 路线：`npm pack --ignore-scripts` 产出本地 tarball，再 `dsh plugin --profile PROFILE add ABSOLUTE_TARBALL`；不是发布到 registry。
- 源码路线：导出/解压候选源码到无 `.git`、无 `node_modules` 的独立目录，再 `dsh plugin --profile PROFILE add ABSOLUTE_SOURCE`。两者都加载包内的 `lib/cordis.patch.yml`，只用相同 UI 与七个 agent 工具入口。
- 目标应为 Web profile；新自定义 profile 按宿主约定选择 Web composition。DSH `0.2.2-rc.1` 要求 Node >=24.9；Node 22 的 core/client 测试是另外一组，不能代替当前宿主的验证。
- 两路分别首次启动、重复安装、重装后停止/重开隔离宿主，以授权 Cookie 重新获取页面与 bundle。核对 `__PROJECT_BOARD__` token、插件 client 资源、HTTP ping、首次创建项目和实际宿主工具注册；另用无 Git PATH 的合成工作区执行 agent adapter/core 流程并核对 `git_unavailable` 降级。
- 可以用仅存在于临时 profile 的观察插件读取真实 tools registry、以合成 agent execution context 调用已注册 handler；必须明确这不是 LLM 推理或完整 agent executor 测试。HTTP/client presence 不等于浏览器交互/渲染验收，不添加 headless UI 探针。
- 卸载用 `dsh plugin --profile PROFILE remove dsh-stateboard`，核对只移除该依赖与 bundle 选择，保留项目数据和其他配置；停止所有自己启动的临时进程。

源码维护脚本的 dry-run、备份、幂等、失败回退、仅撤自身链接由 `test:core` 的 scripts 测试覆盖；宿主 helper、bundle/D6 metadata 和隔离 HOME 下的脚本 CLI 由 `test:host` 覆盖。脚本不打入 npm 包、不修改源码 runtime junction，也不自动重启。面向用户的安装、手动重启/刷新、卸载与配置回退步骤见 [README 安装节](<../README.md#安装与首次运行>)；真实宿主证据需逐候选另留，不以离线 CI 替代。

## 6. 离线门禁与入口

`check:strict` 串行执行 `audit:check` → `npm test`（规模门禁及离线四层 + host）→ `test:perf` → `test:recovery` → `test:stores -- --gate` → `check:release`；失败即停。perf/recovery 不在默认 core。各层预算、coverage 阈值和 SKIP 口径见[测试索引](<../test/README.md>)。stores gate 默认根来自 `os.homedir()/.dsh/project-board/projects`，不读取 DSH_HOME：运行 strict 前必须用白名单临时 HOME/USERPROFILE 并断言默认根在合成 fixture 内。显式 stores gate 使用 `--root <synthetic-projects>`，无需基准。源码不附带真实 store 基准。需要比对时用 `--baseline <fixture-baseline>` 指定与隔离数据配对的基准文件。生成合成基准时仅在隔离根使用 `--update`。不得对真实默认根运行、设置真实迁移 opt-in、改生产基准或为通过执行真实 `--update`。

store 门禁在临时副本上复用普通日志打开的事件分类与诊断（[实现契约 §2.9.1](<CONTRACT.md#29-存储>)），包括快照覆盖的提交。未知或需迁移的事件输出项目 ID、事件类型、seq 和处理提示，与只读前缀诊断共用拒绝文案，门禁非零退出。成功行列出源日志的 applied/additive 事件计数，以及副本恢复后的 health 告警数。显式根不存在、无项目、缺少日志提交或项目无法正常打开均失败；只有默认 gate 缺样本时报告 SKIP。副本跳过源锁及其临时认领记录，拒绝符号链接或 junction。普通比对不写基准；显式 `--update` 只在副本回放、数据不变量和源哈希检查全通过后更新源根之外的基准。

- [生命周期命令](<../scripts/test-env.mjs>)
- [目录/配置/凭据隔离与 reset](<../scripts/test-env/environment.mjs>)
- [进程托管与认证控制端点](<../scripts/test-env/lifecycle.mjs>)
- [合成数据](<../scripts/test-env-seed.mjs>)、[HTTP 验证](<../scripts/test-env-verify.mjs>)、[浏览器入口](<../scripts/test-env-open.mjs>)

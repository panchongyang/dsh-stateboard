# ProjectBoard · dsh-stateboard

DSH 的跨会话项目板：通过 **UI + agent 工具**管理项目、计划、任务、外置文档与结果材料。首发候选 **0.2.0**，许可证 [BSD-3-Clause](<./LICENSE>)。

**尚未公开发布。** 包保持 `private:true`；registry 包名安装与公开源码下载只在维护者完成公开发布后可用。目前可使用经授权取得的本地 tgz 或源码目录，不能把本地包验证当作线上发布成功。

导航：[支持环境](#支持环境) · [安装与首次运行](#安装与首次运行) · [约三分钟文字演示](#约三分钟文字演示) · [真实限制](#真实限制) · [备份回退与迁移](#备份回退与迁移) · [贡献与架构入口](#贡献与架构入口)

## 产品边界

项目板记录谁提交了什么、引用来自哪里、内容是否变化；**不替材料背书**。命令/测试由人或 agent 在外部执行，成功和失败都可作为材料记录；项目板不执行、不重跑、不验签这些结果。未漂移不等于结论正确，未观测不等于未漂移。`submit` 只进入 review，`verify` 是验收裁决而非系统正确性证明。

两种安装来源装配相同的 `dsh-stateboard` bundle，包含 UI、五个 DSH agent 工具及可选本机 MCP，不附赠 CLI、worktree 编排或运维工具。DSH 是硬依赖，Git 是可选的只读增强；**没有 Git 也能完整使用核心流程**。

## 支持环境

| 项目 | 支持口径与验证限制 |
|---|---|
| 产品 | `dsh-stateboard@0.2.0`，BSD-3-Clause |
| 操作系统 | Windows 11 x64；macOS / Linux 未测试、不承诺可用 |
| DSH 支持带 | `0.2.1-rc.2` 至 `0.2.2-rc.1`；上界不自动跟随 latest 扩展 |
| Web 宿主 Node | DSH `0.2.2-rc.1` 要求 **Node >=24.9**；其它支持带内版本仍须满足各自宿主要求 |
| 插件 engines | `Node >=22` 只是 core/client 基线，**不是 Node 22 Web 宿主支持承诺** |
| 验证范围 | 本地隔离宿主覆盖两来源装配、工具/HTTP/客户端包、首次建项目、无 Git 降级、重装重启；不代表逐一实测支持带内所有版本/Node组合 |
| 未验证 | 在线 registry 安装、公开仓下载、浏览器真实交互、LLM 推理；Node 22 core 留有一次锁竞争失败记录；未覆盖组合不得视为通过 |

先安装兼容的 DSH Web 宿主，使 `dsh` 在 PATH。无需 pm2、固定端口、作者目录或固定 profile。profile 必须包含宿主 Web composition；仅有 agent composition 的环境没有看板 UI。

## 安装与首次运行

### 1. 选择自己的目标环境

`PROFILE` 是你实际启动 DSH Web 的 profile 名。`DSH_HOME` 优先于默认用户目录下 `.dsh`；profile 配置位于其 `profiles/PROFILE`。Windows 使用原生绝对长路径，不使用 8.3 别名。

由操作者按自身方式停止目标宿主，按[备份步骤](#备份回退与迁移)保留 profile 配置和数据。不要为了安装覆盖其它插件配置，也不要触碰另一运行中的 profile。

### 2. 两种来源，任选其一

**npm 产物来源**：未发布时从维护者取得本地候选 tgz，核对版本与提供的校验值；发布后才可直接用包名。

```text
# 本地候选（把占位路径替换为实际 Windows 绝对路径）
dsh plugin --profile PROFILE add "D:\Packages\dsh-stateboard-0.2.0.tgz"
# 仅在公共 registry 已发布后：
dsh plugin --profile PROFILE add dsh-stateboard
```

**源码来源**：取得同一候选版本的源码归档或经授权的仓库副本（不要求 Git clone）。已提交客户端产物的完整源码可直接装配；修改了客户端才先构建：

```text
# 仅需要重建客户端时，在源码根目录执行：
npm --prefix tools/build ci
npm run build:client
# 安装完整源码目录：
dsh plugin --profile PROFILE add "D:\Projects\dsh-stateboard"
```

宿主安装/链接包并选择同名 bundle，包的 patch 插入 `id: project-board / name: dsh-stateboard`。不需要手工向 profile patch 追加 insert，不需要把宿主运行时链接进源码。重复 add 不应产生第二份选择。若 profile 含手工装配项，先备份并核对来源，避免重复 ID；不要批量覆盖配置。

源码仓库的 `scripts/install.mjs` 是维护工具，不在 npm 包内，也不是第三种产品入口。普通安装使用上面的原生宿主命令即可。

### 3. 启动并确认首次运行

操作者启动/重启所选宿主，再刷新现有 DSH Web 页面（Ctrl+R，获取新进程 token 与资产）。打开左侧栏「项目板」，在一个自己选择的工作区会话里请 agent 调用 `project_session op=init name="示例项目"`。该操作只建空项目，不建占位任务。UI 与 agent 应看到同一项目。

客户端从宿主加载已构建的 bundle；改源码或仅通过离线测试不代表现有页面已更新。没有 UI 时核对 Web composition、bundle 选择与宿主诊断日志；401/403 先刷新页面，不要求某个固定进程管理器。

**客户端装载身份**：构建器从本包 manifest 的 `name` 派生并 JSON 编码 factory ID，发布纯净检查只核对可信本地构建的身份前缀及待检包客户端的完整字节，不执行待检包代码；真实装载注册与 apply 仅由可信本地客户端 smoke 测试验证。检查其它构建时，须先在对应可信源码工作区重建并测试，字节不匹配则拒绝；panel、入口、存储与路由等业务身份保持不变。既有 profile alias / 装配名称仍需由操作者备份后核对为包名，本修复不迁移真实环境配置，**浏览器真实交互尚未验证**。安装命令、离线测试或 HTTP/工具面成功不能据此宣称 UI 可用；若入口仍缺失，保留诊断、停止晋级并联系维护者，不反复试改或重启。

### 安装失败、卸载与回退

缺宿主、版本不兼容、权限或包管理器失败时，保留诊断并停止，不把失败命令当激活成功。

DSH `0.2.2-rc.1` 对不存在的本地路径可能先写入悬空依赖，随后报 `cannot resolve profile bundle`，不保证自动回退。停止目标宿主，对比安装前备份，确认**本次新增**的依赖名；例如确为 `missing-package` 时，执行：

```text
dsh plugin --profile PROFILE remove missing-package
```

隔离验证中它恢复了该例的四份 profile 配置。若改的是已有项或 remove 失败，停止重试，从备份人工恢复本次变更；不要删除合法依赖或未知目录。

原生安装的卸载命令：

```text
dsh plugin --profile PROFILE remove dsh-stateboard
```

然后由操作者重启目标宿主并刷新。卸载保留 board store 与所有外置文件。回退版本与数据的完整顺序见[备份回退与迁移](#备份回退与迁移)。

## 可选 Codex MCP

MCP 随 DSH 插件运行，默认关闭。启用时在选定 DSH profile 的插件配置中为已有的 `project-board` 条目设置下列选项。例如在该 profile 的 `cordis.patch.yml` 中覆盖已有条目，保留该条目中已有的其他 `config` 字段。

~~~yaml
- id: project-board
  config:
    mcp:
      enabled: true
      port: 33109
~~~

为 DSH 和 Codex 的启动环境提供相同的 `PROJECT_BOARD_MCP_TOKEN`。使用 32 字节随机密钥的小写十六进制表示，例如通过 Node 的 `crypto.randomBytes(32).toString('hex')` 生成。凭据由启动环境保管。插件加载后，在 Codex 配置中加入：

~~~toml
[mcp_servers.projectboard]
url = "http://127.0.0.1:33109/mcp"
bearer_token_env_var = "PROJECT_BOARD_MCP_TOKEN"
~~~

Codex 可以列项目、列任务和读取详情。需要暂停入口时，在 DSH 插件配置中将 `mcp.enabled` 设为 `false` 并重新加载插件。

需要让 Codex 管理和接手任务时，可在同一 `mcp` 配置下另开写入，并填写明确授权的项目 ID。以下 ID 是占位符，实际值从 `list_projects` 获取。

~~~yaml
      write:
        enabled: true
        projectIds: [prj_example]
~~~

为 DSH 和 Codex 的启动环境提供独立随机的 `PROJECT_BOARD_MCP_WRITE_TOKEN`，格式与读凭据相同。保留读入口，在 Codex 配置中另加一个使用写凭据的入口。

~~~toml
[mcp_servers.projectboard_write]
url = "http://127.0.0.1:33109/mcp"
bearer_token_env_var = "PROJECT_BOARD_MCP_WRITE_TOKEN"
~~~

在 Codex 聊天中用 `open_work_session` 开始该项目的工作会话。可以读取已有卡片，或用 `create_task` 建卡、`update_task` 编辑、`ready_task` 将满足条件的待办置为就绪。随后用 `claim_task` 领取、`begin_task` 记录执行意图、`submit_task` 附证据提交审查。工作会话 token 保留在当前聊天内。写入默认关闭。停用写入口或轮换凭据后重新加载插件，既有会话失效。工具参数、续接与异常处理见随包的实现契约 §3.7。

## 约三分钟文字演示

**前提：已安装、已打开一个可写的脱敏示例工作区。** 这是约三分钟的讲解脚本，不是计时实测或执行时长保证；安装/构建/真实任务执行不计入。可在没有 Git 的普通目录完成全程。下面 `TASK_ID` / `DOC_ID` / `REV` / `TOKEN` / `HASH` / `ACCEPTANCE_ID` 都用实际返回值替换，不照抄占位符。变更前读取当前 revision 与 allowedOps；遇冲突重新读取，不能强写。

1. **0:00 项目 → 计划任务。** 请 agent 执行 `project_session op=init name="示例交付"`，再发布以下计划：

```json
{"op":"publish","title":"示例交付","steps":[{"title":"准备材料","tasks":[{"key":"note","title":"说明示例结果","acceptance":[{"text":"说明已登记、结果材料可读，交由人判断"}]}]}]}
```

这是 `project_plan` 参数。保存返回的任务 ID，UI 中可看到计划与任务；无需先创建占位卡。

2. **0:35 写意图 → 外置文件登记。** `project_board view=task taskId=TASK_ID` 后，依次用最新 rev 调用 `project_task op=claim`、`op=begin`，后者带 `fencingToken=TOKEN` 与 `summary="在示例工作区写说明和结果材料"`。副作用前先记 intent。使用自己的编辑器创建 `notes/demo.md`，正文例如“示例：结果等待人工判断”。项目板不会替你创建文件。然后调用：

```json
{"op":"register","title":"示例说明","kind":"note","relPath":"notes/demo.md","links":{"taskIds":["TASK_ID"]}}
```

这是 `project_doc` 参数；登记要求根内已有普通文件，不写入正文，不构成确认。

3. **1:10 外部编辑 → 内容现状/confirm。** 在编辑器中修改并保存正文，再调用 `project_doc op=inspect docId=DOC_ID fresh=true preview=true`。查看可用性、预览、`metaRev`、`observation.contentHash` 和确认情况；未 confirm 时是 `unconfirmed`。确认读到的版本后，调用：

```json
{"op":"confirm","docId":"DOC_ID","expectedMetaRev":1,"expectedContentHash":"HASH"}
```

把 `1` 也替换为 inspect 返回的真实 metaRev，HASH 使用完整 SHA-256。confirm 会重读全文，内容竞态返回 stale-revision，需重新检查；它只记录字节基线，不表示采纳结论。再 inspect 显示 `matches_baseline`；再次外部编辑后是 `changed_since_confirm`。元状态 `draft → in_review → adopted` 需显式 update_meta，文件编辑和 confirm 都不会自动改变它。

4. **2:00 普通结果材料 → submit。** 在编辑器写 `notes/result.txt`，记录实际做了什么、结果与限制（失败也可记录）。重新读取任务，取当前验收项的 `id` 作为 `ACCEPTANCE_ID`，用最新 rev 和 claim 的 token 提交：

```json
{"op":"submit","taskId":"TASK_ID","expectedRev":3,"fencingToken":1,"evidence":[{"kind":"doc","ref":"DOC_ID","summary":"示例说明当前内容","acceptanceId":"ACCEPTANCE_ID"},{"kind":"file","ref":"notes/result.txt","summary":"外部产生的普通结果记录，非系统重跑","acceptanceId":"ACCEPTANCE_ID"}]}
```

`3` 与 `1` 都必须换成实际最新 rev/token。无 Git 时 doc 材料会显式 current-only，附 fixedReason；核心流程照常进入 review。

5. **2:35 人工完成判定。** 人打开任务抽屉，阅读材料和验收项，选择 verify 或 reject。不是由提交 agent 自称 done。若证据提交后变化，先调查；可刷新的 file 漂移可由 human refresh，其它情形 human 可填理由 acknowledge，留痕不等于材料正确。独立 agent 只可在开启审计门的任务显式带审计报告 verify，session 级独立性不是信任保证。

**可选 Git 镜头**：若示例文件恰在主绑定仓库中、已经干净提交且对象本地可得，沿用上一步带 `acceptanceId` 的 doc 材料提交，就会自动记录只读 Git 版本引用。不需额外 approval；UI/材料可显示 fixedState。项目板不替你 commit，不切分支，不 fetch，不进入其它 worktree 复验。首次 pin 失败降为 current-only；已有历史 fixed 引用缺对象时保持原引用并报告不可观测，绝不用当前正文冒充历史。

## 真实限制

- **单机、单用户、每项目单写者**；不是多人权限系统。另一个进程持锁时只读；不要手工删除锁来制造并发写入。
- `file` 材料按项目主 `workspacePath` 解析，不按会话分支/worktree；外置文档按其登记的 binding 根 + relPath 读取，不跨根寻找同名文件。越界、不可读、缺文件必须分别表达。
- 外置文件由编辑器维护，登记只保存定位与元数据；**文件内容与看板管理状态不自动同步**。inspect 最长缓存30秒，需要现状时 fresh；confirm 重新读取并记字节基线，不发布/采纳文档。
- 内嵌文档是只读档案。UI 没有新建/编辑正文入口；`doc.put/doc.link` 默认拒绝 `inline-write-disabled`。human 可按项目显式暂开旧写语义用于维护并留事件；这不是普通编辑流程。
- Git 只读且可降级，不管理分支/worktree，不承诺它们的隔离、集成或复验。多仓/非主绑定文档可登记，但不保证自动 pin。内容转换、缺 Git、超时或安全拒绝均可能导致 current-only。
- 历史固定内容依赖本地 Git 对象；浅 clone、仓库丢失、对象被清理时不可观测/不可得，不自动联网恢复。内嵌历史依赖 blobs。元数据后缀 `@rev` 不是外置正文版本。
- 状态 `backlog → ready → in_progress → review → done` 受 rev、租约、fencing 与意图守卫约束。崩溃后有未闭合意图须 reconcile；日志健康、哈希相同或人工验收均不能担保外部副作用正确。

## 备份回退与迁移

### 停写后的一致备份

1. 操作者确认 DSH home、profile、projectId、主工作区/其它绑定绝对路径及唯一写者，按自己的运维方式停止宿主。不要用可写 cold open 当零写诊断，它可能补尾行或提交恢复事件。
2. 把整个 `DSH_HOME/project-board` 复制到**源目录外一个全新备份目录**；未设 DSH_HOME 时使用用户目录下 `.dsh/project-board`。完整保存日志、meta、snapshot、blobs、身份/绑定注册数据与锁诊断，不能只复制仓库 marker 或 snapshot。
3. 分别复制工作区外置文件、被引用的本地 Git 对象（包括未推送对象）、目标 profile 配置（`package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`、`pnpm-workspace.yaml`，仅复制实际存在项），并保留匹配的安装包/源码版本。
4. 记录备份时点、包版本、projectId、路径清单与日志 SHA-256；备份含私密材料，勿公开。故障后另存 damaged 副本，不能覆盖一致备份。没有备份即没有承诺的数据回退。

### 回退或恢复

1. 停止所有写者，先保存当前故障数据与诊断。
2. 将一致备份复制到新的恢复目录核对完整性；保留原故障目录，不硬删、不混拼日志。由操作者恢复整套数据、匹配构建和本插件 profile 配置；profile 中后续其它插件变化应合并而非整份覆盖。
3. schema/event 已升级时不能只退代码：必须用迁移前完整数据 + 匹配旧构建。恢复会失去备份后新写入，**RPO 是备份时点**，需先确认可接受损失；不能撤销文件修改、测试、部署或人工决定等外部副作用。
4. 操作者启动后刷新页面，确认同一项目、计划/任务、外置定位、历史正文和健康页。在获准恢复副本上确认新业务可提交、再次冷开仍保留；不要把 health 绿当作业务恢复证明。真实业务恢复须另行授权。

中段损坏、缺 meta、锁归属不明时停止写入；npm 包不含修复/迁移脚本，取得匹配源码和维护者支持后按其恢复指南在授权副本操作，不猜 PID、不删锁、不跳过坏行。

### 工作区搬迁、换机与升级

- 先完成上述备份，再复制 board 数据、工作区文件、必要 Git 对象和匹配包；新环境满足[支持环境](#支持环境)。只复制代码或 marker 不会搬走看板。旧环境停写，新环境不与旧环境同时写同一 store。
- 本机绝对 binding 路径不会自动改成新机器路径。先在副本核对身份，再用匹配源码维护工具显式 relocate/import；项目 ID 必须保持一致，不要在缺数据时 init 创建替代项目。
- 单主根搬迁可在匹配源码根目录执行以下维护步骤（`BOARD_ROOT` 是已核对的绝对 board 数据根；先对副本演练）：

```text
node scripts/relocate-project.mjs --root "BOARD_ROOT" --project PROJECT_ID --to "NEW_WORKSPACE" --dry-run
node scripts/relocate-project.mjs --root "BOARD_ROOT" --project PROJECT_ID --to "NEW_WORKSPACE"
```

该脚本**不移动文件**。dry-run 使用服务 open，可能写恢复/索引元数据，不是严格零写诊断。目标需已存在、没有另一个项目；写者未释放则停止。它不提供跨机身份注册表合并/多 binding 自动迁移保证。

- relocate 后外置记录仍可能指向旧 binding；在新环境核对 binding 后逐个 `project_doc op=relocate docId=... expectedMetaRev=... bindingId=... relPath=...`，再 inspect/confirm。批量 rebind 仅 human/system 维护入口。不要手改日志或只改 meta。
- `file` 相对引用随主根变化，绝对引用不会被重写。缺 Git 对象的历史不能靠重新 confirm 修复；要从备份补回同一对象，不能伪造 pin。
- 运行时只开 schema v3；遇 `schema-migration-required` 必须由维护者在停写副本先 dry-run、备份再 apply。内嵌档案转外置也有专门授权/备份步骤，不能用 register 冒充迁移。

## 贡献与架构入口

源码贡献请先读仓库的贡献指南与架构模块地图；它们属于完整源码，不随 npm 包提供。**本 README 的安装、演示、备份和回退说明不依赖那些文件或未公开网站**。实现语义参见随包的 [docs/CONTRACT.md](<./docs/CONTRACT.md>)。

架构入口：shared 是零依赖契约；core 是不依赖 DSH 的状态机、日志、租约、文档与读模型；host 把 DSH 工具/HTTP 翻译成命令；client 是 React UI。客户端运行时只加载已构建的 bundle，无运行时编译。新功能先改契约，领域守卫只放 core；npm 与源码提供相同能力。

源码贡献入口为 `docs/CONTRIBUTING.md`，机器校验模块地图为 `docs/ARCHITECTURE.md`，维护流程为 `docs/RELEASE.md`，数据指南为 `docs/RECOVERY.md` / `docs/MIGRATION.md`。取得完整源码后可运行：

```text
npm run test:ci             # core + client，host可选依赖缺失可能明确SKIP
npm run test:host           # 需显式装配兼容的DSH开发依赖；不要求固定checkout
npm run check:architecture
npm run check:release       # 实际npm pack的技术纯度和README链接门禁
npm run check:release:readiness  # 额外公开元数据与人工private闸，红则逐项说明
```

测试只用合成临时 fixture，不触碰真实 store/profile。冻结候选的全量门禁由维护者安排；离线测试不等于浏览器/线上安装已验证。本地准备、人工授权公开发布、目标环境部署是三个独立动作；任何检查通过都不会自动发布或重启。

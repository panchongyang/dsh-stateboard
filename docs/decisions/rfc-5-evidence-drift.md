# RFC-5：证据漂移分级、固定版本与刷新

> 状态：已替代（现行语义见[实现契约](<../CONTRACT.md>)；正文保留方案或决策时的语境）。

- 状态：Proposed，等待用户验收；不是已落地契约。
- 日期：2026-10-29。
- 用户确认：A–E 由本稿定义；以备份分支 `backup/master-2026-10-28-strict-audit`=7305de9 为开发基线，不包含 a34d3c2 人工豁免；完整验收前不合入 master、不部署。
- 开发隔离：`work/reliability-followup-20261029` 分支，独立候选工作树（本机留证）。原 master=c127b51 及另一 doc 证据 worktree 不变。
- delegation: yes — 八个交接反例涉及多模块，由独立只读子审查核查；本 RFC 由主控编写、抽查证据实现。

## 1. 简审结论与威胁模型

看板 done 是历史交付记录，不等于当前 master 含有相应实现。master 曾回到 fe7a399，之后加入发布门禁与事件兼容改动；7305de9 的证据、锁、归档、租约、搬迁改动未在当前 master。用户已明确选择备份为开发基线，因此不整批恢复到 master，也不把两条线混成一个验收结果。

备份现状：normalizeEvidence 的 doc@rev 只接受当前 head；auditEvidence 对 doc 比较当前 head.hash，故文档正常更新就可能把旧 pinned 引用误判 doc-drift。file 按当前 workspace 重算 hash；auto/manual verify 都审计 active evidence，begin 会 supersede 旧 attempt 并重置 acceptance。command 强度依赖持久 execution proof 与 attempt/ref 绑定；health 不重跑 command。

威胁范围：防误验收、无意漂移、调用方伪造记录与并发错绑；不声称 HMAC 能防同一 OS 账号读密钥，不把 stdoutHash 当功能正确性证明。工作区可在检查后继续变化，本稿保证“验收时观察到的版本”，不声称锁住用户整个文件系统。

当前简审另外发现 touch-only 无进展续租仍无上界；这与证据策略无关，单独修，不夹带到本 RFC 的运行时实现。原八项修复不能因旧测试全绿就宣称全局验收通过。

## 2. A–E 选项、攻击面与取舍

### A. 分级：完整性、时效性、弱来源分开

完整性失败始终 error：missing/unreadable、路径越界、blob 哈希损坏、现代 proof 无效/错绑、command 非 0/timeout/error。普通 live-file 内容变更属于 freshness，而不是伪造；但 active review 的 freshness 仍需显式解决，不能自动 done。

done/canceled 历史任务的普通内容漂移只作为历史 health warning，既不回写任务状态，也不阻塞不相关任务；如果显式重新打开或验收该任务，按 active 规则复核。历史 missing/proof 错误仍保留 error 级诊断，但不是项目级全写锁。

风险：一律降 warning 会让 active 验收静默接受别的内容；仅按扩展名或文件目录猜严重性也可绕过。结论：采纳上下文分级，不采纳“所有 drift 都 warning”。

### B. 固定版本：验证实际引用的不可变产物

doc@rev 必须定位该 rev 的 doc/created 或 doc/updated 历史 hash，再读取对应 content-addressed blob、验证内容 hash；不能改为读 head，也不能仅找到 hash 就不检查 blob。必须校验版本为完整正整数，拒绝 @1junk/@0/@-1/不存在的 rev。无版本 doc 在新 submit 时规范化为当时 docId@rev。

文件可显式选择 live-file（验收时要求 workspace 内容一致）或以后单独实现的 immutable artifact；本轮不自动复制任意源文件到 blob，也不凭 Git HEAD 自动把 live 改为 pinned。引用提交版本证明当时内容，不证明最新需求已满足；任务若声明 latest/freshness，仍需 C。

风险：把 head 前进当 drift 是误报；只记 hash 不保留实体则“可证明不可查看”；把旧 snapshot 当最新成果是另一种误验收。结论：优先实施 doc pinned 语义；已有独立候选 fix/doc-evidence-pinned-rev=4ff4ebe 只做候选对照，不擅自修改/合并该 worktree。

### C. 显式刷新/替换证据，而非覆盖历史

建议新增 task.refreshEvidence：仅 review + human，必须 expectedRev、reason、target evidenceIds、逐项 replacement。复核任务状态、版本与权限后，先完整校验所有替换项，再一次提交；任一失败则 task/rev/log 均不变。替换保留旧 evidence，写 supersededBy 与审计关系，重新计算 acceptance 覆盖；不能仅改原 hash/verifiedAt，也不能把其他 acceptance 的证据挪来凑数。

file 必须由服务端重读并重算 hash；doc 选择明确 rev；command/test 在首版禁止通过 refresh 产生“已执行”记录，必须 reject→begin→重新受控执行→submit。agent 可走现有返工路径，但不可在 review 原地代替人刷新。刷新成功仍在 review，用户另行 verify；刷新与 verify 分开便于检查，verify 仍重新审计以捕捉两者之间的新漂移。

风险：静默刷新等于自动认可新内容；只有覆盖 hash 会销毁旧审计；对 command 只刷新时间戳会伪造重新执行。结论：采纳最小、人发起、原子、file/doc-only 刷新；command 继续正式返工。

### D. 有限人工豁免

理论方案是 human-only、非空 reason、逐 evidenceId + expected/actual hash + audit fingerprint 绑定本次漂移，任何再次变化都使确认失效；绝不允许 waive missing、不可读、现代 proof 异常或 command 失败，auto verify 不可消费人工豁免。

风险：仅 acknowledgeDrift=true + 全局 reason 过宽，容易连带吞掉非内容错误或新的漂移；未来多次重复验收难以解释。用户已要求不包含人工豁免分支。结论：本阶段明确不实施、不 cherry-pick a34d3c2，不向工具/HTTP/UI 增加豁免参数；D 仅保留作为被比较且暂不采用的方案。

### E. 策略治理与渐进启用

不要用一个 severity 开关混合三个轴：诊断 severity、是否可 auto done、是否拦 manual verify。输出稳定 code/category/evidenceId/observed hash/actionable hint。hard integrity errors 始终 error 且 active 验收不可放行；legacy 无 proof 为 warning + human-only，不能伪升级 strong；active live drift 要刷新或返工。

未来增加任何更严规则先在独立分支验证，存量先只读 inventory；不得一次开全项目 enforcement。可考虑新鲜度策略的 report/enforce，但 report 只调节 freshness 的展示/治理，不能改变上述硬错误底线。策略设置必须 human/system、留审计，agent 不可降低策略。

风险：report 模式成为完整性旁路、隐式改全项目默认值、不同入口用不同 evaluator。结论：采纳统一 evaluator 与显式发布边界；本 RFC 不改现有 policy 默认值、不恢复主分支新门禁代码、更不部署到其他项目。

## 3. 推荐组合与首批边界

采用 A+B+C+E；D 不实施。先纠正 doc@rev 的对象语义，再提供有审计的 file/doc 刷新，最后处理历史展示噪音。顺序不能倒成“先把 audit 关掉”。本轮只交决策；后续实施必须等待用户验收本 RFC，并使用独立任务/提交。

共同验收规则：
1. file/doc missing/unreadable、containment、blob corruption、command failed、proof v2 不符/错绑仍为 error；不得豁免。
2. auto verify 仅认可当前 attempt 的 strong evidence、全部 acceptance 满足且无 active integrity/freshness 问题；人审开关永不被策略越过。
3. legacy/self-reported 无 proof 只能 human-only warning；不得借迁移或刷新伪造执行凭证。
4. 不在 health/query/verify 自动执行 command；命令执行必须复用受控执行通道，preflight 本身不等于安全执行沙箱。
5. 一个错误不能锁死无关任务，历史事实不因文件继续演进被静默抹除。

## 4. 实施触点与可直接立项的切片

- 切片1：lib/core/evidence.js 的 normalizeEvidence/auditEvidence，doc 的历史 hash 解析及 blob 读取；对照 lib/core/views.js 的历史文档读法与 lib/core/store.js 的 blob 接口。先评估 4ff4ebe，不能整批合入。补 test/evidence-audit.test.mjs 的 doc pinned 专项；主线候选之外的代码不改。
- 切片2：lib/core/commands/task-work.js 的新 refreshEvidence handler 与共享 coverage 重算；lib/core/handle.js 路由；lib/shared/contract.js、lib/host/tools/task.js、lib/host/routes/commands.js 的一致参数/鉴权；test/fixtures/tool-schema.json 和 CONTRACT 同步。actor 由入口可信上下文产生，不能信任 HTTP body 自称 human。
- 切片3：lib/core/evidence.js 统一 evaluator、lib/core/handle.js health、lib/core/views.js 诊断视图；src/client/views/task-drawer.js 和 src/client/labels.js 只显示可操作提示/刷新入口，按需拆到现有组件避免超限。UI 交互交用户手验，纯 evaluator/HTTP/schema 用自动测试；客户端改动重建产物，但不部署。
- lib/shared/events.js 的兼容注册只存在于当前 master 新线，不存在于7305de9，今后合入时须显式整合；新增 refresh 事实不能盲目声明 additive，只有可忽略且不影响任务投影的审计旁事件才可 additive。任务快照字段/事件改变须验证旧版本回读或明确 fail-closed。

## 5. 测试矩阵

| 维度 | 必须覆盖 | 预期 |
|---|---|---|
| doc pinned | rev1 提交后 head=rev2；提交/重启/verify | rev1 blob 原样可读则通过，不与 head 比 hash |
| doc 无效引用 | 非整数/0/负数/不存在rev/blob缺失/损坏 | 拒绝；无 task/rev/log 副作用 |
| file active | 同内容、内容变化、缺失、不可读、越界/链接、过大 | 同内容通过；变化需刷新/返工；其余硬错误 |
| refresh | human/agent/伪造actor、staleRev、非review、空reason、跨任务/跨acceptance、部分非法 | 只有合法整批人发起成功；失败全无副作用 |
| refresh 并发 | refresh→文件再改→verify；重复cmdId；重启回放 | 再变更仍挡；幂等；新旧证据和coverage一致 |
| command | 退出非0/timeout/error、proof v2错签/错task/attempt/ref、legacy无proof | 失败/错proof硬错；legacy human-only；不自动重跑 |
| attempt | reject→begin 后旧证据 supersede、多acceptance缺一条 | 不借旧证据满足新attempt |
| 历史 | done普通内容漂移、历史missing、active同路径 | 不改done、不阻无关写；missing仍error诊断；active规则不变 |
| 入口 | core/工具/已鉴权HTTP、auto/manual verify | 同一evaluator；human gate不被跳过 |
| policy | 默认值/存量/missing proof/agent降策略 | 不静默全开；不能解除硬错或人审 |

验收命令以备份脚本为准：npm test、npm run audit:check、npm run check:architecture；另跑明确专项及真实 esbuild 产物一致性。只用临时数据，不拿当前工作项目当测试数据。UI 首版若需要交互，由用户手验，不新增昂贵浏览器探针。

## 6. 存量 review 迁移与回滚

1. 不修改既有 commits/blobs、不批量改 evidence.hash、不把全体 done 打回review。只读列出 taskId/rev、evidenceId、旧hash/observedHash、分类、推荐动作；版本间统计分开。
2. 可验证 pinned doc 无需重提，只纠正解析语义；缺 blob/历史版本无法定位，明确报硬错，不 fallback head。旧无版本 ref 若未可靠绑定历史hash，保留 legacy human-only，不猜造版本。
3. live file 变更由用户逐项选择 refresh；源任务本身已变更需求或 command需重跑，则 reject→begin→submit。每次替换保留历史关系与原因。
4. 原有 begin supersede 记录不重写；只在目标任务上增量迁移，新 evidence 必须真实满足 acceptance。
5. 发布前在备份副本跑 replay/compat/计数与blob完整性检查，比较 active review 数量/问题分类。不能仅以“能打开”声称语义兼容。
6. 在用户完整验收前只保留开发分支。未来合入按单语义提交逐个验收；新事件若旧代码不能理解，旧代码拒绝打开，代码回退须同时考虑数据快照/RPO。没有声明可回读的证据，不承诺任意降级。

## 7. CONTRACT 建议文本（待实施后再替换正式条款）

- doc evidence.ref 固定为 docId@positiveIntegerRev，绑定该历史rev的不可变blob/hash。head前进不构成pinned evidence漂移；引用实体不可读/缺失或hash损坏为error。
- file evidence 默认为live，提交时记录hash，验收时重算；内容变化不自动更新hash，必须显式refresh或返工。查询不执行命令。
- task.refreshEvidence 为human-only review操作，携带expectedRev、reason和逐项replacement；旧证据保留且替换有审计；成功不自动done。command/test不允许通过此操作伪造执行。
- hard-error floor不可通过policy/waiver降级；legacy无执行proof仅warning且不可auto done。人审任务只允许用户最终verify。

## 8. 本次范围外

不实施人工豁免；不合并master；不部署/重启；不引入性能重写/TS迁移/独立服务。完整fsck、故障注入、状态矩阵、恢复runbook按原计划推进，不因本RFC宣布完成。简审不是全局复审，后续每个切片仍需独立测试和用户最终验收。

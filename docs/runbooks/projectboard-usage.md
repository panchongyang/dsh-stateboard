# ProjectBoard 使用说明

## 模型侧

- 项目简报已在会话系统提示中；需要核对某任务时用 `project_board view=task taskId=...`，取得 rev 与 allowedOps。不要为规则重复读取整个看板。
- `project_task op=claim → begin → submit`：领取租约、副作用前写 intent、附材料进入 review。提交与 reconcile completed 都不自动 done。
- 只建空项目用 `project_session op=init`，不需要占位任务。
- 审计门使用 `requiresAudit:true` / `gate:audit`；create/update/plan task 支持同字段。agent 只能在非 review 开门，不能关门；review 下 agent 不得改门。
- 独立 agent 可对审计门 `verify`，须带 `audit={report,checklist?:[{item,ok,note?}]}`。报告20–4000字，清单最多50项；独立性只在 session 级，排除 assignee、全部证据来源与 workers，不抵抗分身。
- 普通任务允许任意授权 agent（含提交者）显式 verify，无需报告。任意 agent 可带 reason 驳回 review（有 live lease 时仅持有者），unassign 仅 human。
- 项目板不执行、重跑或签名命令/测试证据；报告只是验收者声明，不是正确性证明。

## 外部 Agent 的历史知识读取

DSH 原生工具与项目授权 MCP 连接均提供同名的 `search_project_knowledge` 与 `read_project_knowledge`，业务参数与返回的来源、原文、游标和覆盖信息一致。DSH 自动从当前会话工作目录确认项目，不需要启用 MCP，也不传 `projectId/sessionToken`；MCP 传项目 ID 并复用 `open_work_session` 返回的工作会话。两侧纯读均不需要领取任务或写 intent。概览 read 连接不提供历史正文。入口授权差异见 [实现契约](../CONTRACT.md)。

1. 搜索当前任务的关键词或标识符，按需用 `kinds` 缩小来源类型。先看 `hits` 的原文片段、版本和 `coverage`，同时查看 `related` 的已有关系理由。
2. 选取返回的 `ref` 调用 `read_project_knowledge`；`mode=context` 可附带所属记录、明确版本的目标、已有关系和前后历史。正文分块有 `nextCursor`，继续读时传同一个引用与游标。
3. Agent 可自由提出新概念并重复搜索，不设累计联想轮数或跳转方向。可选 `discovery:{parents,reason}` 只记录在本次响应中，标为调用者线索，不写成正式项目关系。

没有搜到不等于没有约束。索引落后、扫描还有下一窗口、正文不可用和关联缺口分别在 coverage、游标、availability 与 `relatedUnavailable` 中说明；遇到 `knowledge-cursor-stale` 重启该查询或正文读取。外置文件改变后，旧引用返回变化，不能通过它读取新内容来替代旧原文。

索引自动按需创建，无 SQLite 时自动降级扫描。缓存是可失效的派生数据，不是外置正文备份；未留存的外置旧字节不承诺恢复。来源记录、检索相关性和约束当前有效性仍须分别判断。

## 人类侧

- 点卡片打开任务抽屉，verify/reject/gate 等操作按 allowedOps 启用。
- UI 请求身份为 human；人类可在 review 开关审计门，不受 agent 的 review 限制。
- human 可直接 verify，不需要报告或新配置；可选择驳回并说明原因。门控任务只能由 human cancel。
- 最近验收展示验收者、时间、报告、清单、证据 digest 与 warnings；普通 agent 验收标为「AI验收（自述）」，审计报告标为「AI审计（自述）」。
- 遇到内容漂移，human 可按提示 refresh/acknowledge；agent 只能返工或请求 human。遇到版本409先刷新，使用新 rev。

## 数据、升级与恢复

- 状态在 DSH home 的 project-board 下；一次命令一个 commit，内嵌正文在内容寻址 blobs 中，外置文档正文仍属于工作区。
- 运行时需要 schema3；v2 返回 `schema-migration-required`，由维护者停宿主、备份后使用包外离线迁移脚本。接口与备份回滚见[迁移](<../MIGRATION.md>)。
- schema3 未新增事件类型，旧构建可能静默丢门；回滚只能恢复迁移前备份与旧构建，不能仅退代码。
- interrupted 先 reconcile，不直接覆盖；不确定副作用先 interrupt，再明确对账。
- 本候选的验收不授权中途部署或真实迁移；宿主重启由用户执行，重启后刷新页面。UI 交互由用户手验，不新增浏览器探针。

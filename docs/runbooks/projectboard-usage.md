# ProjectBoard 使用说明

## 模型侧

- 项目简报已在会话系统提示中；需要核对某任务时用 `project_board view=task taskId=...`，取得 rev 与 allowedOps。不要为规则重复读取整个看板。
- `project_task op=claim → begin → submit`：领取租约、副作用前写 intent、附材料进入 review。提交与 reconcile completed 都不自动 done。
- 只建空项目用 `project_session op=init`，不需要占位任务。
- 审计门使用 `requiresAudit:true` / `gate:audit`；create/update/plan task 支持同字段。agent 只能在非 review 开门，不能关门；review 下 agent 不得改门。
- 独立 agent 可对审计门 `verify`，须带 `audit={report,checklist?:[{item,ok,note?}]}`。报告20–4000字，清单最多50项；独立性只在 session 级，排除 assignee、全部证据来源与 workers，不抵抗分身。
- 非门控 agent verify 403，应交由人类；不能临时在 review 开门。任意 agent 可带 reason 驳回 review（有 live lease 时仅持有者），unassign 仅 human。
- 项目板不执行、重跑或签名命令/测试证据；报告只是验收者声明，不是正确性证明。

## 人类侧

- 点卡片打开任务抽屉，verify/reject/gate 等操作按 allowedOps 启用。
- UI 请求身份为 human；人类可在 review 开关审计门，不受 agent 的 review 限制。
- human 可直接 verify，不需要报告或新配置；可选择驳回并说明原因。门控任务只能由 human cancel。
- 最近审计展示审计者、时间、报告、清单、证据 digest 与 warnings；agent 明确标为「AI审计（自述）」，不是人类核验。
- 遇到内容漂移，human 可按提示 refresh/acknowledge；agent 只能返工或请求 human。遇到版本409先刷新，使用新 rev。

## 数据、升级与恢复

- 状态在 DSH home 的 project-board 下；一次命令一个 commit，内嵌正文在内容寻址 blobs 中，外置文档正文仍属于工作区。
- 运行时需要 schema3；v2 返回 `schema-migration-required`，由维护者停宿主、备份后使用包外离线迁移脚本。接口与备份回滚见[迁移](<../MIGRATION.md>)。
- schema3 未新增事件类型，旧构建可能静默丢门；回滚只能恢复迁移前备份与旧构建，不能仅退代码。
- interrupted 先 reconcile，不直接覆盖；不确定副作用先 interrupt，再明确对账。
- 本候选的验收不授权中途部署或真实迁移；宿主重启由用户执行，重启后刷新页面。UI 交互由用户手验，不新增浏览器探针。

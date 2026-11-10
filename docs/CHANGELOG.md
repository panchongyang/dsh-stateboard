# Changelog

## Unreleased — 审查治理候选

- `requiresAudit` / `gate:audit` 表达第三方审计门。提交只进入 review；普通任务可由任意授权 agent（包括提交者）显式 verify，无需报告。审计门仍要求独立 agent 带报告，human 可验收所有任务。
- 任意 agent 可带 reason 驳回 review；遗留 live lease 保留持有者守卫，unassign 仅 human。agent 不得在 review 改门，其他状态只能开不能关。
- 最近验收记录保留验收者、时间、报告/清单、证据 digest、worker 快照与 warnings。普通 agent 验收标为「AI验收（自述）」，第三方审计标为「AI审计（自述）」。项目板不执行或签名证据命令。
- human verify 不要求报告或新配置；漂移 refresh/acknowledge、门控 cancel 与最终兜底保留给人类。
- schema v3 运行时拒绝 v2 store。维护者使用包外离线迁移工具，保留原提交并追加既有 project/task 事件，受影响草稿使用既有 plan/updated；没有新事件类型。回滚只能恢复迁移前备份与旧构建。
- 工具/API、digest、客户端审计门/最近审计展示与构建产物同步。计划 v7 使用一个统一候选任务的六组验收，一次关键点检查、一次独立总审与用户统一验收，不需要中途部署。

候选交付不是合入、真实迁移、部署或重启授权。

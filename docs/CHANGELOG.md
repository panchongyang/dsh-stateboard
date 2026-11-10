# Changelog

## Unreleased — 审查治理候选

- `requiresAudit` / `gate:audit` 表达第三方审计门。提交只进入 review，human 可验收；独立 agent 对审计门带报告显式 verify，非门控 agent verify 403。
- 任意 agent 可带 reason 驳回 review；遗留 live lease 保留持有者守卫，unassign 仅 human。agent 不得在 review 改门，其他状态只能开不能关。
- 最近审计记录保留 auditor、时间、报告/清单、证据 digest、worker 快照与 warnings。agent 标为「AI审计（自述）」；验收记录不证明交付正确，不执行或签名证据命令。
- human verify 不要求报告或新配置；漂移 refresh/acknowledge、门控 cancel 与最终兜底保留给人类。
- schema v3 运行时拒绝 v2 store。维护者使用包外离线迁移工具，保留原提交并追加既有 project/task 事件，受影响草稿使用既有 plan/updated；没有新事件类型。回滚只能恢复迁移前备份与旧构建。
- 工具/API、digest、客户端审计门/最近审计展示与构建产物同步。计划 v7 使用一个统一候选任务的六组验收，一次关键点检查、一次独立总审与用户统一验收，不需要中途部署。

候选交付不是合入、真实迁移、部署或重启授权。

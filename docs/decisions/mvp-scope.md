# MVP 范围与验收档案

> 状态：已归档，仅作历史背景。

保留重排前的范围与验收语义，不作为当前能力声明；现行行为见[实现契约](<../CONTRACT.md>)。章节号属于归档原文。

## 0. MVP 范围

必须可用：

- 项目：按 workspace 路径识别；创建/列出；active/paused/archived。
- 计划：一个项目可有多个计划（planHeads + 不可变版本表，命令/读模型见 §2.4.1、§2.5 与 [PLAN-V2.md](<../PLAN-V2.md>)）；`plan.publish` 原子创建 tasks；`plan.revise` 支持加/改/移除（移除标 orphaned）；draft/active/archived 生命周期、adopt/release 与 focus（human-only）。
- 任务：create/update/ready/claim/begin/submit/verify/reject/block/interrupt/unblock/release/reconcile/cancel/reopen。
- 文档：put/get/list/link；内容寻址 blob；`baseRev` 冲突。
- 进度：只从任务状态推导；不存百分比。
- 证据：file hash 与 doc 内容由服务端观测；command/test/note/url 只登记提交者材料，不执行、不探测、不判定成败。
- 崩溃：intent WAL；重启后 in_progress → interrupted/ready；reconcile 三种选择。
- 并发：进程内单写者；expectedRev CAS；lease + fencing token；cmdId 幂等。
- 模型面：7 个工具；per-agent digest（scoped section）。
- 界面：`main` 整页看板 + `sidebar.panellist` 图标 + `project_board` 内联 toolview；HTTP 轮询。
- 测试：core 单测/重放/并发/幂等；client bundle 冒烟；host 预检。

不做（MVP 明确不做）：

- 拖拽（用按钮/菜单）。
- SSE（2s 轮询）。
- 计划的拖拽排序 / 甘特图 / 模板（计划编辑用表单，非目标见 [PLAN-V2.md](<../PLAN-V2.md>) §13）。
- 血统级审计身份、autopilot、LAN/多用户、doc export、甘特图、工时。
- 跨进程实时同步（只有 lock 只读降级）。

## 6. 验收（M0–M4）

- `npm test` 全绿（core + client + smoke + host，数量以当前输出为准）。
- `npm run test:ci` 全绿（不依赖本机 DSH junction 的子集）。
- `npm run audit:check` 零违规（规模 / 分层 / 环）。
- `npm run check:architecture` 零缺失（ARCHITECTURE §2.1 ↔ 磁盘）。
- `node scripts/migrate-plans.mjs --project <id|dir> --dry-run` 在真实 store 副本上输出派生 planHeads、计划外/orphan 计数与 health 摘要，`sourceUnchanged: true`（用法见 MIGRATION.md）。
- 本机装配（`node scripts/install.mjs`）后，模型工具清单出现 7 个工具。
- 看板能从空项目创建一个 plan，显示任务；能 claim/begin/submit；人类能 verify。
- 崩掉/重启后，in_progress 任务变 interrupted，digest 顶部出现 RESUME CHECKLIST。
- 现有 DSH Web 功能不被破坏；回滚只需删 patch 行 + 链接。

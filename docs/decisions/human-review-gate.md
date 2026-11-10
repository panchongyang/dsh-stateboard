# 决策：人审门用 requiresHumanReview 开关，agent 只能开不能关

日期：2026-10-21
状态：已实现（0.1.1）

## 背景
之前设计有 gate:human 标签和 policy.verification，但工具/UI 没有设置口；试用时只能靠占位任务，agent 也不能直接设置或取消。用户要求：做成开关，agent 只能开、不能关，只有 human 能关。

## 决策
- 任务字段 requiresHumanReview: boolean 为唯一开关；gate:human 标签兼容旧数据。
- project_task op=gate taskId expectedRev requiresHumanReview 切开关，不需要租约。
- agent 可以设置 true；显式 false 返回 forbidden-role（gateLocked）；human 可以 true/false。
- 开启后 submit 停在 review；policy=auto 也不会自动 verify；只有 human/verifier 能 verify/reject。
- 已开启人审的任务 agent 不能 cancel，只有 human 能取消，防止绕过 review。
- UI 任务抽屉用复选框绑定开关；project_task create/update、project_plan step task 都可带 requiresHumanReview。

## 验证
- 当时基线核心测试 19/19，包含 gate 强制 review、agent 不能关、gated 任务只有 human 能取消。
- host preflight、host tools、routes、client smoke 均通过（历史验证记录，不是当前克隆可复跑的结果）。

## 未做
- 项目级 policy.verification 仍未接 UI/tool；如果要全项目默认人审，需要下一步加 policy 设置口。

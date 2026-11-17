# 查询 v2 首任务：最小契约

> 状态：待实施（本篇为方案/规格，不构成能力已交付声明）。

本轮仅确定接口与边界，不实施骨架、语法、求值、UI或迁移。完整规格仍以 [查询模块 v2 规格](<../specs/query-module-v2.md>) 为准。

## 人话版
1. 外面给任务和必要背景，模块只回答“这一条符合条件吗”。不联网取数、不保存任务副本。
2. “现在几点”也由外面给。当前数据用当前时间；未来历史快照用快照时刻，模块不偷看系统时钟。此次不实现历史查询。
3. 不会处理就明确报错，不假装查询成功，不悄悄显示全部。空查询才表示不过滤；页面遇到非法输入时保留上一条有效查询（页面接入阶段实现）。

## 沿用的接口
```js
createEngine(schema) -> { parse, validate, compile, format }
parse(text) -> { ok, ast, errors }
validate(text) -> { ok, ast, canonical, errors }
compile(ast) -> (row, ctx) => boolean
format(ast) -> string
```
导出名固定为 `createEngine`、`taskQuery`、`queryFromLegacyRules`、`TASK_SCHEMA`、`LIMITS`、`ERROR_CODES`。`validate` 是页面/存储唯一校验入口；`compile` 不绑定 context。

数据源为 `QuerySource { id, label, rows, ctx: { now, plans } }`：id/label供宿主标识与显示，rows是卡片，now为毫秒时间，plans为该数据源对应的计划目录。计划目录具体结构、schema内部结构及常量键名留实现前最小确认，本轮不额外冻结。当前/历史源不得混用计划目录。

## 实现切口
首个骨架可只支持空查询；非空表达式明确失败，未知AST拒绝，legacy迁移函数明确未实现。不可用占位实现冒充完整语法支持。依赖只允许模块内部与未来无依赖task-model；不得引入UI、网络、状态、core/host或历史回放。

## 交接状态
首任务未完成，不提交验收、不自验、不合入部署。已创建独立候选分支 `work/query-v2-s1-20261029`，基线 `c5d2263`；候选工作树为独立工作区（本机留证）。范围仅限契约确认，实现待后续授权。

delegation: yes — 原有界骨架实现已派发；用户收缩范围后通知立即停止，不继续代码/测试工作。

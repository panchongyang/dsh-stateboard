# 方案：看板 → 会话（反向跳转）

会话 → 看板已通。这篇写反方向，把**入口加在哪**、**跳转逻辑**写死。

## 1. 数据从哪来

| 来源 | 字段 | 含义 |
|---|---|---|
| 领取者 | `task.owner.sessionId` | 当前持租约的会话 |
| 证据 | `evidence[].producedBy.sessionId` | 谁提交的这条证据 |
| 会话目录 | `ctx.get('sessions').list` 的 `byId[*].cwd / updatedAt` | 用于「工作区最近会话」 |

## 2. 切会话的 API（已探明）

`ui-conversation` 里：`const workspaceNavigation = ctx.get("uiWorkspace")`，会话面板 inject 就是 `open: (id) => workspaceNavigation.openSession(id)`。看板页同样 `ctx.get('uiWorkspace').openSession(sessionId)`，不新增 inject。

## 3. 入口清单（三处）

| # | 位置 | 元素 | 数据 | 何时出现 |
|---|---|---|---|---|
| **E1** | 任务抽屉头部 meta 行 | chip `会话 s-xxxx` + 来源后缀（`进行中` / `最近提交`） | `pickTaskSession(task)` | 有目标可点；无则灰字「无关联会话」 |
| **E2** | 任务抽屉「证据」每条 | 行尾链接「来源会话」 | `evidence[].producedBy.sessionId` | 该条有 sessionId 才渲染 |
| **E3** | **看板页头部**（`pb-header__actions`，在「新建项目」与「刷新」之间） | 图标按钮「最近会话」 | `pickLatestSession(sessionsById, project.workspacePath)` | 选中项目时显示；点击时无可用会话则 toast |

不加：时间线（系统 actor 噪音）、看板卡片（密度）、计划视图行（抽屉已覆盖）。

E1/E3 的分工：E1 回答「**这条任务**是谁在做的」，E3 回答「这个**工作区**最近在聊什么」——不依赖任何任务。

## 4. 跳转逻辑

```js
// E1/E2：任务级
function pickTaskSession(task) {
  if (task.owner && task.owner.sessionId) return { sessionId: task.owner.sessionId, source: 'owner' };
  var items = (task.evidence || []).slice().sort(function (a, b) {
    return String(b.at || '').localeCompare(String(a.at || ''));
  });
  for (var i = 0; i < items.length; i += 1) {
    var id = items[i].producedBy && items[i].producedBy.sessionId;
    if (id) return { sessionId: id, source: 'evidence' };
  }
  return { sessionId: null, source: null };
}

// E3：工作区级，取 updatedAt 最大的非空会话
function pickLatestSession(byId, workspacePath) {
  var target = comparablePath(workspacePath);
  var best = null;
  Object.keys(byId || {}).forEach(function (id) {
    var s = byId[id] || {};
    if (!s.cwd || s.blank || s.origin === 'subagent') return;
    if (comparablePath(s.cwd) !== target) return;
    if (!best || (s.updatedAt || 0) > (best.updatedAt || 0)) best = { sessionId: id, updatedAt: s.updatedAt || 0 };
  });
  return best;
}

// 唯一出口
function openSessionById(ctx, sessionId, notify) {
  if (!sessionId) { notify('info', '这个工作区还没有会话'); return false; }
  var nav = ctx.get('uiWorkspace');
  if (!nav || typeof nav.openSession !== 'function') { notify('error', '当前界面不支持跳转会话'); return false; }
  try { nav.openSession(sessionId); return true; }
  catch (error) { notify('error', '会话不存在或已归档'); return false; }
}
```

E3 点击流程：`sessions.list.getSnapshot().byId` → `pickLatestSession(byId, project.workspacePath)` → `openSessionById`。快照在点击时读，不做实时订阅（按钮不需要显示会话名）。

## 5. 交互细节

- E1 chip / E3 按钮：`<button>`，有 hover / active / focus-visible（hover 修复那套 token fallback 一起复用）。
- E1 灰态：`<span>` + `cursor: default` + `title`。
- E2 链接：小号文字链。
- 三个入口都走 `openSessionById`，不各写一套。

## 6. 测试

- `pickTaskSession`：owner / 证据 / 两者都有（取 owner）/ 都没有 / 证据按时间取最近 / 证据缺 `producedBy` 跳过。
- `pickLatestSession`：同工作区取最新 / 过滤 blank 与 subagent / 工作区路径大小写与分隔符 / 空列表返回 null。
- `openSessionById`：nav 缺失、openSession 抛错、sessionId 为空三种都要有反馈。

## 7. 风险

- 目标会话已归档/已删 → 捕获后 toast，不猜替代会话。
- 跳转后看板卸载（slots 的 main 单槽位），返回时抽屉关闭——本轮不做状态持久化。
- E3 依赖 `ctx.get('sessions')` 的 `byId` 结构（`cwd`/`updatedAt`/`blank`/`origin`）；如果上游改字段，按钮会退化成「没有会话」提示，不会崩。

## 8. 顺带修掉的（已完成）

会话头部入口没有 hover 反馈：`--pb-*` 只定义在 `.pb-root`，头部入口在它外面。已给 `.pb-jump` 补自带 fallback 的 hover / active / focus-visible。

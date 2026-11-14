# 实施方案：文档 ↔ 任务关联（反查 + 写校验 + 任务页资产区）

> 状态：已替代（现行语义见[实现契约](<../CONTRACT.md>)；正文保留方案或决策时的语境）。

配套设计文档：《方案：文档 ↔ 任务的关联》（内部记录，未随仓库分发）。

## 0. 已定：资产区只放"挂着的"，明细留在下面（方案 A）

任务页第一屏要回答"这任务挂着什么"。所以新开一个**关联资产**区，放在验收之前；证据只在资产区显示条数，明细仍在原位置。

## 1. 验收 → 实现映射

| 验收 | 实现点 | 状态 |
|---|---|---|
| taskView 返回 linkedDocs；digest FOCUS 段出 docs 行 | views.js `docsForTask` + taskView；digest.js FOCUS 段 | ✅ 已实现 |
| doc.put / doc.link 拒绝未知 taskId / planRef；历史坏链接在 health 告警 | service.js `normalizeDocLinks`；fsck.js `checkState` | ✅ 已实现 |
| 任务页第一屏可见关联资产；文档页可编辑关联任务 | client.js TaskDrawer / BoardPage / DocsPane | ⏳ 待做 |

## 2. core（已完成）

### 2.1 views.js
- `docsForTask(state, taskId)`：遍历 `state.docs`，保留 `links.taskIds` 含该 id 的，按 `updatedAt` 倒序，返回 `{ id, rev, title, kind, updatedAt }`（不带正文）。
- `taskView` 增加 `linkedDocs`；`briefView.focus` 也带上 `linkedDocs`（digest 只能看到 brief）。

### 2.2 digest.js
- FOCUS 段在 `acceptance … · evidence …` 后追加 `  docs: doc_x r2 "标题"; …`，最多 3 条，其余记 `+N`；无文档时不出现，保证既有 digest 逐字节不变。

### 2.3 service.js
- `normalizeDocLinks(state, links)`：taskIds 去空去重、上限 100、必须存在（否则 `invalid-command` + `details.unknownTaskIds`）；planRefs 校验 `planId@version`；`links` 未传返回 undefined（语义仍是"不改"）。
- `_docPut` / `_docLink` 统一走它；被拒绝的写入不落盘。

### 2.4 fsck.js
- 每篇文档两条检查：`doc-link-task:<docId>`、`doc-link-plan:<docId>`，只告警不阻断。

## 3. client（待做）

### 3.1 抽屉结构（新）

1. 头部：状态 / 优先级 / 负责人 / 计划步骤（`planRef` → `plan@v · step`）
2. **关联资产**（新，放在验收之前）
   - 计划条：有 planRef 才显示
   - 关联文档：chips `标题 · 类型 · rN`，点击 → 文档页；空态一句"还没有关联文档"+「去关联」入口
   - 证据：只显示 `证据 N 条`，点击滚动到下面明细
3. 验收 → 证据明细 → 操作区 → 时间线（顺序不变）

### 3.2 BoardPage
- `docFocus` state；`openDoc(id)` → 切到 docs tab 并带上 docId。
- TaskDrawer 传 `onOpenDoc`；DocsPane 传 `initial` 与拍平的任务列表；换 tab / 换项目时清空。

### 3.3 DocsPane
- 状态行加「关联任务 N」chips（点击跳任务）。
- 「编辑关联」内联多选任务；保存走 `doc.link`，**必须回填原 planRefs**（全量覆盖语义）。
- 文档列表项加 `N 个任务`。

## 4. 兼容与回滚
- 无事件/存储变更；回滚 = 退代码。
- 历史坏链接：读时过滤、health 告警，不迁移。
- `project_doc` 校验变严是新行为，CHANGELOG 记一条。

## 5. 测试（core 部分已过）
- core.test.mjs：linkedDocs 过滤/去重/排序、digest docs 行、未知 task / plan 被拒、坏链接 health 告警 —— 22 项全绿。
- client-smoke.mjs：`__test.docsForTask`、抽屉 Section 存在性。
- routes.test.mjs：GET /tasks/:id 含 linkedDocs。

## 6. 顺序与进度
1. core 读模型 ✅
2. core 写校验 + health ✅
3. client（资产区 / 文档页 / 计数）⏳
4. CHANGELOG 与文档收尾 ⏳

## 7. 风险
- 抽屉首屏变长，窄屏（<420px）要单独看一档。
- `doc.link` 全量覆盖，编辑器漏回填 planRefs 会清空。
- 上限 100 是拍的，真实超了再调。

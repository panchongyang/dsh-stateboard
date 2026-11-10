# 前端分层与迁移基线

> 状态：六层结构与 hooks 收口就位；model/utils/api 的 23 个实现模块为 `.ts`，共享最小投影接口在 `model/types.ts`；pages/components 的 23 个视图模块为 TSX/classic JSX，hooks 与根入口使用 `.ts`；请求取消与票据由 api 持有。本文描述六层职责、迁移映射与行为冻结面。
> 对应计划：「前端可读性计划：分层结构 · JSX/TS 工具链 · 注释与 TSX 重构」S1。

## 1. 目标与非目标

目标：把扁平的 `src/client/*.js` + `views/*.js` 收敛为 `pages / components / hooks / model / utils / api` 六层，让页面编排、纯投影、React 适配、领域读模型、纯工具和 HTTP 边界各自可读、可测、可机械校验；纯逻辑与 API 使用 `.ts`，页面与组件使用 `.tsx` + classic JSX，hooks 与入口使用 `.ts`；前端除 CSS 外全量 TS/TSX，后端允许 JS/TS 混用。

非目标：不改变交互、DOM/class 或命令语义；类型与 JSX 只表达现有行为。迁移期间 `__test`/`__ui` 导出、4 个 slot、轮询/超时/退避、CSS 与 bundle 外壳保持不变。

## 2. 目标目录

```text
src/client/
  index.ts                 入口与 slot 注册
  styles.css / styles.ts   样式源与注入；保留在根
  react.d.ts / css.d.ts    宿主 React/JSX 与 CSS 文本最小 ambient 声明；零依赖、无运行时代码
  api/                     .ts：transport（唯一 fetch）、request-gate、read-lifecycle
  model/                   .ts：领域读模型与纯状态：state、selectors、session-jump、races、
                           filters、grouping、labels、payloads、storage、plan-edit、
                           external-docs、external-payloads、doc-view、
                           page-access、project-location；types.ts / view-types.ts 只共享投影接口
  hooks/                   .ts：React 适配：use-page-read（页面读取/访问/目录/资源 hooks）、
                           page-navigation（context 与 usePageWrite）、use-toasts、
                           use-external-docs、use-health
  components/              .tsx/classic JSX + 命名 Props 接口：纯投影：primitives、icons、content、drawer、slots、chrome、
                           board、plan、plan-edit-task、task-composer、task-detail、doc-reader
  pages/                   .tsx/classic JSX + 命名 Props 接口：页面编排：board-page、plans、docs、health、create-project、plan-edit、
                           task-drawer、task-create、external-panel、external-forms、doc-list
  utils/                   .ts：无副作用纯工具：format、markdown、chart、flow、export
```

## 3. 分层职责与依赖矩阵

| 层 | 放什么 | 不做什么 |
|---|---|---|
| `pages` | 页面级状态编排、路由/标签、把 `data/actions/ui` 交给投影组件 | 不直接 `fetch`，不实现领域规则 |
| `components` | 只读 props 的 React 投影；基础组件与领域展示组件 | 不取数、不发命令、不持有页面生命周期 |
| `hooks` | React 适配：把 `model`/`api` 的生命周期接到 `useState/useEffect` | 不写领域规则，不直接拼 HTTP |
| `model` | 纯状态、选择器、payload、持久化归一、导航意图、超时/退避策略常量 | 不 import React，不 import components/pages |
| `utils` | 无副作用纯函数（解析、格式化、布局） | 不 import React、不读宿主、不发请求 |
| `api` | 唯一 `fetch` 边界、请求票据与取消、资源读生命周期 | 不做领域判断、不碰 React |

**跨层规则**（机器门禁的目标）：

```text
pages      → components / hooks / model / utils / api
components → components / model / utils
hooks      → api / model / utils
model      → model / utils
api        → model / utils
utils      → utils
```

- 只约束**跨层方向**；各层允许同层 import（如 `model/grouping → model/selectors`、`components/board → components/primitives`），但全图必须 0 环。
- `components` 不依赖 `hooks`：Drawer 改用 props（见 §5.2）；context 与写适配在 `hooks/page-navigation.ts`；`model` 不 import React。
- 唯一 `fetch` 在 `api/transport`；看板/项目读轮询在 `api/read-lifecycle`（见 §5.1）。健康页的固定 5s 轮询不属于该生命周期，S3 只抽成同语义 hook，不合并。

## 4. 当前结构与验证入口

| 指标 | 实测 | 复跑方式 |
|---|---|---|
| `src/client` 文件 | 59（32 TS + 23 TSX + `react.d.ts` + `css.d.ts` + `styles.css` + 编辑器 `tsconfig.json`）；32 TS 含 30 个实现模块与 2 个共享类型模块 | `git ls-files src/client`（含候选新增文件） |
| 分层模块 / 依赖环 | 57 / 0；model=17、utils=5、api=3；根 `react.d.ts` / `css.d.ts` 仅 ambient 声明 | `node scripts/check-client-layers.mjs --strict` |
| 前端类型检查 | `strict:true`、`allowJs:false`、`noEmit`；无 JS 文件 | `npm run typecheck:client` |
| `fetch` 位置 | 仅 `src/client/api/transport.ts` | 客户端分层门禁 |
| 轮询 | `api/read-lifecycle.ts` 2s + 退避；`hooks/use-health.ts` 独立 5s `setInterval`；`useTask` 无 5s 轮询 | 纯逻辑与生命周期单测 |
| 请求超时 | `REQUEST_TIMEOUT_MS = 8000`；命令/文档 15000 | `model/races.ts`、`api/transport.ts` |
| `__test` / `__ui` | 78 / 32 键 | 执行 `lib/client.js` 计数脚本（见 §7） |
| bundle | 单文件与外置 sourcemap；两次构建 SHA 一致 | `npm run build:client` |
| 客户端测试 | `npm run test:client` 130/130 pass | 同左 |
| 架构清单 | 75 entries / 136 paths / 0 missing | `npm run check:architecture` |
| CSS sha256 | `e32e0cb3dc43fba6d605d3f7a9edfc76b17a26d82cfc87cf70df0a1ca7c7fd4e` | `node -e "..."`（§7） |

## 5. 关键设计决策

### 5.1 读生命周期：两种语义，S3 不合并

现状是两套不同的读语义：

- `api/read-lifecycle.ts`：请求完成后才调度下一轮（2s）、合并进行中的请求、失败退避、8s 超时、可见性暂停与迟到响应隔离。
- `hooks/use-health.ts`：固定 5s `setInterval`，可重叠、失败不退避；没有读生命周期的额外 8s 包装，但 `transport.api` 对所有请求（含 health）默认套 8000ms `AbortController`，抽取时必须保留该传输层超时。

S3 只做结构搬移，不把 health 改走 `read-lifecycle`：

- `api/read-lifecycle.ts` 保留 `page-read` 的 2s/退避/超时语义；`hooks/use-page-read.ts` 只做订阅。
- `hooks/use-health.ts` 抽出现有固定 5s 调度，保持“固定间隔、可重叠、无退避”的语义；`pages/health` 不再自己写 timer。
- 统一调度列为后续独立任务，前提是证明健康检查可接受“完成后再调度、退避与超时变化”；不得在结构迁移里顺带改行为。
- 验证：对两套语义分别做迁移前后对照（2s/退避/8s 超时；固定 5s/可重叠），并 `client-smoke` + 手动网络面板。

### 5.2 导航上下文：React 归 hooks，领域断言归 model

页面容器 `pages/task-create.tsx`、`pages/task-drawer.tsx` 与 `hooks/use-external-docs.ts` 使用 `hooks/page-navigation.ts` 的 context/write 适配；`components/drawer.tsx` 仅接收 props。职责落点：

- `model/project-location.ts`：纯导航意图、`snapshot()`、`assertWritable()`；不 import React。
- `hooks/page-navigation.ts`：`PageNavigationContext` 与 `usePageWrite`，组合 context 与 `assertWritable`，供 pages/hooks 使用。
- `components` 不 import hooks：`Drawer` 由页面传 `suspended` prop（布尔或 getter，默认 false）；页面传 snapshot getter，文档事件处理器读最新 prop，保证同步导航意图发布后立即禁止关闭。`task-create`/`task-drawer` 留 pages，继续使用 context/usePageWrite；`use-external-docs` 属 hooks 层。

### 5.3 `selectors` 与 `storage` 的拆分

- `model/selectors.ts` 只做纯选择器；`openSessionById`（宿主 ctx 副作用）由 `model/session-jump.ts` 持有。
- `model/storage.ts → grouping/labels` 是 model 同层依赖，合法；不把它们降级为 utils，也不复制纯逻辑。

### 5.4 classic JSX 与动态标签登记

所有静态 DOM/组件结构使用 JSX，编译工厂为 `React.createElement` / `React.Fragment`；不能引入 `react/jsx-runtime`。`src/client/react.d.ts` 只声明宿主提供的 React API、事件与最小 DOM 属性，不提供运行时，也不依赖 `@types/react`。`model/view-types.ts` 描述页面/列表/详情投影；components 不 import hooks/api。

仅以下 5 处保留直接 `React.createElement`，对应文件头也登记原因；不得引入 `h` 别名：

| 文件 / 组件 | 动态项 | 原因 |
|---|---|---|
| `components/content.tsx` / Markdown | `tag` | Markdown 标题级别决定 h2–h4 标签 |
| `components/content.tsx` / Markdown | `listTag` | Markdown 顺序列表选择 ol/ul，并保留 start 属性 |
| `components/primitives.tsx` / Button | `props.icon` | 由调用者提供图标组件 |
| `components/primitives.tsx` / IconButton | `props.icon` | 由调用者提供图标组件 |
| `components/primitives.tsx` / EmptyState | `props.icon || IconInbox` | 调用者图标与默认图标的运行时选择 |

`document.createElement('textarea')` 是剪贴板降级所需的原生 DOM 调用，不是 React 静态结构。

## 6. 逐文件映射

| 迁移输入路径 | 基线行数 | 职责 | 归属层 | 落点路径 | 备注 |
|---|---:|---|---|---|---|
| `src/client/chart.js` | 130 | 图表 spec/布局/SVG path | utils | `src/client/utils/chart.ts` | 纯逻辑 |
| `src/client/content.js` | 253 | Markdown/ChartView 渲染 | components | `src/client/components/content.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/doc-view.js` | 267 | 文档列表筛选/分组/行摘要 | model | `src/client/model/doc-view.ts` | 纯读模型 |
| `src/client/drawer.js` | 86 | 通用 Drawer | components | `src/client/components/drawer.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/export.js` | 44 | 安全文件名/导出 | utils | `src/client/utils/export.ts` | 纯逻辑 |
| `src/client/external-docs.js` | 402 | 外置文档读模型/合并/管理视图 | model | `src/client/model/external-docs.ts` | 纯读模型 |
| `src/client/external-payloads.js` | 169 | 外置文档命令 payload/错误视图 | model | `src/client/model/external-payloads.ts` | 纯逻辑 |
| `src/client/filters.js` | 40 | 看板筛选 | model | `src/client/model/filters.ts` | 纯逻辑 |
| `src/client/flow.js` | 191 | Flow spec/布局 | utils | `src/client/utils/flow.ts` | 纯逻辑 |
| `src/client/format.js` | 87 | 数值/时间/class 工具 | utils | `src/client/utils/format.ts` | 纯逻辑 |
| `src/client/grouping.js` | 110 | 任务分组 | model | `src/client/model/grouping.ts` | 依赖 selectors/labels，同层 |
| `src/client/hooks.js` | 134 | React 数据 hook/页面写作用域 | hooks | `src/client/hooks/use-page-read.ts`、`page-navigation.ts`、`use-toasts.ts` | 拆分见 §6.1 |
| `src/client/icons.js` | 38 | 图标组件 | components | `src/client/components/icons.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/index.ts` | 184 | 入口/slot/导出 | 保留 | `src/client/index.ts` | TS 装配入口 |
| `src/client/labels.js` | 205 | 状态/计划/证据文案 | model | `src/client/model/labels.ts` | 纯映射 |
| `src/client/markdown.js` | 252 | Markdown 解析/行内 | utils | `src/client/utils/markdown.ts` | 纯逻辑 |
| `src/client/page-access.js` | 25 | 页面凭据状态 | model | `src/client/model/page-access.ts` | 单例状态 |
| `src/client/page-read.js` | 99 | 读生命周期（轮询/退避/可见性） | api | `src/client/api/read-lifecycle.ts` | 参数化 poll；取消在 api |
| `src/client/payloads.js` | 75 | 任务/证据命令 payload | model | `src/client/model/payloads.ts` | 纯逻辑 |
| `src/client/plan-edit.js` | 335 | 计划编辑纯模型 | model | `src/client/model/plan-edit.ts` | 草稿归一、差异和 payload；不 import React |
| `src/client/primitives.js` | 279 | 基础组件 | components | `src/client/components/primitives.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/project-location.js` | 54 | 初始项目定位/导航意图 | model | `src/client/model/project-location.ts` | 纯状态 + 控制器 |
| `src/client/races.js` | 57 | 票据/超时/退避 | api / model | `src/client/api/request-gate.ts` + `src/client/model/races.ts` | 票据/取消归 api；纯常量与退避归 model |
| `src/client/selectors.js` | 191 | 派生选择器 + 会话打开 | model | `src/client/model/selectors.ts` + `src/client/model/session-jump.ts` | 拆分副作用（§5.3） |
| `src/client/slots.js` | 65 | 宿主槽位组件 | components | `src/client/components/slots.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/state.js` | 24 | 全应用单例 | model | `src/client/model/state.ts` | 可变单例，注释写明双入口风险 |
| `src/client/storage.js` | 81 | 视图/筛选持久化 | model | `src/client/model/storage.ts` | 依赖 grouping/labels，同层 |
| `src/client/styles.css` | 1725 | 样式源 | 保留 | `src/client/styles.css` | 构建内联 |
| `src/client/styles.ts` | 14 | 样式注入 | 保留 | `src/client/styles.ts` | 唯一样式副作用 |
| `src/client/transport.js` | 112 | 唯一 fetch/HTTP | api | `src/client/api/transport.ts` | 唯一网络边界 |
| `src/client/views/board-page.js` | 333 | 应用外壳/页面编排 | pages | `src/client/pages/board-page.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/board.js` | 279 | 看板/列/卡片/列表 | components | `src/client/components/board.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/chrome.js` | 185 | 顶栏/布局 | components | `src/client/components/chrome.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/create-project.js` | 73 | 创建项目页 | pages | `src/client/pages/create-project.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/doc-list.js` | 216 | 文档列表 + 取数 hook | pages | `src/client/pages/doc-list.tsx` | 列表与取数 hook 保留页面容器 |
| `src/client/views/doc-reader.js` | 104 | 文档阅读 | components | `src/client/components/doc-reader.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/docs.js` | 343 | 文档页 | pages | `src/client/pages/docs.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/external-forms.js` | 226 | 外置文档表单 | pages | `src/client/pages/external-forms.tsx` | 登记写入与表单保留页面容器 |
| `src/client/views/external-hooks.js` | 73 | 外置文档数据 hook | hooks | `src/client/hooks/use-external-docs.ts` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/external-panel.js` | 209 | 外置文档面板 | pages | `src/client/pages/external-panel.tsx` | 观测/写入容器，复用 use-external-docs |
| `src/client/views/health.js` | 134 | 健康页 + 5s 轮询 | pages | `src/client/pages/health.tsx` | 调用 `hooks/use-health.ts`，固定 5s 调度语义保留 |
| `src/client/views/plan-edit-task.js` | 131 | 计划编辑任务行 | components | `src/client/components/plan-edit-task.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/plan-edit.js` | 300 | 计划编辑页/差异面板 | pages | `src/client/pages/plan-edit.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/plan.js` | 138 | 计划详情/任务行 | components | `src/client/components/plan.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/plans.js` | 389 | 计划页 | pages | `src/client/pages/plans.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/task-composer.js` | 199 | 任务表单 | components | `src/client/components/task-composer.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/task-create.js` | 119 | 新建任务抽屉 | pages | `src/client/pages/task-create.tsx` | 写入入口保留页面容器；使用 context/usePageWrite |
| `src/client/views/task-detail.js` | 124 | 任务详情 | components | `src/client/components/task-detail.tsx` | 保持导出名称、DOM/class 与事件语义 |
| `src/client/views/task-drawer.js` | 420 | 任务抽屉 | pages | `src/client/pages/task-drawer.tsx` | 任务读取/写入保留页面容器；展示复用 components |

### 6.1 `hooks.js` 拆分

`hooks/use-page-read.ts` 保留内部 `usePageRead` 与 `usePageAccess/useMainViewCwd/useProjects/useBoard/usePlans/useTask`；`hooks/page-navigation.ts` 保留 `PageNavigationContext/usePageWrite`；`hooks/use-toasts.ts` 保留 toast 状态与计时。每文件 ≤200 行；外置文档与健康调度分别在 `use-external-docs.ts`、`use-health.ts`。

## 7. 行为冻结与核对命令

迁移期间不得改变以下表面；每批 PR 必须记录核对结果：

- `__test` 78 键、`__ui` 32 键（键名与数量；只增需登记）。
- 4 个 slot：`main`、`sidebar.panellist`、`conversation.session.header.utilities`、`tool.call.toolview`，以及各自 `key/id/order`。
- 轮询：看板 2000ms、失败退避、隐藏暂停；健康检查固定 5000ms `setInterval`（可重叠、无退避，语义不变）；`useTask` 仍只在挂载/`refreshKey` 时刷新。
- 超时：`REQUEST_TIMEOUT_MS = 8000`；命令/文档写入 15000；`transport.api` 对 health 等所有请求默认套 8000ms，抽 `use-health` 时不得移除。
- bundle 结构不变量：单文件、UMD 外壳、`external: ['react']`、不 minify、sourcemap external；字节数只做每批记录，不要求跨结构搬移相等。CSS sha256 保持（样式源不变）。

```bash
npm run test:client
npm run build:client
git status --short -- lib/client.js lib/client.js.map
npm run check:architecture
node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('src/client/styles.css')).digest('hex'))"
```

## 8. 与 `docs/ARCHITECTURE.md` 的同步面

| 位置 | 当前约定 |
|---|---|
| §1 分层图 | model/utils/api 为 TS，pages/components 为 TSX/classic JSX，hooks 与入口使用 TS |
| §2.1 arch-map | pages/components 用 `*.tsx`，hooks 用 `*.ts`，model/utils/api 用 `*.ts` 单星条目；根 `react.d.ts` / `css.d.ts` 显式列出，显式保留入口、样式与 api/request-gate.ts、api/read-lifecycle.ts |
| §2.1 checker 能力 | 只支持段内单星，不使用 `components/**` |
| §2.2 职责分组 | 六层各列职责；有读写的编辑器/列表容器留 pages |
| §5 冻结面 | `__test` 78 / `__ui` 32，4 个 slot 不变 |
| §5 客户端依赖顺序 | 六层矩阵；api/transport 唯一 fetch，hooks 仅适配 |
| §6 构建 | 支持 `.ts/.tsx` 与 classic JSX；单 bundle、外置 sourcemap、noEmit 类型检查 |

`lib/client.js` 是提交产物；任何源码搬移都要重建并提交 bundle 与 sourcemap。

## 9. 注释口径（前移，做到哪补哪）

- **模块头**：职责、边界（不做什么）、关键不变量/副作用。跨层或单例模块（`state`、`read-lifecycle`、`transport`）必须写清“为什么只能有一个入口”。
- **为什么注释**：只写在非显然处——顺序依赖、迟到响应、租约/导航 fencing、降级与回退、性能取舍。禁止复述代码。
- **接口注释**：已迁移 `.ts` 的导出函数用真实 TypeScript 参数/返回值和稳定对象接口；注释只补类型未表达的失败语义与边界。`.tsx` 组件写 props 接口，不重复类型已表达的信息。
- **增量策略**：S3 每批**触达即补**，不要求一次补全；S4 只补类型/JSX 引入后仍缺的边界说明，不设集中补注释任务。未触达文件登记为增量清单，随下一次改动补齐。
- **维护方式**：每批 PR 描述列 `touched files`；reviewer 只要求本批触达文件有模块头/关键 why；未触达文件不阻塞。S1 文档的映射表作为总清单。

## 10. 迁移批次与回滚

覆盖核对：3 个保留（`index.ts`、`styles.css`、`styles.ts`）+ A 21 + B 24 + C 1 = 49 个 tracked 文件。

每批是**单个提交**，提交内包含重建后的 `lib/client.js` 与 sourcemap。验证顺序固定：

1. 提交前：`npm run test:client`、`npm run build:client`、`npm run check:architecture`、`npm run audit:check`、`npm run check:client-layers`，并做本批行为/产物对照。
2. 提交源码与重建产物。
3. 提交后再跑 `npm run build:client`，要求 `git status --short -- lib/client.js lib/client.js.map` 为空，证明提交的产物可由该源码复现。**不得在提交前要求 bundle 工作区干净**；结构搬移本来就会改变产物。

回滚：`git revert <该批提交>` → `npm run build:client` → `npm run test:client`；冲突在候选分支解决，不在基线现场处理。`check:client-layers` 由 S1 的 T2 落地，S3 开工前必须存在。

### 批次 A（T5）：model / utils / api（21 文件）

搬移 21 个：`chart, doc-view, export, external-docs, external-payloads, filters, flow, format, grouping, labels, markdown, page-access, page-read, payloads, plan-edit, project-location, races, selectors, state, storage, transport`。其中 `page-read → api/read-lifecycle.ts`、`races → model/races.ts` + `api/request-gate.ts`；`selectors` 拆 `model/selectors.ts` + `model/session-jump.ts`。更新全部 import 与单测导入。

验证：按 §10 统一顺序，`check:client-layers` migration 模式 0 violations；C 批收口后启用 strict。回滚：按统一顺序执行。

### 批次 B（T6）：components / pages + docs 垂直切片（24 文件）

搬移 24 个：`content, drawer, icons, primitives, slots, board-page, board, chrome, create-project, docs, doc-reader, doc-list, external-forms, external-hooks, external-panel, health, plan, plan-edit, plan-edit-task, plans, task-composer, task-create, task-detail, task-drawer`（前 5 个在根，其余在 `views/`）。

B 内按现有职责收口，不把页面容器硬拆成 props：

- `doc-list`、`external-panel`、`external-forms`、`task-drawer`、`task-create` 留在 pages，保持原有取数/写入与表单行为。
- `external-hooks → hooks/use-external-docs.ts`；`pages/external-panel` 继续使用它。
- `components` 只有投影，不依赖 hooks/api；Drawer 接受页面的 `suspended` getter，所有调用点（含加载态）都传递它。
- BoardPage、DocsPane、PlanPane 与 createPageRead 提取局部 helper 以满足函数规模门禁，不改变返回值、事件与 DOM。
- `__ui` 仍 32 键，组件导出名保持；页面通过 hooks 目录适配数据与导航。

验证：按 §10 统一顺序，另加 `__ui` 32 键、`client-smoke` 与 看板、详情、计划、文档页人工点检。回滚：按统一顺序执行。

### 批次 C（T7）：hooks 收口（1 文件 + health hook）

页面 hooks 按读资源、导航写作用域与 toast 分为 3 个文件（见 §6.1）；把 `pages/health` 的固定 5s 调度抽到 `hooks/use-health.ts`（保持固定间隔、可重叠、无退避，语义不变）；确认 `fetch` 只在 `api/transport`；票据在 `api/request-gate`，取消与读生命周期在 `api/read-lifecycle`。

验证：按 §10 统一顺序，另加 `__test` 78 键、`grep -R "fetch(" src/client` 仅 `api/transport.ts`、轮询两套语义对照表。回滚：按统一顺序执行；C 依赖 B 时只回 C、保留 B。

顺序 A → B → C。B 保留有读写职责的页面容器，并迁移 external hook，保证 components 层无 hooks/api 依赖。每批独立提交，不把搬移与 TS/JSX 混在一起。

## 11. 风险与未决

风险：

- 测试直接 `import ../../../src/client/*.js`（`test/unit/client/*`）：搬移需同步路径；TS 化后需类型剥离或 JSDoc 回退（S2 spike 决定）。
- `lib/client.js` 是提交产物：漏重建会让源码与运行产物脱节。
- 并行任务（前端架构治理、UI 2.0、后端 TS）可能改同一批 `views/*`：结构迁移期间按文件批次 rebase，冲突在候选分支解决。
- 组件拆分改变 DOM/class：只搬 JSX，不改 class/结构，人工比较布局与 CSS 哈希。
- classic JSX 约束（S2/S4）：不引入 `react/jsx-runtime`；每文件 `React` 在作用域。

未决：

1. `read-lifecycle` 的长期形态：S3 只保留看板/项目读生命周期；健康固定 5s 是否统一到同一调度，另立任务并先证明语义等价，不在结构迁移中合并。
2. 样式边界：`styles.ts` 通过 `css.d.ts` 导入 CSS 文本并幂等注入，不引入运行依赖。
3. `pages/docs.tsx` 的编辑器投影可在后续类型化时细分；本批只提 helper，列表容器留 pages、阅读投影在 components。

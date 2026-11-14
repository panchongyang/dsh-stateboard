# 契约重排前的实现与维护口径档案

> 状态：已归档，仅作历史背景。

保留与当前文件或脚本不一致的描述及未交付提案，不作为产品承诺。当前行为见[实现契约](<../CONTRACT.md>)；维护入口见[CLI](<../operations/CLI.md>)。章节号属于归档原文。

## 客户端实现与测试旧口径（原 §4）

## 4. Client（浏览器半）

源码在 `src/client/**`；`lib/client.js` 是 `npm run build:client` 生成的**唯一运行时 bundle**
（esbuild 只在开发期跑，产物提交进仓库）。构建外壳仍与 `dsh-button-plugin/lib/client.js` 一致：

~~~js
window.__ModuleLoader__.load({
  id: 'dsh-project-board',
  factory: (require) => {
    const React = require('react')
    ...
    const inject = ['slots', 'layout']
    function apply(ctx) {
      // 4 个 slot：main / sidebar.panellist /
      // conversation.session.header.utilities / tool.call.toolview
    }
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
~~~

契约要点：

- 4 个 slot：`main`（key `project-board`）、`sidebar.panellist`（id `project-board`, order 50, label「项目板」）、
  `conversation.session.header.utilities`（id `project-board-jump`，`inject().onOpen(cwd)`）、
  `tool.call.toolview`（key `project_board`，`inject().openPanel()`）。
- 只 require `react`；不 require ui-primitives，不新增运行时依赖。
- 命令与端点白名单**不**由 client 导出：`COMMAND_OPS` / `API_PATHS` / `TOOL_NAMES` 在
  `lib/shared/contract.js`，`test/client/client-smoke.mjs` 直接 import 共享契约做冻结断言
  （`exports.COMMANDS` / `exports.API_PATHS` 必须为 `undefined`）。
- 样式（M2 起）：`src/client/styles.css` 一次性注入 `<style data-plugin-css="dsh-project-board/ui.css">`
  的 `.pb-*` 样式表 + `--pb-*` 语义 token；token 映射宿主 `--dsw-*` 并带回退值，暗色走
  `[data-ds-dark-theme]`。原「样式全部 inline」作废（inline 无法表达 `:hover` /
  `:focus-visible` / `@container` / `prefers-reduced-motion`）。
- 禁止 `dangerouslySetInnerHTML` / `innerHTML`；文档正文按纯文本/简单 markdown 渲染
  （标题/列表/代码块/粗体/表格/chart DSL）。
- 数据：`src/client/transport.js` 是唯一 fetch 入口，`globalThis.__PROJECT_BOARD__` 取 token；
  `hooks.js` 轮询 2s，`document.visibilityState==='hidden'` 暂停；`races.js` 的请求票据保证
  迟到响应不覆盖新状态。
- 组件分布：`views/board-page.js`（BoardPage）、`views/task-drawer.js`（TaskDrawer）、
  `views/docs.js` + `views/doc-reader.js`（DocsPane）、`views/health.js`（HealthPane）、
  `views/plans.js` + `views/plan.js`（PlanPane）、`slots.js`（ToolCard / PanelIcon / QuickEntry）。
- 项目选择：localStorage `projectBoard.lastProject`；列表来自 `GET /projects`；无项目时显示创建表单
  （workspacePath + name）。
- TaskDrawer 动作按钮：claim/begin/submit/block/release/reconcile/verify/reject/cancel，
  以及 gate/reopen/override（按 `allowedOps`）；submit 用简单表单（summary + kind=note + acceptanceId）；
  按钮根据 `allowedOps` 禁用。
- 证据行只做轻量来源区分：file/doc 内容观测显示「内容指纹已记录」，固定 Git 不可观测显示「Git 不可观测」；command/test 显示「提交者自报」，历史 `execution` 行显示「历史执行记录」。不再用 success 徽标把哈希采样写成「已校验」。漂移豁免面板只列 file/doc 内容漂移（file-drift/doc-drift/file-missing/doc-missing），命令执行失败或执行凭据不属于豁免。
- 冲突 409：显示当前 rev 与消息，提供“刷新”。
- ToolCard：从 block content 取文本摘要；按钮 `props.openPanel()` 调 `ctx.layout.selectPanel('project-board')`。

client-smoke 测试（`test/client/client-smoke.mjs`，`npm run test:client`）：

- 用 fake `window.__ModuleLoader__` 捕获 load options；fake `require('react')` 返回最小 React stub；
  调用 factory；调用 apply 传入 fake `ctx.slots.inject/register`；断言 4 个 slot 及其
  key/id/order/label 与 `inject()` 返回值。
- 纯逻辑测试从 bundle 的 `__test`（54 键）取函数（filterCards / markdownBlocks /
  chartLayout / buildEvidence / commandBody / percentOf / stateTone / nextActionFor /
  planCanFocus 等）；组件与样式表从 `__ui`（27 键）取（`__ui.css`、`__ui.BoardView` 等）。
- 命令与端点冻结断言读 `lib/shared/contract.js`；源码里 `api('/…')` 前缀白名单；
  无 `dangerouslySetInnerHTML` / 无 `innerHTML`；只 require `react`；样式表含亮/暗 token、
  `:focus-visible`、`@container`、`prefers-reduced-motion`；无 DOM 渲染
  BoardView / TaskDrawer / DocsPane 不抛错。
- 再次 `apply` 不抛错（按挂载重复注册；样式注入幂等）。

## 维护与编码旧口径（原 §5）

`bin/wt.mjs`（当前 `bin` 仍暴露安装命令 `project-board-wt`）是维护者自用的 worktree 工具，不属于产品开源/发布面；把它移出发布包、与产品入口隔离的打包工作尚未完成。命令：`open / test / merge / close / list`。测试命令解析顺序：`package.json` 的 `scripts.test` →
`test/`、`tests/` 下的 `*.test.mjs` → `test/client/client-smoke.mjs`；缺 `node_modules` 时跳过导入裸包的测试。

### 5.2 必须通过的测试

`npm test` = `test:core` + `test:client` + `test:host`（测试数量以当前运行输出为准；migration-replay 的真实 store 用例在未设置 `PB_MIGRATION_PROJECT` 时跳过）。
`test:core` 覆盖 14 个文件，下面是最低必须语义（`test/core/core.test.mjs` 有对应 12 条）：

- `node test/client/client-smoke.mjs`：见 §4（bundle 冒烟 + 4 slot + `__test`/`__ui` + 冻结断言）。
- `node test/host/host-preflight.mjs`：fake ctx 注册 7 个工具，断言名称和 schema 存在。
- `node --test test/ops/architecture-map.test.mjs`：ARCHITECTURE 的 arch-map 与磁盘零缺失。
- 不依赖本机 DSH junction 的 CI 子集：`npm run test:ci`（core + client）。

### 5.3 编码约束

- 全部 ESM，`"type":"module"`；Node **22**（`node --test` / `fs` recursive 的下限）。
- **运行时无构建**：`lib/core`、`lib/host` 是手写 ESM，直接被 Node 加载；
  `lib/client.js` 是提交进仓库的 bundle，插件运行时不执行打包。
- **开发期可构建**：改 `src/client/**` 后跑 `npm run build:client`（esbuild 0.28.2，
  在 `tools/build/` 隔离安装），产物与源码一起提交。构建只在开发机发生。
- **TypeScript 仅开发期检查**：仓库的 `npm run typecheck` 使用隔离工具链与后端配置，`noEmit`，不改变运行入口或客户端；现有 JS 未全量开启语义检查。共享基础规则与 Node 专用配置分离；全量迁移与前端 TS/TSX 不属于当前实现。
- 样式只写在 `src/client/styles.css`，由 esbuild 以 text loader 内联；不要塞回 JS 字符串。
- 不引入第三方运行时依赖（除 `@deepseek-ai/dsh-tools` / `dsh-home-paths` 等宿主已有包）。
- 时间/随机可注入，便于测试。
- 文件写入用 `fs.writeFileSync` + `fsyncSync`；原子替换用 tmp + rename。
- 源码规模门禁：单文件 ≤ 450 行、普通函数 ≤ 80 行、React 组件 ≤ 200 行
  （`npm run audit:check`）。

## 历史查询提案（原 §8 末）

传统历史读计划暂停，通用 asOf、/history 与旧分段阈值不作为此版交付条件。

- 语义：实体不存在或该时刻不存在 → 200 空结果；`asOf` 非法/越界 → `4xx asof-out-of-range`；`fromSeq` 非法 → `4xx bad-seq`。

## 目录维护工具旧口径（原 §1）

bin/wt.mjs                 # 维护者自用 worktree 工具；不属于产品开源/发布面，打包隔离待完成

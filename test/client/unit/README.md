# 客户端纯逻辑测试

## 范围

覆盖客户端的纯函数、状态/竞态、页面读取生命周期、页面导航、外部文档表单与 hooks 接线；不渲染真实浏览器 DOM，不访问真实服务。

## 文件

| 文件 | 职责 |
|---|---|
| [doc-view.test.mjs](doc-view.test.mjs) | 文档列表的单一提醒信号、分组/筛选与默认信息层级。 |
| [external-docs.test.mjs](external-docs.test.mjs) | 外置文档 UI 的状态维度、写载荷和乐观并发草稿始终 fail closed；部分 hook 用例用 esbuild 打包真实模块。 |
| [bundle-logic.test.mjs](<bundle-logic.test.mjs>) | 出货 bundle 的纯逻辑契约，42 个独立 section / 246 个静态 assert；每例重建 bundle。 |
| [logic.test.mjs](logic.test.mjs) | Markdown/图表/流程图、筛选分组、命令载荷与计划编辑的纯逻辑契约。 |
| [page-lifecycle.test.mjs](page-lifecycle.test.mjs) | 页面读取生命周期、写后尾读、项目定位及认证失败恢复。 |
| [page-navigation.test.mjs](page-navigation.test.mjs) | 导航保留未确认丢弃的嵌套草稿，并隔离迟到写完成回调。 |
| [page-wiring.test.mjs](page-wiring.test.mjs) | 真实出货页面接线中验证加载/失败、项目身份与认证恢复不会误清草稿。 |

## 不覆盖

- 真实浏览器点击、视觉/布局、无障碍树；这些仍走人工验收。
- 服务端 HTTP/存储/租约语义（见 `test/host/routes.test.mjs`、`test/core/core.test.mjs`）。
- 完整客户端 bundle 的插槽/样式及离线组件树契约（见 [bundle](<../bundle-contract.test.mjs>)、[styles](<../styles-contract.test.mjs>)、[views](<../views-render.test.mjs>)）。

## 外部前置

- Node 22+；不需要 DSH 宿主。
- `external-docs.test.mjs` 的两个 hook 用例需要 `tools/build` 下的 esbuild；缺少时显式 skip，不是通过。

## 运行

```powershell
npm run test:unit:client
npm run test:client          # bundle/styles/render 契约 + client/unit
```

写完测试说明后跑 `node scripts/check-test-docs.mjs`。

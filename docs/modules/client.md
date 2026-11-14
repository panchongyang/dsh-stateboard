# 浏览器客户端

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：client：页面编排与展示层。

模块细节：[设计](<client/design.md>) · [内部契约](<client/contract.md>)。

## 职责

通过唯一 HTTP transport 读取和提交看板操作，并以页面容器与纯展示组件渲染结果。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [index.ts](<../../src/client/index.ts>) | slot 注册入口 |
| [board-page.tsx](<../../src/client/pages/board-page.tsx>) | 页面编排 |
| [transport.ts](<../../src/client/api/transport.ts>) | 唯一 fetch 入口 |
| [read-lifecycle.ts](<../../src/client/api/read-lifecycle.ts>) | 资源读取与刷新调度 |
| [request-gate.ts](<../../src/client/api/request-gate.ts>) | 请求票据与取消 |
| [page-navigation.ts](<../../src/client/hooks/page-navigation.ts>) | 页面选择与写入许可检查 |
| [project-location.ts](<../../src/client/model/project-location.ts>) | 项目定位与导航意图 |
| [markdown.ts](<../../src/client/utils/markdown.ts>) | 文档块解析 |
| [content.tsx](<../../src/client/components/content.tsx>) | markdown 与图表展示 |
| [styles.css](<../../src/client/styles.css>) | 源样式 |

## 对外面

- [CONTRACT §2.6 浏览器表面](<../CONTRACT.md#浏览器表面>)。
- [CONTRACT §2.6.5 HTTP](<../CONTRACT.md#265-http>)。
- [CONTRACT §2.4 文档图片](<../CONTRACT.md#24-文档>)。

## 依赖方向

pages → components/hooks/model/utils/api；hooks → api/model/utils；components → model/utils；api → model/utils；model → utils。仅 pages/components/hooks 使用 React，不 import core/host/node。

## 关键不变量与读图指针

- transport 不读取页面导航状态；页面确认的选择版本决定能否发写请求，迟到响应不能覆盖新选择；正文不进入 innerHTML。
- [读图](<../diagrams/layers.svg>)：分层图的 client→host 是 HTTP，不是 import；六层细节见[前端分层基线](<../design/frontend-layering.md>)，构建见[架构产物](<../ARCHITECTURE.md#5-构建与产物>)。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。

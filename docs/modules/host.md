# 宿主与协议适配

文档定位：L2 模块入口；L1 行为权威为下列契约链接。代码层级：host：受信入口与传输层。

模块细节：[设计](<host/design.md>) · [内部契约](<host/contract.md>)。

## 职责

装配 DSH 插件、工具、HTTP、MCP 和生命周期，把受信身份与业务参数送入 core。

## 代码入口

| 入口 | 结构职责 |
|---|---|
| [lib/index.js](<../../lib/index.js>) | 插件入口与服务装配 |
| [tools/index.js](<../../lib/host/tools/index.js>) | 原生工具注册 |
| [routes.js](<../../lib/host/routes.js>) | HTTP 鉴权与资源分发 |
| [auth.js](<../../lib/host/auth.js>) | 网页 capability 与 human actor |
| [lifecycle.js](<../../lib/host/lifecycle.js>) | DSH 会话绑定 |
| [prompt.js](<../../lib/host/prompt.js>) | 提示词注入 |
| [mcp.js](<../../lib/host/mcp.js>) | 可选监听与关闭 |
| [mcp-http.js](<../../lib/host/mcp-http.js>) | MCP 传输鉴权 |
| [mcp-write.js](<../../lib/host/mcp-write.js>) | 写凭据与工作会话 |
| [mcp-knowledge.js](<../../lib/host/mcp-knowledge.js>) | MCP 知识工具映射 |

## 对外面

- [CONTRACT §2.6 Host 表面](<../CONTRACT.md#26-host-表面>)。
- [CONTRACT §2.6.3 原生工具](<../CONTRACT.md#263-工具>)。
- [CONTRACT §2.6.5 HTTP](<../CONTRACT.md#265-http>)。
- [CONTRACT §2.6.7 MCP](<../CONTRACT.md#267-可选本机-mcp>)。

## 依赖方向

向下依赖 [project](<project.md>)、core 和 [shared](<shared.md>)，可依赖 DSH 包与 node；不 import [client](<client.md>)，两端以 HTTP 通信。

## 关键不变量与读图指针

- 身份来自受信入口，不接受请求自报角色；领域守卫仍由 core 执行，双端适配不复制状态机。
- [读图](<../diagrams/context.svg>)：图中 DSH、网页和 MCP 各有入口身份；只读与写入凭据不互相扩权，详见[信任边界](<../TRUST-BOUNDARIES.md>)。
- 全局文件清单与依赖规则见[架构地图](<../ARCHITECTURE.md#21-机器可校验的清单arch-map>)；领域不变量见[CONTRACT §1.4](<../CONTRACT.md#14-不变量>)。

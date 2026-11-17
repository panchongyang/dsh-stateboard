# 浏览器客户端模块内部契约

> 文档定位：L4 模块内部契约；L1 权威：[浏览器表面](<../../CONTRACT.md#浏览器表面>)、[HTTP](<../../CONTRACT.md#265-http>)、[命令信封](<../../CONTRACT.md#21-命令信封错误码与-http-映射>)。

本文约束客户端内部调用与宿主装配，不扩展 package exports；理由见[模块设计](<design.md>)。

## 1. 责任边界与非职责

客户端只发既有 HTTP 业务请求，不 import core/host/node，也不复制领域守卫。
宿主 UI context 只用于槽位、布局与会话导航；不能直接操作项目持久状态。
六层方向与禁止依赖见[设计矩阵](<design.md#2-六层与依赖方向>)，由[检查器](<../../../scripts/check-client-layers.mjs>)机械校验。
仅 pages/components/hooks 使用 React；model/utils/api 不使用 React，但并不保证无浏览器副作用。

## 2. 导出与兼容面

[源码入口](<../../../src/client/index.ts>)与[生成 bundle](<../../../lib/client.js>)当前导出 apply、inject、PANEL_ID、__test、__ui。

| 表面 | 调用/兼容约束 |
|---|---|
| ModuleLoader 外壳 | id 来自包名；factory 返回 module.exports，外部只 require react |
| apply(ctx) / inject | 宿主装配；inject 为 slots/layout，apply 注册四个 slot 并注入样式 |
| PANEL_ID 与 slot 标识 | 面板、快捷跳转、工具卡片按[L1](<../../CONTRACT.md#浏览器表面>)的固定标识互通 |
| __test / __ui | 仓库测试观察面；非对外业务命令或独立组件库承诺 |
| package ./client | 指向构建产物；源码拆分不能改变宿主加载方式 |
| CSS 资产 | CSS 内联，幂等 style 标识及 pb 前缀按 L1；没有独立 CSS URL |
| API 与图片资源 | 路由、方法、信封及 assets 原始字节是[L1 HTTP](<../../CONTRACT.md#265-http>)兼容面；不另开放公共图片目录 |

client 不导出 COMMANDS/API_PATHS；共享白名单不借 __test/__ui 变成客户端公开能力。
内部函数的路径、参数和组件 props 是仓库维护面，不能据此宣布 npm 新出口。
[构建脚本](<../../../scripts/build-client.mjs>)生成 bundle 与 map；不能直接修改产物修行为。
脚本没有只读检查模式；文档核对不运行默认 build:client 覆写产物。

## 3. transport API 与输入域

[transport](<../../../src/client/api/transport.ts>)是唯一 fetch 边界，调用方不得绕开它复制 token/header 逻辑。

| 入口 | 内部语义 |
|---|---|
| cfg / newCmdId | 取得注入配置 / 生成本次命令身份；不授页面写许可 |
| api(path, options) | JSON 请求，no-store，默认 8 秒 timeout，接受外部取消 signal |
| getProjects/getBoard/getTask/getPlans | 资源读取；返回字段按 HTTP DTO 消费 |
| getPlan/getDocs/getDoc/getHealth | 指定计划或 focus、文档、完整 health 读取 |
| command(projectId, body) | POST 命令；保留已有 cmdId，否则分配新 id |
| listExternalDocs/inspectExternalDoc | 列表含墓碑；inspect 默认带预览，可 fresh、可取消，15 秒 timeout |
| registerExternalDoc/updateExternalDoc/externalDocAction | 外置写 body 默认 schemaVersion=1，补 cmdId，15 秒 timeout |
| docAssetUrl/getDocAsset | 构造无凭据资源 URL / 带 token header 读取 Blob；使用调用方 signal |
| createProjectApi | 显式创建；不作为读取 miss 的自动兜底 |

api 的泛型投影不是运行时完整 schema 校验器；不能假定所有错误 JSON 形状都自动修复。
业务参数和 ID 按端点编码，写字段用[纯 payload 构造](<../../../src/client/model/external-payloads.ts>)约束，core/host 仍重新校验。
普通 JSON 请求的 HTTP/业务失败保留 code/details/status，非 JSON 失败保留响应文本。
超时与取消转为请求错误，不说明写入确定未提交；重试先核对真实状态和原命令身份。
getDocAsset 不走 api 的 JSON/timeout/page-access 处理，失败只用于局部图片降级。

## 4. 页面身份、并发与提交

[usePageWrite](<../../../src/client/hooks/page-navigation.ts>)要求 PageNavigationContext，不得在调用点省掉该包装。
调用前核对页面 active、无待确认跳转、projectId 和 selectionVersion 匹配。
此检查只保护客户端目标选择，不取代服务端角色、CAS 或租约。

1. 已有任务的命令体来自当前 task.rev；适用时携带当前 lease token。
2. 外置表单保存打开时的 listSchema/baseRev/baseHash，不对旧输入偷偷采用新修订。
3. 成功后刷新相关资源；不把本地 optimistic 状态当作服务端 committed。
4. 冲突、凭据错误或网络故障不自动重放写请求。
5. task 抽屉以 projectId/taskId 为 key 重挂载，避免前一任务草稿、忙状态与错误泄漏。
6. cmdId 去重是服务端边界；重复点击产生新 id 不保证自动去重。

[createPageRead](<../../../src/client/api/read-lifecycle.ts>)拥有读取取消、代次、计时器与快照发布。
reload 默认失效；已有 pending 时标 dirty，reload(false) 可合并，写后必须等失效后新读取。
stop 推进代次并 abort；旧代次不能发布成功或错误。
[requestGate](<../../../src/client/api/request-gate.ts>)只提供最新票据与 abortAll，不持有页面导航政策。
health 独立 5 秒 interval，可重叠，卸载仅清 interval；不要外推统一票据保护保证。

## 5. 凭据、错误与降级

网页配置只从 globalThis.__PROJECT_BOARD__ 取得；token 放 x-project-board-token，不进 URL 或自报 actor。
来源认证在 host；origin/fetch-site 拒绝不能当 token 轮换问题处理。
[page-access](<../../../src/client/model/page-access.ts>)只把 page-config-missing/token-mismatch 发布为整页凭据提示。
迟到成功只有 token 与起始提示修订匹配时才可清提示，避免抹掉较新的失败。
重新载入须确认草稿风险，不自动刷新页面。

普通错误由[labels](<../../../src/client/model/labels.ts>)保留未知 message/code，外置错误由[分类器](<../../../src/client/model/external-payloads.ts>)给补救动作。
allowedOps 未启用的动作要保留禁用原因；任何可用按钮仍可能在提交时被拒绝。
未知状态/事件标签保留原文和中性回退，不推导新动作或假定完成。
固定证据、提交者自报、agent 自述与人工验收显示不互相冒充，权威见[L1](<../../CONTRACT.md#浏览器表面>)。

## 6. 文档与图片不变量

[Markdown](<../../../src/client/components/content.tsx>)只把解析块映射为 React 元素，不解释正文 HTML。
普通链接仅 http(s)/mailto 可点击，其他链接保留惰性文本；这不等于允许远程图片。
图片只来自[图片 hook](<../../../src/client/hooks/use-doc-images.ts>)的相对引用鉴权读取与 object URL。

- 外置非截断 Markdown 预览才传入正文取图；原文/截断/无预览不取图。
- src 先去重，协议/绝对路径/反斜线/控制字符不触发请求；根内与引用资格由服务端验证。
- hook 按 projectId/docId/body 隔离集合，清理时 abort 并 revoke 所有已建 URL。
- 资源 URL 不带 token，SVG 以 img 展示，不插入原始 SVG/HTML DOM。
- 请求、解码或 CSP 失败返回原 Markdown 文本，不把正文整体变成失败。
- 图片路由、白名单与字节上限只在[L1 图片条款](<../../CONTRACT.md#内嵌外置与图片只读资源>)定义。

外置 schemaVersion 非 1 时禁写；失败列表刷新不能将已知只读状态改成可写。
刷新/预览/取图不代表确认；确认仍发送完整文件 hash 与预期 metaRev。

## 7. 副作用与兼容类别

浏览器副作用集中在网络、计时器/订阅、导航桥接、偏好存储、DOM 样式/焦点/剪贴板和下载。
model 的 storage/state/session-jump 与 utils 的 export 是环境端口，不是纯计算保证。
纯函数测试不能证明宿主 slot、主题、键盘与窄屏视觉全部正确。
HTTP 读取也不能按方法名推导后端零写；普通 GET 的 open 与图片锁外路径不同，见[信任边界](<../../TRUST-BOUNDARIES.md#2-只读与冷读>)。

slot/导出/加载外壳、路由与 CSS 标识变化须检查冻结断言；内部重构须保持层向与业务语义。
客户端依赖以源码导入和构建输入为准；生成 bundle 内的函数位置不是分层依据。

## 8. 验证入口

- [bundle 冻结断言](<../../../test/client/bundle-contract.test.mjs>)：装配、导出与外部依赖。
- [竞态](<../../../test/client/client-races.test.mjs>)、[页面生命周期](<../../../test/client/unit/page-lifecycle.test.mjs>)、[导航](<../../../test/client/unit/page-navigation.test.mjs>)：身份与迟到响应。
- [外置文档纯逻辑](<../../../test/client/unit/external-docs.test.mjs>)、[文档视图](<../../../test/client/unit/doc-view.test.mjs>)：schema、表单与状态显示。
- [图片逻辑](<../../../test/client/unit/doc-images.test.mjs>)与[服务端资源](<../../../test/docs/doc-asset.test.mjs>)：相对引用、拒绝、资源释放与零写边界。
- [样式契约](<../../../test/client/styles-contract.test.mjs>)、[人工清单](<../../operations/DOCS-UI-CHECKLIST.md>)：机械检查与人工交互分开。
- 分层运行 npm run check:client-layers；综合门禁 npm run audit:check 不代替构建产物一致性验证。

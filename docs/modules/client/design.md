# 浏览器客户端模块设计

> 文档定位：L3 模块设计；L1 权威：[浏览器表面](<../../CONTRACT.md#浏览器表面>)、[HTTP](<../../CONTRACT.md#265-http>)、[文档图片](<../../CONTRACT.md#内嵌外置与图片只读资源>)。

本文面向修改 UI 的人；调用约定见[内部契约](<contract.md>)，全局位置见[L2 入口](<../client.md>)。
设计系统背景见[UI 重做](<../../UI-REDESIGN.md>)，现行行为以 L1 和实现为准。

## 1. 职责与非职责

客户端负责项目定位、页面资源生命周期、交互编排和安全展示。
看板业务数据与命令只经 HTTP API 与 host 交换，不 import core 或 host。
宿主 slots/layout/sessions 能力用于装配和导航，不是领域写入后门。

**非职责**：

- 不定义任务状态机、租约资格、证据可信度或文档安全读取规则。
- 不认证自报 actor，不把禁用按钮当成后端授权。
- 不执行正文、证据命令、Markdown HTML 或远程图片引用。
- 不自动重放冲突写入，不静默覆盖用户草稿。
- 不在安装或浏览器运行时编译源码，不手改构建产物。

## 2. 六层与依赖方向

六层是源目录的职责划分，不是六个进程，也不是六级严格线性调用栈。
准确矩阵由[分层检查器](<../../../scripts/check-client-layers.mjs>)约束：

| 层 | 职责与代表入口 | 允许依赖的其他层 | 禁止依赖 |
|---|---|---|---|
| pages | [BoardPage](<../../../src/client/pages/board-page.tsx>)、任务/计划/文档页面；组装数据、动作与展示 | components、hooks、api、model、utils | core、host、node；禁止依赖根装配文件 |
| components | [Markdown](<../../../src/client/components/content.tsx>)、卡片、抽屉、基础控件；消费 props 并回调动作 | model、utils | pages、hooks、api；禁止直接请求数据 |
| hooks | [资源适配](<../../../src/client/hooks/use-page-read.ts>)、[页面写许可](<../../../src/client/hooks/page-navigation.ts>)；React 订阅与清理 | api、model、utils | pages、components；不在 hook 内直接 fetch |
| api | [transport](<../../../src/client/api/transport.ts>)、读取控制器、请求票据；网络与请求生命周期 | model、utils | pages、components、hooks、React |
| model | 视图词汇、选择器、表单载荷、导航状态机与浏览器状态端口 | utils | pages、components、hooks、api、React |
| utils | Markdown/图表/流程解析、格式化与下载工具 | 无其他 client 层 | pages、components、hooks、api、model、React |

同层导入仍须无环；所有层均禁止 node/core/host 和额外运行时包。
shared 可作为零依赖终点；当前实际使用的是[验收显示分类](<../../../lib/shared/verification.js>)。
入口、样式与声明文件不硬算第七层：[index.ts](<../../../src/client/index.ts>)负责装配，[styles.ts](<../../../src/client/styles.ts>)负责注入。

~~~text
index（slot 装配） --> pages / components / model / utils
pages      --> components / hooks / api / model / utils
components --> model / utils
hooks      --> api / model / utils
api        --> model / utils
model      --> utils
utils      --> 无其他 client 层
client     --> shared（允许；当前 labels 使用 verification）
transport  -- HTTP --> host -- 调用 --> core
~~~

图中箭头表示允许的依赖集合；HTTP 箭头不是 import。
model/utils 的层名不保证所有函数纯：storage、state、session-jump 和下载有浏览器副作用。
选择器、payload、文档状态映射和解析函数才按纯转换测试，不把环境端口伪装成纯函数。

## 3. 装配与冻结 surface

[源码入口](<../../../src/client/index.ts>)把四个 slot 注册到宿主，并保存用于导航的 context。
[lib/client.js](<../../../lib/client.js>)是唯一运行时 bundle；它及 source map 由构建脚本生成，不手改。
外壳使用 ModuleLoader，运行时只 require React，CSS 以内联文本随 bundle 注入。
宿主导出、slot 标识、CSS 标识和 package client 入口属于兼容检查面，详见[内部契约](<contract.md#2-导出与兼容面>)。

命令与 API 模板的定义源在[shared](<../shared/contract.md>)，不是 client 公开白名单。
当前 bundle 也导出 __test/__ui 供仓库回归观察；它们不赋予业务权限。
HTTP 路由与返回值是 L1 兼容面，内部组件名与源文件拆分不是新增 npm API。
图片 assets 是受鉴权资源路由，不是另建公共静态目录。

## 4. 状态与读取数据流

1. BoardPage 从会话主视图取得明确 cwd，并加载项目列表。
2. [项目定位模型](<../../../src/client/model/project-location.ts>)区分 unknown/loading/failed/matched/unmatched。
3. 页面确认 projectId 与 selectionVersion，为子页面提供 PageNavigationContext。
4. hooks 订阅 api 层拥有的资源控制器，再把响应交给组件。
5. model 派生筛选、分组、展示词汇和表单体；components 只渲染结果与回调。

导航意图与已确认身份分开；列表失败不把旧项目偷换成新写入目标。
出现跳转意图时保留已挂载内容与草稿，但暂停旧目标提交。
usePageWrite 在调用 transport 前检查页面存活、projectId、选择代次与待确认意图。
transport 不读取导航状态，不能凭 API helper 名字假定已经过页面写许可。
持久偏好与链接解析集中在[storage](<../../../src/client/model/storage.ts>)；偏好不构成写入授权。

[createPageRead](<../../../src/client/api/read-lifecycle.ts>)每个资源维护 generation、pending、dirty 与订阅快照。
常规看板成功后隔 2 秒读取；隐藏时不安排新轮询，focus/pageshow/恢复可触发读取。
在途普通刷新可以合并；写后失效要求再读，dirty 循环避免发布写前旧响应。
失败保留已有 data 并暴露 error；失败退避策略在[races](<../../../src/client/model/races.ts>)。
停止时清计时器、取消请求并推进代次，迟到数据与错误不能重新发布。

[request-gate](<../../../src/client/api/request-gate.ts>)用于任务/外置详情的最新票据判断与清理取消。
它与导航选择代次分属请求所有权和页面身份，不能互相替代。
[health hook](<../../../src/client/hooks/use-health.ts>)独立每 5 秒读取、隐藏时跳过，不能并入看板轮询。
health 当前允许请求重叠，清理只清 interval；不能宣称所有页面读取都有取消/迟到票据保护。

## 5. 写入、冲突与凭据

页面先用[任务 payload](<../../../src/client/model/payloads.ts>)或[外置 payload](<../../../src/client/model/external-payloads.ts>)构造既有协议体。
请求携带当前实体修订与适用的 fencing token，服务端重新判定 allowedOps 与领域守卫。
写成功再使页面资源失效；不在客户端提前把任务标成 done 或推进文档基线。
外置表单绑定打开时的 metaRev/hash，不能拿新观测给旧草稿重设确认基线。

transport 从 globalThis.__PROJECT_BOARD__ 读取 base/token，token 只进请求头，不进业务 payload。
来源与 token 的认证在[host](<../host/contract.md#2-输入校验与身份域>)，网页 actor 也由 host 建立。
页面凭据不是任务租约、MCP token 或模型供应商密钥。
[page-access](<../../../src/client/model/page-access.ts>)记录装配缺失/token 失配提示，并用修订号保护迟到成功。
重新载入有丢草稿风险，只有用户确认后执行，不自动刷新或重放写入。

错误保留 code/message/details/status，再由[labels](<../../../src/client/model/labels.ts>)映射为说明。
版本冲突给重新读取入口；外置错误按分类给出重观测或转外置面板，不盲目重试。
未知展示值保留原值，未知错误保留消息与 code，不把未知当成功。
allowedOps 只决定当前按钮与提示，写时仍可能冲突或被拒绝。

## 6. 文档与图片渲染路径

外置详情以四维观测组织状态，不把可读、已确认、管理状态与 Git 混成一个成功标志。
[ExternalBody](<../../../src/client/pages/external-panel.tsx>)只对非截断 Markdown 预览启用图片；原文与截断视图不取图。
[markdownBlocks](<../../../src/client/utils/markdown.ts>)先识别围栏代码，再把独占一行的图片变为 image 块。
[useDocImages](<../../../src/client/hooks/use-doc-images.ts>)按 projectId/docId/body 建立资源集合，并去重 src。
协议 URL、data、绝对路径、反斜线与控制字符不触发图片请求。
相对路径仍由服务端检查当前正文引用、binding 根、格式和大小，客户端筛选不是安全根验证。

路径链：正文预览 → image 块 → getDocAsset → 鉴权 assets → Blob → object URL → img。
资源 URL 不包含 token；不能直接把带凭据查询串写进 DOM。
文档/正文变化或卸载时 abort 请求并 revoke object URL，旧集合不能跨文档显示。
取图失败保持 Markdown 文本；解码失败、CSP 拒绝也回退文本，不打断正文。
SVG 只作为 img 资源，不注入其 DOM；正文没有 innerHTML/dangerouslySetInnerHTML。
服务端零权威写入旁路见[documents](<../documents/design.md#6-图片是只读资源旁路>)。

## 7. 降级、成本与维护顺序

初次读取失败不伪装“没有项目”；已有数据失败不伪装最新成功状态。
文档不可用保留登记与补救动作；schema 非 1 时外置写入保持只读，失败刷新不解除该状态。
固定证据只按服务端事实显示内容观测/不可观测，不能给提交者自报材料贴系统核验标签。
样式映射宿主 token 并有回退；主题、窄屏和可访问性仍需人工验收，不以文档门禁替代。

读取成本包含重复 JSON 传输、投影、Markdown 解析与图片 Blob 内存。
图片请求按唯一相对 src 发起，没有客户端批次并发限额；服务端每图还会重读正文。
隐藏暂停是减少读取，不保证取消所有已有请求；限额与超时不是整页性能 SLA。

阅读顺序：

1. [入口](<../../../src/client/index.ts>) → [BoardPage](<../../../src/client/pages/board-page.tsx>)，分清装配与页面身份。
2. [导航模型](<../../../src/client/model/project-location.ts>) → [usePageWrite](<../../../src/client/hooks/page-navigation.ts>)，检查提交前许可。
3. [transport](<../../../src/client/api/transport.ts>) → [read lifecycle](<../../../src/client/api/read-lifecycle.ts>)，检查网络/轮询所有权。
4. [外置表单体](<../../../src/client/model/external-payloads.ts>) → [图片 hook](<../../../src/client/hooks/use-doc-images.ts>) → [正文组件](<../../../src/client/components/content.tsx>)。
5. [构建脚本](<../../../scripts/build-client.mjs>)与[分层门禁](<../../../scripts/check-client-layers.mjs>)，再看[内部契约验证](<contract.md#8-验证入口>)。

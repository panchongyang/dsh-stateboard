# client 模块测试

## 范围

本模块有 11 个测试入口：客户端竞态、三份离线 bundle 契约及 unit/ 下的七份纯逻辑与页面接线。每个 section 独立注册 `test()`，失败只结束当前用例；各例重建 bundle、React/hook 替身和所需 fixture，不共享前例成功后的变量。localStorage 替身用测试清理钩子恢复。

| 文件 | 职责 | suite |
|---|---|---|
| [client-races.test.mjs](client-races.test.mjs) | 限制请求竞态、轮询退避及页面停止后的迟到数据写回。 | `test:core` |
| [bundle-contract.test.mjs](<bundle-contract.test.mjs>) | 冻结 loader、依赖、公开 API 与插槽接线（4 例，32 个静态 assert）。 | `test:client` |
| [styles-contract.test.mjs](<styles-contract.test.mjs>) | 冻结 CSS 字节、主题、尺寸和动效（6 例，31 个静态 assert）。 | `test:client` |
| [views-render.test.mjs](<views-render.test.mjs>) | 沿用 React/hook 替身冻结离线组件树（14 例，98 个静态 assert）。 | `test:client` |
| [unit/bundle-logic.test.mjs](<unit/bundle-logic.test.mjs>) | 冻结出货 bundle 内纯逻辑（42 例，246 个静态 assert）。 | `test:unit:client` |
| [unit/client/doc-view.test.mjs](unit/doc-view.test.mjs) | 约束文档列表的单一提醒信号、分组/筛选与默认信息层级。 | `test:client` |
| [unit/client/external-docs.test.mjs](unit/external-docs.test.mjs) | 保证外置文档 UI 的状态维度、写载荷和乐观并发草稿始终 fail closed。 | `test:client` |
| [unit/client/logic.test.mjs](unit/logic.test.mjs) | 冻结客户端 Markdown/图表/流程图、筛选分组、命令载荷与计划编辑的纯逻辑契约。 | `test:client` |
| [unit/client/page-lifecycle.test.mjs](unit/page-lifecycle.test.mjs) | 约束页面读取生命周期、写后尾读、项目定位及认证失败恢复。 | `test:client` |
| [unit/client/page-navigation.test.mjs](unit/page-navigation.test.mjs) | 保证项目导航保留未确认丢弃的嵌套草稿，并隔离迟到写完成回调。 | `test:client` |
| [unit/client/page-wiring.test.mjs](unit/page-wiring.test.mjs) | 在真实出货页面接线中验证加载/失败、项目身份与认证恢复不会误清草稿。 | `test:client` |

## 不覆盖

不访问真实用户 store/profile，不替代其他模块的领域测试或人工 UI 验收；本目录不是产品运行入口。

## 外部前置

需要已有 lib/client.js；部分 hook 用例需要 tools/build 的 esbuild，缺少时按既有逻辑显式 skip。

## 运行

在仓库根执行：

```powershell
npm run test:client
node --test test/client/bundle-contract.test.mjs
node --test test/client/styles-contract.test.mjs
node --test test/client/views-render.test.mjs
npm run test:unit:client
node --test test/client/client-races.test.mjs
```

suite 归属不由目录名推断，以表格和根 [测试索引](../README.md) 为准；默认 core/client/host 接线由递归 discovery 门禁检查。

## 断言映射

映射坐标为基座 `cf772d1` 的顺序冒烟脚本行号。407 个静态 `assert` 调用点全部保留条件、期望值和消息；循环内调用点仍按一次计数，不代表运行时展开次数。三份契约共 24 例 / 161 个调用点，纯逻辑另归 unit 的 42 例 / 246 个调用点。共享 [bundle fixture](<../helpers/client-bundle-fixture.mjs>) 不注册测试，也不执行其他 section 的断言。

`test:client` 显式列出三份契约而不用目录 glob，避免把只归 `test:core` 的 [client-races](<client-races.test.mjs>) 重复执行；随后串联 `test:unit:client`。本边界不承诺契约套件失败后仍启动后续 npm 套件。

### [bundle-contract.test.mjs](<bundle-contract.test.mjs>) · 32 个 assert

| 原 section 行号 | 独立 test 名称 | assert |
|---|---|---|
| 17-20 | plan editor project identity | 1 |
| 49-53, 55-57 | loader identity and public exports | 6 |
| 59-99 | slot wiring and reentrant apply | 15 |
| 101-142 | shared API and external dependency contract | 10 |

### [styles-contract.test.mjs](<styles-contract.test.mjs>) · 31 个 assert

| 原 section 行号 | 独立 test 名称 | assert |
|---|---|---|
| 143-144 | namespaced idempotent stylesheet injection | 2 |
| 146-179 | stylesheet bytes and metrics | 14 |
| 181-198 | motion and reduced motion | 5 |
| 200-206 | wide screens | 4 |
| 718-732 | embedded design system | 2 |
| 733-738 | card stylesheet layout | 4 |

### [unit/bundle-logic.test.mjs](<unit/bundle-logic.test.mjs>) · 246 个 assert

| 原 section 行号 | 独立 test 名称 | assert |
|---|---|---|
| 215-225 | logic L215: 筛选状态须可经 localStorage 往返，非法枚举和坏 JSON 必须安全回默认。 | 4 |
| 226-235 | logic L226: 下一操作按任务状态及 allowedOps 推导，终态和 backlog 不凭数组顺序猜动作。 | 8 |
| 236-253 | logic L236: 排名仅含活动任务，同优先级按更新时间破同分。 | 6 |
| 254-261 | logic L254: 按步骤 id 查真实标题，缺计划/步骤/引用须降级空串。 | 5 |
| 262-270 | logic L262: 计划状态须映射中文标签和色调，未知状态使用中性色。 | 7 |
| 271-281 | logic L271: 计划摘要按 active/draft/archived 排序，同状态按最近更新，空输入安全返回。 | 3 |
| 282-287 | logic L282: 新草案 id 只能来自 plan/created，更新事件和空结果不能误认创建。 | 4 |
| 288-301 | logic L288: 计划操作入口须按 head 状态及 focus 决定，归档计划只读。 | 12 |
| 302-329 | logic L302: 编辑表单解析须保留既有 taskId、正确 CAS，并将移出任务列入 orphan 提示。 | 17 |
| 330-339 | logic L330: 需要你计数合并审计 review/blocked/interrupted，重复任务只能计一次。 | 4 |
| 340-352 | logic L340: 纯函数动效时长须与 CSS token 一致，reduced-motion 返回零。 | 10 |
| 353-374 | logic L353: 卡片搜索和状态/门/计划筛选须准确，空白查询不算活跃条件。 | 14 |
| 375-395 | logic L375: 工作区匹配优先精确再最近祖先，Windows 大小写归一但相似兄弟前缀不得误匹配。 | 13 |
| 396-401 | logic L396: 挂载前的跳转请求须留存，消费后不能再次返回。 | 2 |
| 402-408 | logic L402: 已有文档默认只读预览，只有显式 preview:false 或新文档才进入编辑。 | 4 |
| 409-420 | logic L409: 任务跳会话优先租约 owner，无 owner 再选最新证据生产者，缺身份返回空。 | 4 |
| 421-434 | logic L421: 工作区会话选择须归一化路径并排除空白和子代理，取最新有效会话。 | 4 |
| 435-442 | logic L435: 更新任务关联须去重且保留原 planRefs，不能因整包替换丢计划链接。 | 2 |
| 443-455 | logic L443: 正文搜索须大小写无关且所有关键字匹配，命中片段保留原文字并有界截断。 | 7 |
| 456-462 | logic L456: 目录只提取标题块且保持文档顺序，空正文目录为空。 | 3 |
| 463-472 | logic L463: 文档 id/title/kind/body 任一变化都须触发草稿脏标记，未改新稿保持干净。 | 6 |
| 473-479 | logic L473: 代码围栏须保留语言和正文，供标签和复制栏使用。 | 3 |
| 480-494 | logic L480: 比例计算须夹在合法范围并处理除零，状态色调和审计门识别保持安全回退。 | 12 |
| 495-511 | logic L495: 证据载荷须 trim ref、保留验收点；命令体只在确有租约时携带 fencingToken。 | 5 |
| 512-539 | logic L512: 混合 Markdown 须正确分块并保留列表、代码语言及正文。 | 8 |
| 540-550 | logic L540: 带 chart/flow 属性的围栏必须识别为代码并前进，防止解析死循环。 | 5 |
| 551-557 | logic L551: 未闭合围栏仍输出一个代码块，不得无界扫描。 | 3 |
| 558-568 | logic L558: 裸围栏及更长围栏须可解析并保留语言与正文。 | 6 |
| 569-575 | logic L569: 未识别行也须恰好消费，异常输入不能卡住解析器。 | 3 |
| 576-592 | logic L576: 表格须保留对齐、行内语法和转义竖线，不能误拆单元格。 | 7 |
| 593-600 | logic L593: 短表格分隔符合法，但列数不匹配须回到普通段落。 | 3 |
| 601-606 | logic L601: 没有合法分隔行的竖线文本只能是段落，不能误判表格。 | 2 |
| 607-614 | logic L607: 分割线须单独分块，有序列表须保留起始编号和项目文本。 | 4 |
| 615-621 | logic L615: 仅 http(s)/mailto 可点击，脚本和相对链接必须保持惰性。 | 5 |
| 658-682 | chart parsing and layout | 18 |
| 697-703 | inline runs | 5 |
| 705-710 | inert raw HTML | 3 |
| 712-716 | readable errors and identifiers | 4 |
| 799-803 | rank emphasis tiers | 5 |
| 805-817 | plan catalog and honest fallback | 4 |
| 1064-1078 | multi-plan sort | 1 |
| 1109-1109 | plan id search | 1 |

### [views-render.test.mjs](<views-render.test.mjs>) · 98 个 assert

| 原 section 行号 | 独立 test 名称 | assert |
|---|---|---|
| 623-624, 640-655 | markdown elements and inert links | 10 |
| 683-696 | chart rendering and accessible fallback | 8 |
| 740-767 | board columns statistics and ranking | 7 |
| 769-798 | minimal task card metadata | 10 |
| 819-838 | list state and plan labels | 2 |
| 840-864 | grouped list tree | 5 |
| 866-901 | drawer toast and primary actions | 8 |
| 903-918 | board view switch visibility | 7 |
| 920-940 | list grouping and clear filters | 5 |
| 942-956 | layout and drawer shell | 4 |
| 958-978 | new task drawer and docs pane | 8 |
| 980-1000 | external document panel | 7 |
| 1002-1062 | plan editor diff conflict and publish | 8 |
| 1079-1108 | multi-plan page and focus | 9 |

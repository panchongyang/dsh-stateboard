# TypeScript 开发工具链

## 范围与入口

TypeScript 仅用于开发期检查，不是插件运行依赖；Node >=22、后端 JavaScript 入口与包导出保持不变；后端允许 JS/TS 混用，前端全量 TS/TSX。此处不迁移 core/host 的实现，客户端 model/utils/api 的 23 个实现模块为 TypeScript，pages/components 的 23 个视图模块为 TSX/classic JSX，hooks 与根入口为 `.ts`；客户端构建链与 `noEmit` 类型入口已接入，见下文。

```text
npm --prefix tools/typescript ci --ignore-scripts
npm run typecheck
npm run typecheck:client
npm run test:types
npm run test:types:client
```

依赖和锁文件独立位于 `tools/typescript/`。不要在根目录执行 npm install/ci，以免覆盖维护者装配的宿主依赖链接。缺少工具链时命令明确失败并提示安装，不回退到全局 tsc。TypeScript 与 Node 声明版本固定；更新工具链须同步锁文件并跑门禁。客户端 esbuild 工具链仍独立位于 `tools/build/`。

## 配置分层

- `tsconfig.base.json`：ES2022 target 与语言 lib，`types: []` 防止环境中已安装的 `@types/*` 自动注入；`strict: false`、`allowJs: true`、`checkJs: false`、`noEmit: true`，允许显式 any，不要求清零或逐个论证；统一文件名大小写，跳过声明库内部检查。
- base 不指定 Node 类型、模块/模块解析策略、JSX、平台文件表或后端目录；不内置 DOM。后续浏览器配置可独立 extends base，并自行选择 DOM lib、ESNext/Bundler、JSX 和自己的 include，无需继承后端配置。
- `tsconfig.backend.json`：extends base，选择 NodeNext 模块/解析、隔离工具链里的 Node22 声明。include 覆盖 `lib/index.js`、`lib/{shared,core,host}/**/*.js` 和 `**/*.ts`，以及 `scripts/typecheck.mjs`；不包括客户端、生成 bundle、其他维护脚本或测试。
- `tsconfig.client.json`：extends base，独立选择 DOM lib、ESNext/Bundler、classic JSX（`React.createElement` / `React.Fragment`）、`allowImportingTsExtensions`、`erasableSyntaxOnly`、`types: []`、`strict:true`、`allowJs:false`、`noEmit`；include `src/client/**/*.{ts,tsx}`。前端全量 TS/TSX；不把 DOM/JSX 混进后端配置。

## 实际检查保证

后端 JS 被纳入模块图以支持 JS/TS 共存，**现有 JS 未开启全量语义类型检查**；`checkJs: false` 不是 core/host 类型安全证明。新加入上述目录的 `.ts` 文件自动纳管并检查；JS 可通过逐文件 `// @ts-check` 自愿加入语义检查。

真实试点是 `scripts/typecheck.mjs`：它以 `@ts-check` 校验隔离编译器的查找、子进程调用与退出状态处理。它仍是直接由 Node 执行的 JS，无需为了试点改变生产模块或状态机。类型检查不会生成 JS、声明或 source map。

`test/ops/typescript-toolchain.test.mjs` 接入默认 `test:core`，覆盖：实际后端命令、包含/排除范围、临时新增后端 TS 的显式 any 与 JS import 正例、明显类型错误反例、无 emit，以及浏览器独立 extends 后 DOM 正例和 Node 全局/内建模块反例。临时 fixture 不是已迁移的生产 TS 模块。CI 安装独立工具链并执行两套 typecheck 和默认测试。

客户端入口由 `scripts/typecheck-client.mjs` 执行 `tsconfig.client.json`；`test/ops/typescript-client-toolchain.test.mjs` 覆盖当前树通过、DOM 可用、`node:*` 拒绝、classic JSX 正例、props 错误反例与无 emit。`test/ops/client-build-tsx.test.mjs` 用真实 `build-client.mjs` 打包 `.tsx` fixture，断言单 bundle、仅 external react、无 `react/jsx-runtime`。

## 客户端（前端）接入与 spike 结论

客户端 model/utils/api 的 23 个实现模块使用 `.ts` 与真实参数/返回/字段类型，共享的最小 Task/Plan/Board/Doc/Session 投影在 `src/client/model/types.ts`，类型导入用 `import type`；不把整个领域对象写成 any。未知 JSON 字段用 `unknown`，并在现有运行时字段检查处收窄；不增加运行时校验或改写响应。`strict:true` 与 `allowJs:false` 覆盖全部前端 TS/TSX。pages/components 的 23 个视图模块使用 `.tsx` 与 classic JSX；每个组件的参数由命名 `XxxProps` 接口描述，`children` 与可选参数标 `?`。视图投影接口在 `src/client/model/view-types.ts`，React/DOM 最小声明在零依赖的 `src/client/react.d.ts`，不引入 `@types/react`。hooks 与根入口为 `.ts`。静态 DOM 与组件结构使用 JSX；动态标签/图标的 5 个 `React.createElement` 调用集中登记于[前端分层基线 §5.4](<design/frontend-layering.md#54-classic-jsx-与动态标签登记>)。构建与类型入口：`scripts/build-client.mjs` 接受 `.ts/.tsx` 并使用 classic JSX，`tsconfig.client.json` + `npm run typecheck:client` 做 `noEmit` 检查，前端不纳管 JS，TS/TSX 由 `strict:true` 检查；后端仍允许 JS/TS 混用。以下是 spike（分支 `spike/frontend-tsx`，样例在 `spike/frontend-tsx/`，不随包发布）的实测结论，作为后续迁移依据。

### Node 直接跑 `.ts` 单测

- **Node 22.20.0**：`node --test test/spike-frontend-tsx.test.mjs` 直接 import `format.ts`，2/2 通过，无需 `--experimental-strip-types`。本机 Node 24.22.2 同样通过。
- **Node 20.11.1**：同一测试失败（不支持类型剥离）。CI 使用 Node 22 latest（>=22.18），可用；低于 22.18 的本地环境不能用这条路径。
- `.ts` 之间的 import 必须写 `.ts` 说明符：`import('./format.ts')` 可解析，`import('./format.js')` 报 `ERR_MODULE_NOT_FOUND`。因此前端源码统一写显式 `.ts`/`.tsx`，并配合 `allowImportingTsExtensions` + `noEmit`；esbuild 接受同样的说明符。
- 只用可擦除语法：`erasableSyntaxOnly: true`；不要 enum/namespace/参数属性。类型、接口、`as` 会在加载时被剥离。

### 前端 tsconfig

`spike/frontend-tsx/tsconfig.json` 的实测配置：extends `tsconfig.base.json`，`lib: ["ES2022","DOM"]`、`module: ESNext`、`moduleResolution: Bundler`、`jsx: react`、`jsxFactory: React.createElement`、`jsxFragmentFactory: React.Fragment`、`allowImportingTsExtensions: true`、`erasableSyntaxOnly: true`、`types: []`、`noEmit: true`；`tsc -p spike/frontend-tsx/tsconfig.json` 通过。正式配置 `tsconfig.client.json` 沿用同一组选项，include 为实际 `src/client/**/*.{ts,tsx}`，当前树 `npm run typecheck:client` 通过；使用 `strict:true`、`allowJs:false`。

### esbuild 打包

`entry.tsx` 同时引入 `.tsx` 组件和 `.ts` 纯逻辑，用现有 `tools/build` 的 esbuild 0.28.2。完整命令（与生产构建一样开 `keepNames`，产物大小含该选项）：

```text
node tools/build/node_modules/esbuild/bin/esbuild spike/frontend-tsx/entry.tsx \
  --bundle --format=cjs --platform=browser --target=chrome100 --external:react \
  --jsx=transform --jsx-factory=React.createElement --jsx-fragment=React.Fragment \
  --charset=utf8 --keep-names --outfile=.evidence/bundle.cjs.js
```

结果：产物 2416 bytes（不开 `--keep-names` 为 2232 bytes，差值是 `__name` 辅助）；`grep react/jsx-runtime` 为 0；唯一外部依赖是 `require("react")`；JSX 编译为 `import_react.default.createElement(...)`。

自动运行时对照：样例 tsconfig 的 `jsxFactory` 会覆盖 `--jsx=automatic`，只有同时覆盖 tsconfig 才会看到自动运行时：

```text
--jsx=automatic --tsconfig-raw='{"compilerOptions":{"jsx":"react-jsx"}}'
```

这样产物才出现 `require("react/jsx-runtime")`；本项目不能用自动运行时。这些选项已补进 `scripts/build-client.mjs`，保持 CJS/UMD 外壳、`external: ['react']`、不 minify、原子写与 sourcemap。

### 取舍

- 纯逻辑与数据层用 `.ts`，单测直接 import `.ts`，不引入 loader/emit。
- 组件用 `.tsx` + classic JSX；组件不进入 `node --test`，靠 esbuild 产物 + `client-smoke`/渲染覆盖。
- 回退：若目标环境 Node <22.18，纯逻辑保留 `.js` + JSDoc/`checkJs`，组件仍 `.tsx`；不采用测试期 loader，避免多一套运行时。
- 本结论证明工具链可行且已接入构建/类型入口，客户端纯逻辑/API 已类型化，视图使用 TSX/classic JSX，hooks、根入口与样式注入均使用 TS，行为冻结面见[前端分层基线](<design/frontend-layering.md>)。

## 测试侧类型检查

`tsconfig.test.json` 复用 `tsconfig.base.json` 与 `tools/typescript`，只 include `test/helpers/**/*.mjs` 和 `test/fixtures/**/*.mjs`；`npm run typecheck:test` 用同一个隔离 `tsc` 做 `noEmit` 检查，不要求根目录 `npm install`。helpers/fixtures 以文件头 `// @ts-check` 逐文件开启检查（`checkJs:false`），避免把未被检查的 `lib/` JS 一并拉进错误面。

`test/ops/test-typecheck.test.mjs` 接入 `test:core`：正例跑 `typecheck:test`，负例在临时目录写一个显式类型错误并断言编译器非零退出。当前只覆盖 helpers/fixtures 及新增测试助手，不覆盖全部测试文件，不启用全量 `strict`；产品 JSDoc 尚未覆盖的构造/命令签名在测试侧局部窄化并注明，后续随类型补注渐进扩大。

## 验证边界

完整门禁仍按 [TEST-ENV](<TEST-ENV.md>) 用白名单环境隔离 HOME/USERPROFILE/DSH/XDG/npm/TEMP，并断言默认 stores 根在合成 fixture 内。类型检查不能替代运行测试、独立审查或宿主兼容验证。客户端工作独立安排；后端 TS 类型说明随中文注释补齐同批渐进做，不另设完整类型化或严格化工程。

## 类型作为可检查的说明

后端把 TS 表达的参数、返回值和数据形状视作注释工作的一部分，与每函数中文用途、why、不变量、副作用和失败/降级边界同批补充，具体文件/符号集合见[后端可读性基线](<BACKEND-READABILITY.md>)。类型不替代中文用途或复杂边界说明；允许 any、局部类型缺失，不设单批或全局完整类型覆盖门槛，不要求精确跨层类型传递。保持 JS、采用 JSDoc/逐文件 `@ts-check` 是可选的低成本表达，不强制某一种实现形式。

这一定位指可检查、可擦除的类型说明，不是装饰器、TS 运行时构造或框架。任意 TS 语法并不天然无行为；实际改动运行代码、导入导出、模块加载、emit/构建或生产入口时，仍须按[风险规范](<TESTING-POLICY.md>)单独判级和验证，不能以“类型也是注释”豁免。后端 `noEmit` 工具链只检查，不提供生产 TS 编译/加载能力；前端由 esbuild 生成浏览器 bundle。类型检查通过不证明改扩展名后能运行，也不证明运行行为保持。

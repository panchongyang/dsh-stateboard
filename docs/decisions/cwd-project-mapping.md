# 决策：会话快捷入口如何把 cwd 映射到项目

会话头部的入口要「打开当前工作区对应的项目板」。真正的难点不是按钮，而是映射规则：项目按 workspacePath 精确登记（host 侧 pathIndex），而会话 cwd 既可能是某个项目的子目录，也可能没有任何项目。

## 决策

1. **精确匹配优先**：规范化后完全相等，直接命中。
2. **其次最近祖先**：cwd 落在某个项目工作区之下，取路径最长（最深）的那个，并用 toast 说明「已打开上级项目」和项目根路径。
3. **都没有**：打开「新建项目」表单，路径预填当前 cwd，说明「当前会话的工作区还没有项目板」。
4. 不自动建项目（写操作要人确认），也不把映射写穿到 host。

## 规范化与比较规则

- 分隔符统一成 `/`，去掉尾部 `/`。
- Windows 风格路径（`X:/` 或 UNC）比较时忽略大小写；POSIX 路径保持大小写敏感——Linux 上两个只差大小写的仓库是两个项目。
- 兄弟目录的前缀不算祖先：`<本机路径>\proj2` 不属于 `<本机路径>\proj`。
- 同一路径只可能有一个项目（host 的 pathIndex 保证），所以不需要消歧。

## 为什么不直接用「记住上次项目」

`readLastProject()` 只保留为没有会话上下文时的兜底。入口命中时必须覆盖它：否则从 A 项目会话切到 B 项目会话会看到 A 的板，比空白更糟，而且用户不会察觉。

## 实现落点

- [lib/client.js](../../lib/client.js)：`normalizeWorkspacePath` / `comparablePath` / `matchProjectByCwd` / `requestBoardJump` / `consumePendingJump`；入口注册在 `conversation.session.header.utilities`（id `project-board-jump`）。
- 跳转两条路：面板已挂载时走 window 事件 `project-board:jump`；尚未挂载时把请求留在 `pendingJumpCwd`，由 BoardPage 首帧消费（只消费一次）。
- 无项目分支复用 `CreateProject`，通过 `initialPath` / `hint` 预填路径并说明原因。
- 测试：[客户端单测索引](<../../test/client/unit/README.md>) 覆盖精确、祖先、兄弟前缀、大小写、空值与 pending 只消费一次。

## 代价与边界

- 祖先回退等于「替你选了上级项目」，所以只在没有精确命中时发生，且必须提示项目根路径。
- 不自动创建项目：不给入口开「静默写盘」的口子。
- 不改 host 的 `openByWorkspace`（保持精确匹配），避免影响 agent 工具的解析语义——快捷入口是 UI 层的便利，不是新的身份规则。

## 生效方式

客户端 bundle 由 dsh web 启动时构建，改完 `lib/client.js` 需要重启 dsh web 才能在页面上看到入口。

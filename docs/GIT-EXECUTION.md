# Git 可执行文件的解析约束

> 状态：**现状**。覆盖范围见 §3；明确不覆盖的执行面见 §4。
> 本文约束的是代码里的只读 Git 观测与维护者自用脚本。项目板产品不管理分支/worktree 生命周期，也不进入其他分支或 worktree 检查、复验；Git 不可用时只降级为不可观测。

## 1. 约束

**不得从工作区解析可执行文件。** §3 列出的 Git 调用都使用
`lib/core/git-exec.js` 的 `resolveGitExecutable(workspaceRoots)` 返回的**绝对路径**，
把它作为 `spawn` / `execFile` 的可执行文件参数；`cwd` 只用于表达 Git 的仓库语义，
不参与“运行哪个程序”的决定。新增的自动 Git 调用必须复用同一个解析器，并把即将
读取的工作区根传进去。

规则：

- 只按 `PATH` 查找（Windows 为 `git.exe`，POSIX 为 `git`）；不经过 shell，不查
  `PATHEXT` 里的 `.cmd` / `.bat`。
- **禁止根**是调用方传入的每个 `workspaceRoots`，加上运行本代码的 checkout。禁止根
  先做 `realpath`（Windows 用 `realpathSync.native`），因此 junction、symlink、8.3
  短名等别名都按物理目录比较。已声明的禁止根若无法规范化（不存在、无权限），
  **直接拒绝**（见 §5 `git-root-unresolvable`），不当作无关目录继续。
- 候选同样先做 `realpath`：必须是普通文件，且不在任一禁止根之下。“之下”按完整
  路径段判断：只有整段 `..` 才表示上跳，`..cache` 这类以点开头的子目录仍在根内。
- 进程内**惰性解析一次**，之后复用同一路径；每次调用都用规范化后的禁止根复验缓存。
  若缓存路径落入了后续调用新增（或以别名表达）的禁止根，直接报错，不重新解析、
  不回退裸名。
- `PATH` 中没有可接受候选时抛 `git-unavailable`（HTTP 503）。**绝不**静默回退到裸 `git`。
- **先定位仓库，再解析 Git。** 只知道启动目录的 CLI/脚本（`wt`、`release-tag`、
  test-env）在第一次运行 Git 之前，用 `findRepository(start)` 纯文件系统地从启动目录
  逐级向上找 `.git`（目录或 gitfile），直到盘符根或 UNC 共享根（`path.dirname` 不再
  变化）为止，不运行 Git。最近的一层是仓库根；所有更外层的 `.git` 所在目录也计入
  禁止根（Git 遇到无效的 `.git` 会继续上溯）。`.git` 本身是 symlink/junction 时按
  指向的目标分类（`stat` 而非 `lstat`），目标所在目录也计入禁止根。`.git` 为 gitfile
  （linked worktree、submodule）时，解析 `gitdir:`，对 git 目录的原拼写与 `realpath`
  各推断一次归属：git 目录本身、路径上每个 `.git` 段的父目录；按 `commondir` 文件或
  `<common>/worktrees/<name>` 结构得到的公共 git 目录（同样规范化后取 `.git` 段父
  目录）。这些全部禁止，所以经 junction 拼写、路径里没有字面 `.git` 的 gitdir 也能
  找到主 checkout。
- **separate-git-dir 归属。** 只有公共 git 目录的真实路径上**没有任何 `.git` 段**
  （`git init --separate-git-dir`、bare 仓库）时，才读取它的 `config`；普通 `.git`
  目录的 config 一律不读，其中的任何 `worktree` 键都不影响禁止根。读取用内置的
  最小 `git config` 解析器 `parseGitConfig`：整文件读取（无截断）；识别
  `[section]` / `[section "sub"]` / 旧式 `[section.sub]`、`key = value`、引号与
  `\` 转义、引号外的 `#`/`;` 注释、行尾 `\` 续行；section 与 key 大小写不敏感；
  同名变量**最后一个生效**；无 `=` 的 key 为 `true`；格式错误直接失败。
  `core.worktree`（相对值按公共目录的原拼写与 `realpath` 各解析一次）存在即为主
  checkout，计入禁止根；`core.bare` 为真时没有主 checkout。**其余情形一律 fail-closed**：
  config 不可读或不可解析、没有 `core.worktree` 且非 bare、`core.worktree` 指向不
  存在的目录——`findRepository` 抛 `git-unavailable`（reason `git-owner-unresolvable`），
  `wt` 退出 1（`git unavailable: … (git-owner-unresolvable)`），`release-tag` 打印
  `REFUSED … (git-owner-unresolvable)` 退出 1，test-env 元数据记 `unknown`。Git 默认的
  `--separate-git-dir` 不写 `core.worktree`，所以这种布局下的 linked worktree 默认被
  拒绝；需要时在公共目录里显式设置 `core.worktree`。
- 启动目录的原拼写与 `realpath` 各走一遍；每个
  结果按 `realpathSync.native` 规范化，无法规范化的保留原值，由解析器按
  `git-root-unresolvable` 拒绝。找不到任何 `.git` 时，`wt` 与 `release-tag` 在运行
  Git 之前退出码 1（`not inside a git repository`），test-env 元数据记 `unknown`。

## 2. 为什么

Windows 上以裸名启动子进程时，libuv 会连同子进程的 `cwd` 一起搜索可执行文件。
于是 `spawnSync('git', args, { cwd: 工作区根 })` 会优先执行攻击者放在工作区根里的
`git.exe`。解析成 `PATH` 里的绝对路径后，`cwd` 不再影响可执行文件选择；跳过禁止根内
的候选则挡住“`PATH` 本身包含工作区（例如 `.` 或项目目录）”这一路注入；两边都按
真实路径比较，挡住用根别名绕过包含判定。

从仓库子目录启动的 CLI 若只禁止启动目录，`PATH` 里父仓库内的候选仍会被接受。这
不需要手工改 `PATH`：`npm run` / `npm exec` 会把启动目录及其所有祖先的
`node_modules/.bin` 前置到 `PATH`，于是 `R/node_modules/.bin/git.exe` 会在第一次
`rev-parse` 之前被执行。因此仓库根必须在任何 Git 运行前、不借助 Git 得到。

### 威胁模型

视为**不可信**（其中的 `git.exe` 永不执行）：

- 进程 `cwd` 与每次 Git 调用的 `cwd`；
- 工作区/仓库树里的任何内容，包括启动目录之上的整个仓库、外层仓库、linked
  worktree 的主 checkout 与 submodule 的父仓库；
- 仓库内的 `node_modules/.bin` 等目录，**即使它们经 `npm` 或用户被前置到 `PATH`**；
- 本 checkout 自身。

### 显式威胁模型边界

以下边缘**已知不覆盖**，不承诺防御：

- `PATH` 中与仓库无关的不可信目录（例如仓库之外祖先目录的 `node_modules/.bin`，
  或用户自己加入的第三方目录）：解析器信任禁止根之外的 `PATH`。
- UNC/设备/extended-length 路径（`\\?\`、`\\.\`、`\\server\share` 与盘符的互换拼写）、
  大小写敏感目录；`realpath` 只覆盖常见的 junction、symlink 与 8.3 别名。
- 硬链接：同一文件在禁止根外的另一个名字会被接受（不做 inode 排除）。
- TOCTOU：从读 `.git`/config、`realpath`/`stat` 到 `spawn` 之间，以及缓存期间，文件
  或目录被替换。
- `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` 等环境变量指向的仓库不参与文件
  系统定位；`wt` 与 `release-tag` 只按 `.git` 判定是否在仓库内。
- submodule 的 symlink/junction 变体（`.git/modules` 经别名、submodule 自身
  `core.worktree` 指向别处等）：只按 `gitdir:` 路径上的 `.git` 段推断父仓库。
- 其它无法从文件系统判定的 gitdir 布局：`extensions.worktreeConfig` 的
  `config.worktree`、`include`/`includeIf` 引入的配置、系统/全局配置中的
  `core.worktree`、Git 不同版本对 `commondir` 的不同解释。
- 最小 `parseGitConfig` 与 Git 的语义差异：它**宽松接受** Git 会拒绝的形式，例如
  `[ core ]` 这类 header 内带空格、值内未加引号的 tab（Git 转成空格，本解析器保留）、
  文件中途的 BOM。这些形式不会被当作“格式错误”拒绝，因此不享受 fail-closed。
- 由上述差异构成的风险组合（**四个条件需同时成立**）：separate-git-dir 布局 +
  畸形 header + 真实存在的 decoy `core.worktree` 目录 + `PATH` 含主仓库树。复审已实测
  该组合会让归属落到 decoy、漏掉主仓库，并执行仓库内 fake Git。

**fail-closed 策略**：凡是能识别出“归属需要推断但推断不了”的情形（目前即 §1 的
separate-git-dir 归属失败），一律拒绝运行 Git，而不是按已知根放行；已声明的禁止根
无法规范化同样拒绝。上面列出的边缘不在可识别范围内，不做拒绝——包括解析器宽松接受的
畸形 config 形式（它们不算“可识别的格式错误”）。


**后续发现**：落在本节已列边缘内、或同类新变体的发现，只登记（证据档案或看板卡），
不阻塞当前收口；越出本节的新执行面另开修复卡。

## 3. 覆盖范围

| 调用点 | 用途 | 传入的禁止根 |
| --- | --- | --- |
| `lib/core/documents/fixed-git.js` | 固定证据的只读 Git（`rev-parse` / `cat-file` 等） | `root` |
| `lib/core/documents/external-git.js` | 外部文档的 Git 观测（`status` / `config` 等） | `root` |
| `lib/core/identity/discover.js` | linked worktree 的 `--git-common-dir` 发现 | `boundary` |
| `bin/wt.mjs`（维护者自用，安装命令 `project-board-wt`；不属于产品开源/发布面） | worktree 开/测/合/关/列 | 启动时的 `cwd`、首次 Git 前定位的 `findRepository(cwd).roots`、每次 Git 调用的 `cwd`（已删除的目录除外） |
| `scripts/release-tag.mjs` | 发布标签（含 `--dry-run`） | 调用方 `cwd` 与首次 Git 前定位的 `findRepository(cwd).roots` |
| `scripts/test-env/lifecycle.mjs` | 测试环境元数据的 `rev-parse HEAD` | `repoRoot` 与 `findRepository(repoRoot).roots` |

## 4. 明确不覆盖

- 项目板不执行 `command`/`test` 证据的 `ref`，也不提供 runner；这类证据只登记提交者材料。用户自己在 DSH 或工程工具里运行的命令（包括 `git …`）不经过本解析器，也不由项目板代跑或检查可执行性。
- 测试 fixture/helper（如 `test/helpers/fixed-fixture.mjs`、`test/wt.test.mjs` 的 `git()`）仍用
  裸 `git`，只作用于测试自己创建、由审查者控制的临时仓库；不要把不可信的现有仓库
  交给这些 helper。
- `bin/wt.mjs test|merge` 运行目标仓库的测试（`npm test` / `node --test`），那是执行
  该仓库自己的代码，不属于 Git 可执行文件解析。
- `scripts/release-tag.mjs` 的发布门禁（默认 `npm run check:strict`，或
  `PB_RELEASE_GATE_CMD`）经 shell 在仓库里运行，同样是执行仓库代码；只有
  `--skip-gate` 时不运行门禁。
- Git 自身的仓库配置、hooks、filter 等执行风险由各调用点的安全参数处理，不在本文件范围。

## 5. 失败 reason（闭集）

解析器只抛一种错误：`code = "git-unavailable"`，`status = 503`，`details.reason` 取值：

| reason | 含义 |
| --- | --- |
| `git-exec-not-found` | `PATH` 中没有落在禁止根之外的普通文件候选；或缓存的路径落入了本次调用的禁止根 |
| `git-root-unresolvable` | 某个已声明的禁止根无法 `realpath`（`details.root`、`details.cause` 给出原因） |
| `git-owner-unresolvable` | `findRepository` 无法判定 separate-git-dir 公共目录的主 checkout（`details.commonDir`、`details.cause`），见 §1 |

`spawn` 本身失败时（如 `ENOENT`、`UNKNOWN`）由各调用点把系统错误码作为 reason 报告。

## 6. 不可用时的表现与恢复

解析失败不会静默执行别的程序，而是显式降级：

- 固定证据：证据记为 `current-only`。`git-exec-not-found` / `ENOENT` 对外为
  `fixedReason: "no-git"`——它既可能是“本机没有 Git”，也可能是“有 Git 但全在禁止根
  内”或“缓存的 Git 落入新根”；其它 reason 对外为 `git-unavailable`。内容哈希照常记录。
- Git 观测：`state: "git_unavailable"`。
- worktree 发现：返回 `null`，不做 worktree 映射。
- `project-board-wt`：退出码 1，并打印 reason；`release-tag`：`REFUSED`，退出码 1。

恢复：

1. 让一个**所有工作区与本 checkout 之外**的系统 Git 出现在 `PATH` 中；不要在工作区里
   放 Git 包装器或副本。
2. 解析结果按进程缓存。已经缓存了被拒绝的路径（或已解析到别处）时，修改 `PATH`
   不会生效：**重启该进程**（宿主服务需由用户重启）。测试内用
   `resetGitExecutableCache()` 清缓存。
3. `git-root-unresolvable`：确认声明的工作区根存在且可访问，再重试。

## 7. 测试

`test/git/git-exec.test.mjs`、`test/git/git-exec-surface.test.mjs`、
`test/git/git-exec-repo-root.test.mjs` 与 `test/git/git-config-parse.test.mjs`（均已接入 `test:core`）：

- 控制组：在工作区根放一个忽略参数、写 marker、退出 0 的假 `git.exe`，确认裸名
  启动确实会执行它。
- 核心路径：假 `git.exe` 放在临时仓库根（并前置到 `PATH`）后，固定证据、Git 观测、
  worktree 发现都不得留下 marker，且仍返回真实 Git 的输出。
- 解析器：绝对路径且不在工作区/本仓库下；二次调用复用；跳过工作区内候选；无候选时
  抛清晰错误；`..cache` 子目录内的候选被跳过；禁止根用 junction 或 8.3 短名表达时
  仍拒绝物理根内的候选；缓存后以别名新增的根拒绝复用；无法规范化的根被拒绝。
- CLI/脚本：仓库根放假 `git.exe`、**保持原 `PATH`**，运行 `bin/wt.mjs list`、
  `scripts/release-tag.mjs --dry-run --skip-gate` 与 test-env 的版本元数据，marker 不得
  出现，且输出正常（worktree 列表、dry-run 不建 tag、真实 HEAD）。
- 子目录启动：仓库 R 根与 `R/node_modules/.bin` 各放假 `git.exe`，`PATH` 前置这两处，
  从 `R/child` 运行 `wt list`、`release-tag --dry-run --skip-gate` 与 test-env 元数据，
  marker 不得出现且输出正常；原 `PATH` 对照同样干净；linked worktree 子目录启动时
  worktree 与主 checkout 内的假 Git 都被跳过；不在仓库内时 `wt`/`release-tag` 在运行
  Git 前退出 1。`findRepository` 的仓库根、gitfile 解析与仓库外返回 `null` 有单测。
- separate-git-dir（`test/git/git-config-parse.test.mjs`）：`parseGitConfig` 单测；真实
  `--separate-git-dir` + linked worktree，`PATH` 前置 L、R、`R/node_modules/.bin`，
  `core.worktree` 带行尾注释、带引号、重复（以最后一个为准）、位于 config 4096 字节
  之后时，R 都计入禁止根，`wt list` / `release-tag --dry-run` 正常且无 marker；无
  `core.worktree` 或指向不存在目录时 `git-owner-unresolvable`，两 CLI 退出 1、无 marker；
  普通仓库与普通 linked worktree 里无关的 `[review] worktree = <盘符根>` 不改变禁止根，
  两 CLI 退出 0。

Windows 的假可执行文件是 `test/fixtures/fake-git/fake-git.exe`（源码与重编命令在
同目录的 `README.md`）；POSIX 用测试内生成的 shell 脚本。8.3 用例依赖系统临时目录
本身是短名拼写，取不到时跳过。

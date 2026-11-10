# git 模块测试

## 范围

Git 只读执行边界、仓库发现、配置解析与换行属性；共用 ../helpers/fixed-fixture.mjs 和 ../fixtures/fake-git。

| 文件 | 职责 | suite |
|---|---|---|
| [git-config-parse.test.mjs](git-config-parse.test.mjs) | 确保分离 git-dir 的 worktree 所有权取自完整 Git 配置且未知时拒绝执行。 | `test:core` |
| [git-exec-repo-root.test.mjs](git-exec-repo-root.test.mjs) | 保证从子目录或 linked worktree 启动 CLI 时先发现全部禁执行仓库根。 | `test:core` |
| [git-exec-surface.test.mjs](git-exec-surface.test.mjs) | 封住点前缀目录、junction 与 Windows 短路径别名绕过 Git 执行根限制的漏洞。 | `test:core` |
| [git-exec.test.mjs](git-exec.test.mjs) | 保证所有核心 Git 调用复用工作区与运行仓库外的绝对可信可执行路径。 | `test:core` |
| [gitattributes-eol.test.mjs](gitattributes-eol.test.mjs) | 保证仓库文本在 autocrlf 主机检出后仍具有固定 LF 原始字节。 | `test:core` |

## 不覆盖

不访问真实用户 store/profile，不替代其他模块的领域测试或人工 UI 验收；本目录不是产品运行入口。

## 外部前置

部分用例需要系统 Git 或平台链接权限；缺能力的既有显式 skip 仍以运行结果为准。文档 host 表面另需 DSH peer。

## 运行

在仓库根执行：

```powershell
node --test test/git/*.test.mjs
```

suite 归属不由目录名推断，以表格和根 [测试索引](../README.md) 为准；默认 core/client/host 接线由递归 discovery 门禁检查。

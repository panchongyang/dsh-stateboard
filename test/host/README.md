# host 模块测试

## 范围

宿主工具、HTTP 路由、冷启动预检、Prompt 与宿主项目身份接线。

| 文件 | 职责 | suite |
|---|---|---|
| [host-audit.test.mjs](host-audit.test.mjs) | 校验宿主安装元数据、审计载荷翻译与 project:brief 字面文本注入边界。 | `test:host` |
| [host-preflight.mjs](host-preflight.mjs) | 保证插件在宿主冷启动时完整注册工具，并等待 webServer 后补挂路由和 token。 | `test:host` |
| [host-tools.test.mjs](host-tools.test.mjs) | 验证宿主工具从计划发布到任务交付、历史文档读取和会话事件的集成接线。 | `test:host` |
| [identity-host.test.mjs](identity-host.test.mjs) | 保证宿主会话在主 checkout 和 linked worktree 共用项目且证据根不漂移。 | `test:host` |
| [routes.test.mjs](routes.test.mjs) | 验证项目 HTTP API 的成功主流程、鉴权、输入校验与错误状态映射。 | `test:host` |

## 不覆盖

不访问真实用户 store/profile，不替代其他模块的领域测试或人工 UI 验收；本目录不是产品运行入口。

## 外部前置

需要本机可导入的 DSH peer；只创建合成 ctx、临时 profile/store 和回环临时端口，不启动真实宿主。

## 运行

在仓库根执行：

```powershell
npm run test:host
```

suite 归属不由目录名推断，以表格和根 [测试索引](../README.md) 为准；默认 core/client/host 接线由递归 discovery 门禁检查。

# 安装、首次运行与卸载

产品 `dsh-stateboard` 使用 BSD-3-Clause 许可证。完整可操作步骤以随包自包含的 [README 安装](<../../README.md#安装与首次运行>)为唯一入口；npm 与源码通过原生 DSH bundle 安装同一个 UI + agent 产品，没有附赠 CLI。

Windows、DSH 和 Node 的版本范围及实测组合见[支持矩阵](<../../README.md#支持环境>)。请按该矩阵选择 Web 宿主，并使用宿主要求的 Node 版本。

使用公共 npm registry 上的指定版本、同版本 tgz 或公开源码归档安装。操作者选择实际 Web profile，备份并停止目标宿主后安装，启动并刷新页面，确认 UI 与 agent 看到同一项目。失败时先检查本次配置差异，保留来源未知的链接和其它插件配置。

- [约三分钟脱敏文字演示](<DEMO.md>)
- [安装前备份、回退和故障恢复](<RECOVERY.md>)
- [工作区搬迁、换机与 schema 升级](<MIGRATION.md>)
- [贡献入口](<../governance/CONTRIBUTING.md>) · [发布与部署边界](<RELEASE.md>)

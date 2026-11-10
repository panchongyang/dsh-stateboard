# 安装、首次运行与卸载

产品 `dsh-stateboard@0.3.0`，BSD-3-Clause。完整可操作步骤以随包自包含的 [README 安装](<../README.md#安装与首次运行>)为唯一入口；npm 与源码通过原生 DSH bundle 安装同一个 UI + agent 产品，没有附赠 CLI。

支持 Windows 11 x64；DSH 支持带 `0.2.1-rc.2` 至 `0.2.2-rc.1`，上界不跟随 latest。DSH `0.2.2-rc.1` 要求 Node >=24.9；插件 engines Node >=22 只代表 core/client 基线，不是 Node22 Web宿主承诺。macOS/Linux 未测试，未覆盖组合不视作通过；逐项验证限制见[支持矩阵](<../README.md#支持环境>)。

使用公共 npm registry 上的指定版本、同版本 tgz 或公开源码归档安装。操作者选择实际 Web profile，备份并停止目标宿主后安装，启动并刷新页面，确认 UI 与 agent 看到同一项目。失败时先检查本次配置差异，保留来源未知的链接和其它插件配置。

- [约三分钟脱敏文字演示](<DEMO.md>)
- [安装前备份、回退和故障恢复](<RECOVERY.md>)
- [工作区搬迁、换机与 schema 升级](<MIGRATION.md>)
- [贡献入口](<CONTRIBUTING.md>) · [发布与部署边界](<RELEASE.md>)

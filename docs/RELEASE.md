# 维护者发布准备、人工公开发布与部署

本文描述三个独立阶段，**不是执行授权**。本地检查通过、任务验收或本地 commit 不授权 push/tag/npm publish、转 public、安装真实 profile、部署或重启。

## 1. 本地候选准备

产品 `dsh-stateboard@0.3.0` 使用 BSD-3-Clause 许可证。源码在 [GitHub 仓库](https://github.com/panchongyang/dsh-stateboard) 公开，包的可用版本以 npm registry 为准。[支持矩阵](<../README.md#支持环境>)覆盖 Windows 11 x64 和 DSH `0.2.1-rc.2` 至 `0.2.2-rc.1`。DSH `0.2.2-rc.1` 要求 Node >=24.9，Node 22 是 core/client 基线，macOS 和 Linux 尚未测试。

候选说明应列：基线与冻结提交、变更面、行为是否变化、兼容类别、定向/全量结果与 SKIP、安装来源、备份和匹配旧包、RPO、已知限制。事件/存储变更必须解释 additive/refuse/migration；schema v3 即使事件类型兼容，旧构建也可能静默丢失审计门，不能只看“能打开”。

按[贡献指南](<CONTRIBUTING.md>)运行定向测试；维护者在[隔离环境](<TEST-ENV.md>)统一跑冻结候选完整门禁。不访问真实默认 store。缺宿主依赖/未测组合/无数据时的跳过明确单列。

```text
npm run check:strict
npm run check:architecture
npm run check:release
npm run check:release:readiness
```

`check:strict` 包含 audit、core/client/host、stores gate 和 release purity；stores gate 无数据时报告 SKIP，真实数据回放须另有证据。公开源码的 stores gate 无需随包基准，比对命令和隔离要求见[独立测试环境](<TEST-ENV.md#6-离线门禁与入口>)。改客户端先重建产物并核对与冻结源码一致。独立审计与人工 UI 验收另行安排。

## 2. 唯一包检查入口

现有 `scripts/check-release-purity.mjs` 是唯一 CLI，`scripts/release-readiness.mjs` 是其纯求值辅助模块，不另建检查器。

- `npm run check:release` 实际 npm pack 后检查精确文件白名单、普通文件、元数据/BSD许可、敏感内容、旧门名、产品 Git 只读调用面和 README 包内相对链接。当前包仅交付 lib/src、README、docs/CONTRACT.md、LICENSE、package.json；不把其余 docs、scripts、test、内部档案或自用CLI装进 npm。
- `npm run check:release:readiness` 用同一入口额外检查公开元数据、main/exports/client 与 README 语法/链接，输出 JSON 的 blockers/manualGates/readmeLinks/capability。`private:true` 是独立人工闸，ready:false/exit1 是预期；其余 technical blockers 必须逐项报告，不能被 private 掩盖。
- 两种模式均可用 `-- --tarball <tgz>` 检查冻结包。纯度检查验证元数据和分发内容。readiness 另将 `private:true` 列为人工闸，发布授权仍按下文单独记录。
- 链接解析复用声明的 Markdown 子集；未支持语法阻断，不校验 fragment 是否存在或外链可达性。不检查 Git 全历史、registry 线上可用性、法律合规或任意宿主版本兼容。

README 的必要安装/演示/恢复说明自包含，不用未公开 GitHub 链接伪装修复 npm 断链。源码文档入口：[文档地图](<INDEX.md>) · [安装](<INSTALL.md>) · [演示](<DEMO.md>) · [备份/恢复](<RECOVERY.md>) · [迁移](<MIGRATION.md>) · [架构](<ARCHITECTURE.md>)。

## 3. 人工授权公开发布

仅在项目所有者明确授权后，维护者才可分别执行公开仓、远程推送、版本 tag/Release 与 registry 发布。先核对冻结提交/包哈希、版本、许可、包内内容、metadata、readiness 全部阻断及回退方案。公开仓与 npm 应对应同一候选，源码归档可作为获取兜底；不能把尚未公开的地址当下载成功。

npm 账户、registry、OTP/2FA 与公开仓权限由操作者私密处理，不写证据。发布后才验证线上获取与干净宿主安装；本地 tgz 测试不能代替这些结果。本文不要求运行 publish（含 dry-run），也不自动解除 private 闸。

## 4. 目标宿主部署与回退

公开发布不自动部署任何运行中的 DSH。操作者另选目标环境、profile、停写窗口、匹配包/配置/数据备份，明确授权安装、启动/重启和页面刷新。不存在固定 profile、pm2 命令、作者路径或必须使用某个 deploy tag 的产品前置。

仓库 `release:tag` 是维护工具，可能运行门禁、观测数据并创建 `deploy-*` tag，不是 npm 发布或部署动作；没有这一次明确授权不得运行。部署记录应包含实际提交/包哈希、数据版本、备份、目标与结果；不许将 tag 存在等同上线成功。

回退严格遵循 [RECOVERY](<RECOVERY.md>) 与 [MIGRATION](<MIGRATION.md>)：先停所有写者、保存故障副本，再恢复匹配构建与完整一致数据。只有明确兼容且无数据升级时才可仅回退包；schema/event变化不能只切代码。确认 RPO 和外部副作用，启动/刷新后核对业务与历史，不用 health 绿替代恢复验收。

## 5. 冻结记录清单

- [ ] 同一候选的包名/版本、许可、支持矩阵与安装来源一致
- [ ] 定向/完整测试、SKIP 与未验证组合如实记录
- [ ] 技术纯度通过；readiness technical blockers 与 private 人工闸分开列出
- [ ] README 的 npm 内必要说明自包含；源码入口互链可用
- [ ] 备份、匹配旧包、schema兼容性、RPO与恢复演练有据可查
- [ ] 独立审计/人工验收、公开发布授权与部署授权分别记录

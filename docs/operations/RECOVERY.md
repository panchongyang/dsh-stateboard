# ProjectBoard 恢复与继续交付 Runbook

安装入口见 [INSTALL](<INSTALL.md>)，升级/换机见 [MIGRATION](<MIGRATION.md>)，发布与部署边界见 [RELEASE](<RELEASE.md>)。npm 包内的完整用户步骤见 [README](<../../README.md#备份回退与迁移>)。

## 一致备份与版本回退

1. 确认 DSH home、profile、项目ID、工作区/绑定根与唯一写者，由操作者停止目标宿主。
2. 将整个 board 数据根（`DSH_HOME/project-board`，默认用户目录下 `.dsh/project-board`）复制到源目录之外全新的备份目录，保留身份注册数据、所有项目的 meta/commits/snapshot/blobs 和锁诊断。仓库 marker 和 snapshot 均不能替代完整日志。
3. 另备份工作区外置文件、引用所需的 Git 对象、实际存在的四份 profile 配置（manifest/lockfile/patch/workspace），保留匹配安装包/源码。记录时点、版本、路径、projectId 和日志 SHA-256；不公开私密数据。
4. 故障后先另存 damaged 副本；从一致备份复制到新的恢复目录核对，保留原数据，不能硬删或拼接日志。恢复匹配代码和完整数据；profile 的其它后续变更需合并。
5. 先确认 RPO（备份后新写入会丢失），再由操作者恢复并启动/刷新。核对项目身份、业务状态、外置定位、历史字节和 health；在授权恢复副本验证新提交与再次冷开。外部文件修改/部署/人工裁决不会因日志回退而撤销。

只回退插件版本：停止宿主，恢复本插件配置或上一包/链接目标，再启动刷新。若 schema/event 已变化，则必须同时使用迁移前完整数据与匹配旧构建，不能以“旧版本能打开”判安全。卸载不删除 store 或文件；没有备份就没有受支持的数据回退。锁归属不明时停下，不删锁、不猜 PID。

## 安全边界

**先备份，后 repair；先确认 RPO，后丢弃任何已提交后缀。** 可写 cold open 也可能规范化尾行、接管合作锁或提交恢复事件，不能把它当作零写诊断。

- 真实 DSH 的停写、停止、启动与重启全部由用户按自身运维规程手动执行。本文与演练脚本不探测、不控制 DSH、端口或服务，不替用户判断“旧 PID 可以杀”。
- 维护前，用户核对候选版本、项目 id、绝对 data/workspace 路径和写者归属，手动停写。备份需在停写后保持一致，覆盖整个项目目录（meta、日志、snapshot、blobs、锁诊断）及必要的受控配置；密钥备份按私密材料管理，不写入公开证据。
- 保留故障前的已知一致备份（pristine）；故障后、任何恢复或 repair 前，再独立保存 damaged 副本。记录日志原始字节数和 SHA-256，备份不得覆盖。没有可用的故障前备份时明确记缺失，不能臆造一致性。
- 只在授权副本上先演练；不要在真实 store、仓库样例、参考 worktree 上造故障。没有用户授权，不合入、不部署、不修改服务配置。
- salvage 只读前缀不是当前状态。恢复不能撤销外部副作用；不能在已经继续写入后盲目覆盖旧备份。代码回退也不会恢复被丢弃的业务状态。

## 冷开写入的恢复事件

可写 cold open 会替上一个进程收尾：每个仍是 `in_progress` 的任务在**同一条 commit** 里写 `lease/expired` + `task/interrupted|readied`（有 open intent → interrupted，否则 ready）。

- 重启回收的 `lease/expired` 不是运行时 lease 快照：租约表是进程状态，重启后为空。记录只从持久化 `task.owner` 重建（`sessionId`/`agentId`/`epoch`/`token`←`fencingToken`/`expiresAt`←`leaseUntil`），未知的续租字段省略，并带 `reason:'restart'`；常规 sweep 的记录才带完整 `grantedAt`/`renewCount`/`progressAt`。
- 每个 writer 只恢复一次；再次冷开时日志里已无 `in_progress`，不追加事件，也不会重复写 `lease/expired`。
- archived 项目冷开不写恢复 commit；恢复事件随 unarchive 的提交一起落盘。
- 恢复不替代业务判断：`interrupted` 走 reconcile，`ready` 需重新 claim，旧 token/fencing 不得复活。

## 合成演练入口

在本候选仓库运行：

```sh
node scripts/recovery-drill.mjs
node --test test/ops/recovery-drill.test.mjs test/ops/test-discovery.test.mjs
```

[入口](<../../scripts/recovery-drill.mjs>)不接受任何参数，包括真实 root、输出路径或真实数据 opt-in。每次创建新的 `pb-recovery-*` 临时根，使用 Windows native canonical 路径、随机标记和严格 containment/link 校验。内部 worker 只接受本次 fixture 的名字和动作；不提供恢复任意目录的公共入口。

子进程只保留最小系统变量白名单；HOME、USERPROFILE、DSH_HOME、DSH_AGENTS_HOME、APPDATA、LOCALAPPDATA、TEMP/TMP/TMPDIR、XDG、npm 配置和 cache 全部进入 fixture，不继承密钥、Node 注入或真实配置。命令证据执行关闭；主业务链使用真实合成 file 证据。

每 case 都在新进程创建项目并保存 pristine，注入故障后保存 damaged，再冷进程恢复。恢复后提交真实业务命令，另一个新进程再次打开，核对数据、提交保留和 health。主链另覆盖 plan → claim/begin → 冷重启恢复 → reconcile/resume → 写 artifact → submit → 合成 human actor verify → 再冷开；它不是对真实任务的人审或自验收。

[恢复 wrapper](<../../test/ops/recovery-drill.test.mjs>)由独立 `test:recovery` 执行，`check:strict` 在 perf 后串行调用，CI 另有独立步骤；不进入默认 core/fast。Suite wall-clock 上限为 300 秒。普通子进程上限 15 秒，runner 上限 120 秒，wrapper 子进程上限 150 秒；锁持有者是本 runner 创建的可追踪 fixture 子进程，正常演练通过 stdin 自然退出，不 close 以留下自身锁。超时边界只约束本次创建的子进程，不读取磁盘旧 PID 来终止进程。

报告保留在终端打印的新临时根：

- `report.json`：逐项预期、实际、pass/fail/skip、总耗时、恢复毫秒数、RPO、备份路径/哈希、限制。
- `steps/NNN-*.json`：准确 Node 命令数组、预期/实际 exit、stdout/stderr（含业务信封、cmdId、提交结果）。
- `cases/<name>/pristine` 与 `damaged`：本次项目完整副本；中段 repair 自身另产原字节备份。
- runner stdout/stderr、锁持有者 stdout/stderr/退出状态、RPO 确认记录和主链最终 rev/hash/artifact hash。

`recoveryMs` 从 damaged 备份完成后开始，含诊断/恢复、业务提交和再次 cold reopen 验证；不含 fixture/备份生成和人工停写时间，不是生产 RTO/SLA。RPO 用最后保留的 commit seq/hash 与已提交后缀损失数表达，不用“0 ms”掩盖数据损失。

## 故障处置清单

| 故障 | 诊断、恢复动作 | RPO / 继续交付验收 |
|---|---|---|
| 尾行完整 JSON 缺 LF | 备份后可写冷开；完整 version/seq/prev/hash 校验通过的记录必须保留并补分隔，不能作为半尾删除 | 无已提交损失；尾部业务仍在；新业务 committed 后再冷开保留 |
| 尾行不可解析的未终止片段 | 备份后冷开保留最后有效前缀；仅丢弃该半尾，不用于跳过中段错误 | 演练保留 seq=4，丢弃未提交片段；新业务提交并再冷开 |
| 中段坏 JSON | 普通冷开 fail-closed 且不改坏日志；只读 salvage → dry-run → 核对丢弃范围/外部副作用 → 用户明确 RPO 确认 → repair apply | 演练保留 seq=2，明确丢失后继两笔已提交业务（一份 doc 和一个 task）；repair 的备份逐 bytes 等于 damaged log；恢复后提交和冷开 |
| snapshot 领先日志 | 不可信 cache 被忽略；全量回放日志 | 无已提交损失，原 task/doc/body 全部在；新业务提交和冷开 |
| snapshot hash 不匹配 | 不可信 cache 被忽略；全量回放日志 | 同上；演练还污染 cache 的 task/doc，以证明非空状态来自日志 |
| snapshot 丢失 | 不要求先造 snapshot，按日志全量回放 | 同上；snapshot 是优化，不是日志替代品 |
| lock 残留 / 接管 | 同机活写者只读降级并拒写；已知本 fixture 子进程自然 exit 后，新进程按合作锁协议接管 | 不删除旧锁、不伪造 PID、不按磁盘 PID 杀进程；已提交数据无损；新业务提交和冷开 |
| meta 缺失 | service 不能自动发现缺 meta 项目；确认 not-found 后，人工从预先一致备份恢复本项目 meta，再冷开 | 演练日志完整、meta 备份一致，所以无已提交损失；没有可信备份时停止并记录失败，不自动重建或创建另一块看板 |
| 路径漂移 / meta 旧 cache | 使用真实 committed `project.relocate` 日志；meta 仍指旧路径时，新进程 `openByWorkspace` 通过日志发现并自愈 meta/index | 无已提交损失，不创建重复项目；从新 workspace 继续提交并再冷开 |
| blob 孤儿 | 实际 doc 更新因 baseRev 错误而拒绝，预写 blob 物理留下；离线核对已提交 doc 事件的 hash 引用与公开 docs | 孤儿不得公开；保留物理 blob，业务 doc 不丢，新业务提交/冷开；没有自动 GC 或 health 物理孤儿枚举，不新增删除操作 |

## 中段损坏的离线 CLI 顺序（仅用户人工维护授权副本）

下列 `<absolute-data-root>` 必须由操作者核对，不是演练 runner 的参数；执行前须完成上面的停写与两层备份。

```sh
node scripts/salvage-log.mjs --root <absolute-data-root> --project <id> --view board
node scripts/repair-log.mjs --root <absolute-data-root> --project <id> --truncate-to-valid-prefix
```

salvage 出现边界时 exit=2，输出 `current=false`、`readOnly=true`、validSeq/validHash 与“只读前缀，非当前状态”；不能把前缀 health 绿解读为整块日志健康。dry-run 零写，显示丢弃物理行/字节范围与 RPO。将范围、业务损失、外部副作用和 validHash 交用户确认；不能把演练的自动确认冒充真实授权。

确认后才由操作者执行：

```sh
node scripts/repair-log.mjs --root <absolute-data-root> --project <id> --truncate-to-valid-prefix --apply --confirm-data-loss <exact-validHash>
```

缺确认必须拒绝。任何现有 lock/claim（即使 stale）都拒绝 prefix apply；不使用 force 绕过，不自动删锁。操作者先确认停写和真实归属，按锁协议/既有运维处置，不根据磁盘 PID 猜测终止。跨主机锁不自动接管。

apply 先独占保存并 fsync 原坏日志备份，再校验原字节/锁并替换前缀；必须核对生成备份与 damaged log **逐 bytes 相同**。未知事件或不支持版本不属于该模式支持的前缀修复，拒绝后另行升级处理；不要跳过坏行拼接后继。I/O 失败可能留下 backup/tmp，应停下留证而非盲目重试。没有目录 fsync/真实断电持久性保证。

## 完成标准与失败上报

每项记录准确命令、预期/实际、pass/fail/skip、恢复时间、RPO、pristine/damaged/CLI 备份与日志证据。仅 health 绿不足以通过：必须有新业务 `committed:true`，再次冷进程打开仍保留且 health 无错误；主链核对 cmdId 去重不追加、日志连续 rev/hash、真实 artifact 与最终 done。

先区分 fixture 设置错误、正确拒绝和生产恢复失败。真正失败由父控另立问题，附最小复现、影响范围与原始报告；本 runbook 不弱化预期、不顺手重写 production、不口头通过。当前行为不支持的恢复能力明确写出限制。独立审查、完整 strict、人工验收、合入与部署分别由父控/用户安排。

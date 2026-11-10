# RFC-4 增补：执行前校验、持久 execution 凭证与证据 supersede

- 状态：Implemented（复核返工第 2 轮）
- 日期：2026-10-28
- 关联：RFC-4 证据强度与宿主执行
- 本增补修正首轮实现的三个复核阻断：进程内 proof 不可跨重启、legacy 证据被误判 error、begin 后 acceptance 仍被旧证据满足。

## 1. 执行前校验（preflight）

首轮 `project_task` 在 `handle.command()` 校验任务/rev/lease 之前就执行了 command 证据。提交给不存在的任务时命令已经产生文件副作用。

修正：

- `ProjectHandle._preflight(cmd)` 在克隆 state/leases 上跑完整 `_execute` 校验（state、expectedRev、lease/token、acceptance、证据结构、policy），不 append、不 collect expiry、不写 blob。
- `project_task` 的 submit/reconcile 分支在 `prepareEvidence()` 前调用 preflight；preflight 失败 → 命令不执行。
- 成功 preflight 后才执行 command/test，随后 `handle.command` 再走真实提交；preflight 与提交之间的极小竞态由 expectedRev/token 兜底，最坏是“执行了但提交 stale”，不会再出现“未校验先执行”的常见路径。
- 回归：`host-tools.test.mjs` 用不存在的 taskId + 会写 marker 的命令，断言 marker 不存在。

## 2. execution 来源：持久密钥 + attempt 绑定

首轮只检查 `execution.executor==='host' && exitCode===0`，调用方可以直接填这些字段；第二版用进程内随机 HMAC，重启后合法 proof 全部失效。

修正：

- `<rootDir>/execution.key` 是每块看板一份的 HMAC 密钥，首次启动用 `O_EXCL` 创建（0600），放在项目目录外；`ProjectService` 构造时加载，host runner 用 `handle.service.executionKey` 签名，core 用同一把 key 复核。重启后仍然能验证。
- `proofVersion=2`。没有 proof、proofVersion 缺失/1 且签名不匹配的旧记录是 legacy（warning，只能人工 verify）；只有 proofVersion=2 的签名不匹配或绑定不匹配才是 `execution-untrusted` error。
- `taskId`、当前 `attempt`、open `intentId`、`sha256(ref)` 任一不匹配都不算强证据；模型通过工具/HTTP 传入的 `execution` 仍被 host runner 整体丢弃并重新执行。
- 离线（`PB_COMMAND_EVIDENCE=off`）不伪造 host execution，按 self-reported 处理。
- 回归：`test/evidence-restart.test.mjs` 起独立子进程，用父进程签的 evidence 走 `task.verify`；`test/evidence-audit.test.mjs` 覆盖 legacy-no-proof / legacy-proof。

## 3. auto verify 与人工 verify 共用复核

- `taskSubmit` 在 auto verify 前跑 `auditEvidence`；任何 hard error（file/doc drift、proofVersion=2 的 execution untrusted、command failed）都不 auto done。
- `taskVerify` 使用同一函数；hard error → `evidence-drift`；legacy self-reported / legacy-no-proof / legacy-proof 只 warning。
- health 对每个任务跑同一审计，error 进 warnings（最多 10 条）。

## 4. 证据 supersede 与 acceptance 覆盖

- `begin` 开启新 attempt 时把上一 attempt 的 evidence 标 `supersededAt/supersededBy`；历史保留，但 audit/auto-verify 只看 active evidence。
- 同一次 begin 还把每条 acceptance 的 `met` 重置为“是否存在 active evidence”；`taskSubmit` 的 acceptance 覆盖检查只认 active evidence。返工必须为每条 acceptance 重新提交证据，旧文件漂移不会被 supersede 掩盖。
- 没有 `begin` 的 submit（policy 允许）不会自动 supersede，旧证据漂移仍会阻止 auto verify。
- 回归：`test/evidence-audit.test.mjs` 的双 acceptance 用例——begin 后 met 全 false；只提交一条 → `missing-evidence` 且零提交；两条都提交后才 done。

## 5. 口径调整

- verify **不自动重跑** command；只复核已记录 execution。健康查询也不执行命令。重跑作为未来独立策略（需要隔离/显式授权）。
- snapshot 失败明确为静默忽略（纯优化）；meta/registry 失败才进 `warnings`。

## 6. 反向对照

主 RFC 的取舍不变：不实现同宿主第二执行器；stdoutHash/exitCode 是执行留痕，不是完成证明。持久签名只解决“调用方伪造 host 记录”和“重启后不可验证”，不解决“命令输出与目标相关”的问题。

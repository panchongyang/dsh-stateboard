# RFC-4 证据强度与宿主执行

- 状态：Proposed（人审前）
- 日期：2026-10-28
- 范围：command/test 证据的宿主执行、证据强度分级、auto verify / verify / health 复核、旧数据与离线兼容、反向对照取舍。
- 不在范围：审计日志签名、独立第三方执行器、历史回滚。

## 1. 问题

v1 的证据只有 file/doc 在服务端做了 hash/rev 校验；`command`/`test` 完全 self-reported：模型可以写 `{kind:'command', ref:'npm test', summary:'passed'}`，没有 exitCode、没有 stdout、宿主不执行。auto verify 把非 file/doc 一律当作已校验，于是“命令通过”可以只靠一句话。

本 RFC 把证据分成“强/弱”，并让宿主在 submit/reconcile 前执行 command/test，留下可复核的执行记录。

## 2. 强度分级

| 等级 | 证据 | 判据 | 可用于 auto-verify |
|---|---|---|---|
| strong | file | 服务端 hash + verifiedAt，且 ref 在 workspace 内 | 是 |
| strong | doc | doc@rev 存在，hash 与当前 doc 一致 | 是 |
| strong | command / test | `execution.executor=host`、`status=ok`、`exitCode=0`、stdoutHash 64hex | 是 |
| weak | command/test 无 execution | 旧日志/直接 HTTP 自述；只登记 | 否 |
| weak | url / note | 只登记 | 否 |

`acceptance.requiredKinds` 仍按 kind 过滤；强度只影响 auto verify 与 verify 的复核，不改变“每条 acceptance 至少一条合格证据”的规则。

## 3. 宿主执行协议

`project_task` 的 `submit` / `reconcile` 分支在发命令前，对每条 `kind ∈ {command, test}` 执行 `ref`：

```js
execution = {
  executor: 'host',
  status: 'ok'|'failed'|'timeout'|'error',
  exitCode: number|null,
  signal: string|null,
  timedOut: boolean,
  stdoutHash: sha256(full stdout),
  stderrHash: sha256(full stderr),
  outputBytes: number,
  commandHash: sha256(ref),
  executedAt: ISO,
  cwd: workspacePath,
  error?: string
}
```

约束：

- **只由宿主写 execution**：工具收到模型传入的 execution 也整体丢弃并重新执行；模型无法手填 exitCode/stdoutHash。
- cwd = 项目 workspace；shell 执行；默认 timeout 120s（`PB_COMMAND_EVIDENCE_TIMEOUT_MS` 可调）；stdout/stderr 只保留 hash + 字节数，不把大输出写进日志。
- `PB_COMMAND_EVIDENCE=off` 时不执行，记录 `status=error`，该证据只能是弱证据；适用于受限/离线宿主。
- HTTP 直连 `/commands` 不执行命令（没有 cwd/宿主 runner），只能提交自述证据（弱）；需要强 command 证据必须走 `project_task`。
- 执行失败不阻止 submit（证据先落账），但 auto-verify 不会通过；verify 会以 `evidence-drift` 暴露。

## 4. 复核策略

### auto verify（policy=auto 且非人审门）

`allVerified` 改为 `evidenceVerified`：

- file/doc：`hash && verifiedAt`；
- command/test：`execution.executor=host && status=ok && exitCode=0`；
- url/note/无 execution：false。

因此“文件证据 + 真跑过的命令”才能自动 done；self-reported command 停在 review。

### verify（human/verifier）

verify 前调用 `auditEvidence(state)`：

- file：重新解析路径/realpath，重算 sha256；missing/越界/hash 不符 → `file-drift`（error）。
- doc：doc 不存在或当前 hash 与证据 hash 不符 → `doc-drift`（error）。
- command/test：无 execution → `command-self-reported`（warning，放行）；status 非 ok 或 exitCode ≠ 0 → `command-failed`（error）。
- url/note → `weak-evidence`（info）。

有 error → 抛 `evidence-drift`（409，details.warnings），任务停留 review；只有 warning → 允许 human verify，warning 随命令结果返回。

### health

`health()` 对所有带 evidence 的任务跑同一审计，把 error 级问题加入 warnings（最多 10 条），健康页 `ok=false`；不读文件内容的重复 hash 只对 workspace 内文件生效。

## 5. 旧数据与离线兼容

- 旧 command/test 记录没有 `execution`：`command-self-reported` warning；不阻止 human verify，但永不 auto-verify。
- 旧 file 记录没有 hash：`file-unhashed` warning；有 hash 的照常复核。
- 旧 doc 记录照常按 doc hash 复核。
- 离线/受限宿主：runner 记录 `status=error` 或 `PB_COMMAND_EVIDENCE=off`；证据是弱，人工 verify 仍可用，但 UI/health 明确标注。
- 不迁移旧事件；不把旧 `verifiedAt` 伪造成 host execution。

## 6. 反向对照：本轮取舍

“反向对照”指用独立来源证伪模型的自述（例如同一命令由第二个执行器重跑、或用只读快照对照）。本轮**不实现**独立第二执行器，理由：

1. 第二次执行仍是同一宿主/同一权限，不能证明第一次执行的副作用没有发生；只有隔离环境/独立签名才有实质增益。
2. 命令可能有副作用；verify 时自动重跑会把“复核”变成“再执行”，风险高于收益。
3. 文件/doc 的 hash 复核已经提供了可机械证伪的对照；command 的 stdoutHash 只证明“宿主跑过并捕获到这段输出”，不证明输出与任务目标相关。

明确记录：`stdoutHash/exitCode` 是**执行留痕**，不是“任务完成”的充分证明；高风任务仍需 human verify 或后续独立执行器（RFC-5 候选）。核心测试覆盖该取舍：failed/self-reported/legacy 分支各有用例。

## 7. 测试

- host runner：exit 0 → status ok/exitCode 0/hash 64；exit 3 → failed；file 证据不执行。
- core：host command exit 0 auto done；exit 1 停 review 且 verify `evidence-drift`；file 改动 health 报 `file-drift`、verify 拒绝；legacy self-reported 只给 warning 且 human 可 verify。
- 回归：`npm test`、`npm run audit:check`、client bundle 重建。

## 8. 风险

- 模型可以提交任意命令；runner 以项目 workspace 为 cwd、120s 超时、无输出落盘，但仍有副作用/资源消耗。缓解：只在宿主工具执行、`PB_COMMAND_EVIDENCE=off` 可关、输出只留 hash。
- `stdoutHash` 可被重放（同一命令输出相同）；它不是 nonce/签名。需要防重放时另立签名/挑战方案。
- health 每次重算文件 hash，大 workspace 可能慢；当前只对 evidence 文件，后续可加缓存/采样。

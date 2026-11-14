# 命令总线模块内部契约

> 文档定位：L4 模块内部契约；L1 权威：[命令信封](<../../CONTRACT.md#21-命令信封错误码与-http-映射>)、[命令清单](<../../CONTRACT.md#22-命令清单>)、[句柄 API](<../../CONTRACT.md#服务与句柄>)。

本文面向适配器与 core 处理器作者；取舍见[模块设计](<design.md>)。

## 1. 职责与非职责

总线调度已建立可信身份的命令，隔离工作投影，发布 store 提交结果。
**非职责**：不认证网络请求、不执行证据、不验证报告结论、不做跨项目原子事务。
产品级 payload/返回字段只在 L1 定义，此处只规定内部调用边界。

## 2. 导出 API 与入口

| 实现入口 | 内部语义 |
|---|---|
| [ProjectHandle](<../../../lib/core/handle.js>) | constructor(service, meta, store, data) 接受已打开 store 的结果 |
| command(cmd, options?) | Promise；通过项目队列调度命令；返回值语义见 L1 |
| assertStateAttached(handle) | handle.state 必须与 store.state 同一引用，否则内部错误 |
| recover / attach / detach | 恢复与会话生命周期入口，不是可任意替代业务命令的写口 |
| touch / refresh | 运行时活性、follower 追尾；不替代 command |
| createdTaskId / liveClaimReceipt | 从已提交命令恢复创建身份或仍有效的领取回执 |
| [COMMAND_HANDLERS](<../../../lib/core/commands/index.js>) | 自有属性 op → 同步 handler(handle, cmd) |
| [validateIntakeCommand](<../../../lib/core/command-shape.js>) | 对指定 intake 路径验证字段与嵌套定义 |

[service.js](<../../../lib/core/service.js>)保留 ProjectHandle 重导出，服务负责共享句柄引用。
query/digest/health 的产品读语义见[L1 查询](<../../CONTRACT.md#查询>)；不是绕过领域守卫的写口。

## 3. 命令输入校验域

command 要求非空 cmdId 与字符串 op；未知 op 由注册表拒绝。
projectId、actor 来源和工具字段翻译由入口负责，不把自报 actor 当认证。
core 并不统一清洗每个命令的所有字段；不能假定有全局严格 schema。

- 总线仅在 expected.projectRev 为整数时执行项目 CAS。
- 已有任务的 expected.entityRev 由 lease/assertRev 等实体守卫强制。
- 计划的 head.rev 与 baseVersion 校验由计划处理器区分。
- intake 白名单覆盖 task.create/update/gate、plan.create/publish/revise。
- 计划 step/task 嵌套字段和 gate 命名空间由同一 shape 模块检查。
- draft publish 会重验已存定义，不能把创建时检查当永久保证。
- 其他命令的参数域应读对应[task](<../task/contract.md>)或[plan](<../plan/contract.md>)契约。

command 的 options 是受信内部执行上下文，不能由业务 payload 自由注入。
外部工作会话绑定需要通过 workSessionSource/claimSessionSource 的现有适配链路。

## 4. 处理器返回与不变量

handler 是同步函数，不应返回未等待的 Promise 作为业务结果。
内部返回对象以 events 为事件批次，可附 entityRev/result/warnings/relocate。
memoryOnly 仅用于明确的无日志运行时更新，不能作为绕过提交的通用开关。

处理器只在 handle 当前工作投影上计算，不直接调用 store.append 或保存 meta。
工作投影可以暂存 token、lease、binding 和固定证据来源。
总线在成功计算后统一检查新增同阶段依赖；处理器不能绕开该出口。

_appendEvents 返回 commit 或空值；非空提交后必须满足 state 别名断言。
事件顺序有意义：回收 preceding 在前，业务及其级联事件随后同批提交。
实体 expectedRev 对 committed 值检查，不对本次回收产生的临时 rev 检查。

## 5. 副作用与提交边界

“命令拒绝零落盘”只指未产生该命令权威事件，不能泛指所有物理文件。
文档预写 blob、证据读取以及生命周期 open 的 I/O 有独立边界。
内存回滚不会删除预写 blob，也不会撤销调用方此前执行的外部工具。

- 业务抛错时恢复真实 state/leases，不发布回收和 token 分配。
- 有事件才构造 commit 并交给 store；提交确认后安装工作 lease 表。
- store 结果不明时同步 handle.readOnly，不继续 staging 下一条写命令。
- 日志已提交后 relocate 的派生更新失败转 warning，不反报未提交。
- snapshot 失败由 store 静默处理，不应包装成命令失败。

持久化失败解释见[store 内部契约](<../store/contract.md>)；禁止把 fsync 异常直接等同未写。

## 6. 并发、幂等与租约

每个 handle 的 _exclusive 串行化 command/attach/detach；异常不终止队列。
服务共享同一项目 handle，调用方不能自行复制 rev/cmdIds 开第二个 writer。

已提交 cmdId 在只读闸之后去重、在 CAS/领域计算之前返回成功去重结果。
同 cmdId 不比较新 payload；重试必须表示同一原意，不能拿旧 id 发新操作。
新 cmdId 的空事件结果不进入持久 Set，再调用仍要通过前置校验。
renew 不写 commit，其 MCP 运行时去重不等同持久命令去重。

touch 仅影响同 session/epoch 的内存活性与有界续期，不记业务进展。
时间相关领取预览不替代命令校验；所有写仍须通过实时领域守卫。
只读 follower 的 refresh 不自动抢 writer，也不 recover 任务。

## 7. 错误分类

code/status 权威见[L1 错误表](<../../CONTRACT.md#错误码>)。
内部调用按恢复动作分组：参数拒绝、领域/角色拒绝、CAS 冲突、租约冲突、存储不确定。
CAS/fencing 冲突必须重读并重新决策，不靠自动加 rev 或替换 token 重试。
state-desync/closed 等内部错误见[handle 实现](<../../../lib/core/handle.js>)，不据此扩充对外错误表。

## 8. 隐含契约与兼容

1. _preflight 是内部私有检查，不是副作用执行器；不能凭旧注释新增命令执行。
2. 不直接调用 _execute/_appendEvents 模拟完整 command，它们各只覆盖部分闸门。
3. 返回 ok=true 不保证 committed=true；no-op 与 memoryOnly 需按 L1 解释。
4. readOnly 句柄不能利用已提交 cmdId 再获取写能力；去重不授予权限。
5. recover 只能由 writer 生命周期按既有入口执行，不能当成只读 query。

注册表与[共享 COMMAND_OPS](<../../../lib/shared/contract.js>)必须保持对应；不得新增仅单端可用的业务命令。
事件拼写与兼容分类来自[EVENT_REGISTRY](<../../../lib/shared/events.js>)，见[L1 applied/additive/migration/refuse](<../../CONTRACT.md#事件兼容契约fail-closed>)。
字段变化、schemaVersion 与事件类别是独立兼容域；仅未新增事件不保证旧构建安全。

## 9. 验证入口

[别名守卫](<../../../test/core/alias-guard.test.mjs>)检查 store/handle 交接；[租约回收](<../../../test/core/lease-reclaim.test.mjs>)检查失败丢弃与 committed CAS。
[归档写闸](<../../../test/core/archived.test.mjs>)检查 entry/出口；[提交边界](<../../../test/storage/commit-boundary.test.mjs>)检查持久结果。

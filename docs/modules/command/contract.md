# 命令总线模块内部契约

> 文档定位：L4；对外输入、结果和错误在 [L1 命令信封](<../../CONTRACT.md#21-命令信封错误码与-http-映射>)与[命令清单](<../../CONTRACT.md#22-命令清单>)定义；取舍见[设计](<design.md>)。

## 1. 可信入口与输入域

[application](<../../../lib/core/application/index.js>)接收 host 已认证的 actor 及受信执行上下文。调用方不能通过业务 payload 指定 actor、写者、首绑来源或恢复权。`cmdId` 必须非空，`op` 必须由[共享清单](<../../../lib/shared/contract.js>)与[注册表](<../../../lib/core/commands/index.js>)支持。intake 按[形状守卫](<../../../lib/core/command-shape.js>)校验计划/任务写入，不把字段准入等同于领域资格。

## 2. 串行与值操作

- [项目串行](<../../../lib/core/runtime/serial-command.js>)为同一物理 writer 保有同一队列，不向 host 返回 writer；一条失败不终止队列。
- [命令准备](<../../../lib/core/commands/transaction.js>)生成值形式的身份和准备操作。模型按已提交记录去重与验证 CAS；已提交 `cmdId` 只应用于同一请求意图。实体 CAS 对调用方可读的已提交修订，不要求本次恢复派生的临时修订。
- 命令从一次性只读样本及所需端口收集观察，返回 `{kind,args}` 操作，不携带可执行回调、后置实体或预制事件。值必须可按 JSON 原样保存。
- 模型守状态转移、事件顺序和跨操作不变量；例如同阶段依赖由整批操作按新增差异检查，不能在入口复制或把历史缺陷当本次改写理由。

## 3. 回执与失败

[事务模型](<../../../lib/core/transaction/model.js>)由执行结果派生事件，核对单一物理回执再发布。拒绝不留本次状态、绑定、租约或权威日志变化；预写对象不是已提交事实，也不是全文件系统零写保证。日志、回执或发布不确定时关闭写入能力，以冷开和原 `cmdId` 对账，不改用新 ID 绕过。

空操作与纯运行态续租不写日志或记录新的持久 `cmdId`；已提交后的派生元数据和快照有独立失败边界，见[存储契约](<../store/contract.md>)。

## 4. 生命周期与兼容

显式 lifecycle 权限、正常业务首绑与授租限定首绑是三种能力。普通读不建立 binding，不续租或恢复。已 detached 的会话须受信显式重新 attach 才能取得新 epoch；详见 [L1 Host](<../../CONTRACT.md#26-host-表面>)。历史事件沿[兼容表](<../../CONTRACT.md#事件兼容契约fail-closed>)应用，不运行当前业务准入来重审历史。

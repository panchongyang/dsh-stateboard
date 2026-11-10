# 恢复与继续交付

## 硬规则与权限

**先备份，后 repair；先确认 RPO，后丢弃任何已提交后缀。** 可写 cold open 也可能规范化尾行、接管合作锁、提交恢复事件，不能当零写诊断。

真实DSH停写、启停、重启全部由用户手动完成。AI不根据磁盘旧PID杀进程或删除锁。维护前用户核对候选版本、项目id、绝对data/workspace与写者归属；停写后一致备份整个项目目录(meta/log/snapshot/blobs/锁诊断)及必要受控配置，私密配置不进入公开证据。

保存已知一致pristine；故障后、任何恢复前另存damaged，记录原日志bytes/SHA256，不覆盖备份。没有故障前一致副本要明确缺失。只在授权副本先演练，不在真实store或仓库样例造故障。恢复不撤销外部副作用，继续写后不能盲覆盖旧备份，代码回退不恢复已丢业务。

## 合成复现

冻结候选 9131f8c5（内部基线），在专用候选工作树中演练（本机留证，不随仓库分发）。完整现行操作手册见 [RECOVERY.md](../RECOVERY.md)。

```text
cwd: <仓库根>
node scripts/recovery-drill.mjs
```

入口无参，不接受真实root/output/opt-in，每次新建默认os.tmpdir下唯一合成根，Windows native canonical/随机标记/containment/link检查。子进程HOME/USERPROFILE/DSH_HOME/agents/appdata/temp/XDG/npm配置cache全fixture，剔除密钥/Node注入，不接真实配置。命令证据执行关闭，主链实际file证据仅合成artifact。

每项先在新进程建项目和pristine，故障后damaged，再冷进程恢复；提交真实业务命令，另一全新进程再打开验证保留/health。另有plan→claim/begin→冷重启recover interrupted→reconcile/resume→artifact→submit→合成human verify→再冷开/去重完整链。合成人审不是对真实看板任务自行verify。

## 故障处置与验收

| 故障 | 动作与边界 | 继续交付验收 |
|---|---|---|
| 完整JSON缺LF | 备份后可写冷开，先验证v/seq/prev/hash再补分隔，不能删完整记录 | 无已提交损失；新业务committed再coldopen |
| 不可解析未终止半尾 | 备份后保留最后有效前缀，仅移除半尾，不能跳过中段错误 | 演练seq4，丢未提交片段；新业务再coldopen |
| 中段坏JSON | 普通open failclosed不改坏log；salvage→dryrun→核RPO/外部副作用→用户明确确认→repair | 演练保留seq2、明确丢已提交doc+task两笔；CLI备份精确等原坏log，继续业务再coldopen |
| snapshot领先/hash不匹配/缺失 | 不可信cache忽略，按权威完整日志回放，不让污染cache伪造数据 | 原task/doc/body保留，新业务再coldopen |
| lock残留/接管 | 活写者只读降级拒写；已知合成子进程自然exit留下自身lock后冷进程合作接管 | 不伪造PID/不杀旧PID/不删真锁；无已提交损失 |
| meta缺失 | service先notfound；人工从预先一致备份恢复项目meta | 无可信备份则停止记失败，不自动重建/另造看板；演练可恢复继续 |
| 路径漂移/meta旧cache | 真实committed relocate记录为准，openByWorkspace从日志发现并自愈meta/index | 不重复项目，从新workspace继续并coldopen |
| blob孤儿 | 实际doc baseRev拒绝后预写blob留物理盘，离线对照已提交doc hash引用/公开docs | 不公开孤儿，不自动GC/health物理扫描，不删除；原doc保留且继续业务 |

## 中段损坏的人工维护顺序

以下仅用户已核对并停写、两层备份的授权副本。不是演练runner的真实路径参数。

```text
node scripts/salvage-log.mjs --root <absolute-data-root> --project <id> --view board
node scripts/repair-log.mjs --root <absolute-data-root> --project <id> --truncate-to-valid-prefix
```

partial salvage exit2，current=false/readOnly=true、validSeq/validHash明确，前缀health绿不等整日志健康。dryrun零写，显示丢弃物理行/bytes/RPO。范围、业务损失与外部副作用交用户确认后：

```text
node scripts/repair-log.mjs --root <absolute-data-root> --project <id> --truncate-to-valid-prefix --apply --confirm-data-loss <exact-validHash>
```

缺确认必须拒写，任何现有lock/claim包括stale拒绝prefixapply，不force/自动解锁，跨主机锁不自动接管。apply先exclusive+fsync原坏log备份，复核原bytes/锁再替换；核备份逐bytes等damaged。unknown事件/版本及非法结构拒写，不能跳坏行拼后继。I/O失败保留backup/tmp停下留证，不盲重试；不承诺目录fsync/真实断电持久性。

## 报告与完成标准

每次入口打印唯一临时根：report.json记录逐项命令/预期/实际/pass-fail-skip/恢复ms/RPO；steps/NNN记录精确Node argv、exit、stdout/stderr；cases/name/pristine和damaged保留完整副本，repair另有原字节备份。recoveryMs从damaged备份后计，含诊断/恢复/业务提交/再次coldopen，不含造fixture/备份/人工停写，不是生产RTO/SLA。

仅health绿不足通过：真实新业务committed、再次冷进程保留且health无错；总链验证rev/hash/去重不追加/artifact/final done。先区分fixture设置/正确拒绝与真正恢复失败；真失败另立任务附原报告，不弱化预期或口头通过，不在本任务无限重写production。

本次默认临时根的实测记录见内部验收档案（本机留证，不随仓库分发）；非默认临时父目录、其他系统、断电/rogue OS writer、UI/真实DSH不在通过保证内。独立验收、合入和部署分开决定；无用户授权不合入/部署，服务重启由用户执行。
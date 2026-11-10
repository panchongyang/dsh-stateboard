# 内嵌文档迁移与恢复 runbook

## 1. 能力、风险与授权

D6 是显式离线工具，不发现用户 home 或默认真实 store。默认执行只使用内存合成 fixture。迁移改变持久事件与文档解析来源，属于 R3；代码通过测试不等于真实数据迁移获准。

工具**不备份、不写工作区文件、不写正文 blob、不删除旧正文、不运行 Git add/commit/push、不改绑定、不部署或重启服务**。它仅把操作者已导出的、与原正文严格一致的文件登记到同一个 docId；工作区文件拥有者负责保存、审查和 Git 管理。登记成功不证明文件已提交、已公开、已部署或已通过人工验收。

人工必须分别确认：

1. 可读取/导出哪些真实数据；哪些内容公开、私有或归档（D7）。报告和正文默认 private。
2. 迁移期间所有看板写入已停止，并完成**整个看板根目录**的一致性全量备份（项目日志/快照/blob、身份与绑定注册表、密钥/认证等），在隔离副本上恢复演练。固定 Git 证据另按[对象保留与备份](<DOC-EXTERNAL-EVIDENCE.md#6-保留备份与回退>)保留所引用对象；当前文件不能代替历史对象。
3. 每个 sourceDocId/sourceRev/sourceHash 和目标 locator；目标文件内容与编码/换行/BOM 均正确。
4. 真实写入的项目/备份绝对路径及授权；不可恢复项的处理；是否开启本项目新增 inline 写封锁。

缺 blob、hash/size 不符、缺修订或证据 hash 冲突不得静默跳过，也无“拿当前正文补齐”或强制迁移开关。必须先由人确认并从可信备份恢复**精确原字节**，重新盘点/备份；无法恢复时保留报告与原登记，交人工门显式处置。工具不会伪造成功映射。

## 2. 只读清单、dry-run 与原 hash 导出

```text
node scripts/doc-migration.mjs
node scripts/doc-migration.mjs --export-bodies
```

默认只读合成 fixture：两个文档、多 rev、link-only rev、历史证据、缺 blob。不打开真实 store。

[只读 API](<../lib/core/documents/migration-inventory.js>)：`inventoryInlineDocuments({state, commits, readBlob, destinations?, includeBodies?, bindingRoots?})`。返回可 JSON 序列化的 `schemaVersion:1`：

| 字段 | 逐项内容 |
|---|---|
| anchor/current | 输入 seq/hash；全部当前内嵌记录（不是数量估计） |
| revisions | 每个 docId@rev、原 hash/size、links、事件位置、引用者、blob 状态；link-only rev 保持独立身份 |
| associations/evidence/fixedContents | 所有历史文档↔任务/计划关系及历史事件/当前任务每条 doc 证据；含独立 doc/content-fixed 事件与当前固定索引，fixed 行保留 Git 固定身份，不解释成 inline |
| missing | 缺正文、内容/size 不符、缺修订、悬空关系、证据 hash 冲突 |
| destinations/conflicts | 人输入的去向与同路径冲突；大小写别名保守冲突，不自动接管；提供 bindingRoots 时也检查同根不同绑定 |

迁移磁盘 blob 读取使用专用 `readMigrationBlob`：普通文件、前后对象/size/mtime/ctime 检查、最多 16 MiB（探测多一个字节）、严格 UTF-8，保留 BOM/NUL，不套用正文预览格式启发式；既有 `store.readBlob` API 行为不变。

`--export-bodies` 在 `revisions[].blob.body` 中输出按**原 SHA-256(UTF-8 字符串)**核验的正文（含原 BOM/CRLF）；不带该选项时不输出正文。导出只到 stdout，工具不创建文件；重定向 stdout 是操作者保存输出，不是 dry-run 自身写入。历史证据的原 hash 与 blob 是否存在逐项列出，即使找不到修订事件也保留缺项。

真实数据必须先获上述授权与一致性备份，再显式执行：

```text
node scripts/doc-migration.mjs --store "D:\Authorized\board\projects\prj_example" --authorized-read --export-bodies
```

只读入口使用 `JsonlStore` 的 `lock:false`：不写锁/心跳、不修补日志尾、不写快照、不产生事件或 blob。项目目录必需显式给出；无隐式 home 降级。可用 `--destinations <JSON文件>` 输入 `[{"docId":"doc_…","locator":{"bindingId":"bnd_…","relPath":"docs/spec.md"}}]` 作去向冲突检查。

操作者将核验后的 JSON `body` 以原 UTF-8 字节保存到批准的工作区目标；自行保存时应使用排他创建（例如 `fs.writeFileSync(file, Buffer.from(body,'utf8'), {flag:'wx'})`），不覆盖已有用户文件。已有目标不同字节时选新路径或由文件所有者另行处置；迁移工具不会替换它。历史原 blob 继续保留；如另行导出到 Git 档案，须保留原 hash 核对，不能删除仍被引用的 store blob。

## 3. 一致性备份检查（工具不会创建备份）

```text
node scripts/doc-migration.mjs --store "D:\Authorized\board\projects\prj_example" --authorized-read --check-backup --backup "D:\Backup\projects\prj_example" --restore-tested
```

[检查器](<../lib/core/documents/migration-backup.js>)实际读取备份，要求：项目 ID 一致；日志完整且 hash 链有效；备份为当前来源的前缀；其中全部内嵌历史 blob 的原字节 SHA-256 正确；来源在该备份之后只有已完成的迁移事件。备份目录不能是 live store 自身。其他看板写入推进来源后必须重新做一致性备份。

`--restore-tested` / API `backup.restoreTested:true` 是**人工已做恢复演练的声明**，不是工具自动做过演练。检查器只检查所选项目的日志、项目身份和内嵌 blob，不宣称验证整个看板根目录、跨文件原子性、Git对象保留或实际恢复演练。全量备份与停止写者仍是人必须确认的前置条件。缺失、损坏或不匹配的备份拒绝写入。

## 4. 正式迁移

映射输入为 JSON 数组：

```json
[{"sourceDocId":"doc_example","sourceRev":3,"sourceHash":"<完整小写hex64>",
  "locator":{"bindingId":"bnd_example","relPath":"docs/spec.md"}}]
```

```text
node scripts/doc-migration.mjs --apply --board "D:\Authorized\board" --project prj_example --backup "D:\Backup\projects\prj_example" --mappings "D:\Authorized\mappings.json" --authorized-read --authorized-migrate --restore-tested
```

`--apply` 的 board/backup 必须是绝对路径且项目已存在；授权参数缺失时不打开写句柄。读模式永不升级为写模式。执行期间不得让另一个服务同时写该 store；锁失效/只读则停止，不绕过锁。需要手动停止/重启主服务时只能由人操作，代码工具不运行服务管理命令。

核心入口：[migrateInlineDocuments](<../lib/core/documents/migration.js>)；单条命令 `handle.command({op:'doc.external.migrate',cmdId,actor:{kind:'human'},authorized:true,backup:{directory,restoreTested:true},sourceDocId,sourceRev,sourceHash,locator})`。只允许 human/system，工具 agent 不能调用迁移命令。

单文档原子 commit，批次逐文档推进。原 docId/title/kind/任务与计划 links 保持，rev 从 sourceRev 加 1，当前来源变成 external、管理状态 draft、baseline 未确认。不会自动采用、确认或生成 Git fixed 证据。

`doc/external-migrated` 是[现有事件注册表](<../lib/shared/events.js>)中的 applied 类型：

- 事件顶层 `sourceDocId/sourceRev/sourceHash`，与 `data.migration` 内的同名字段严格一致。
- `data` 是完整 external 记录，`data.migration = {v:1,sourceDocId,sourceRev,sourceHash,target,history}`。
- `target = {locator,contentIdentity:{domain:'workspace-bytes',contentHash,size}}`；初始目标必须与原正文严格等字节，不拿 Git blob hash 冒充 workspace hash。
- `history[] = {sourceRev,sourceHash,size,archive:{domain:'inline-utf8',hash,readOnly:true,gitManaged:false}}`，包括所有历史 rev 和 link-only rev。历史恢复仍读原 blob，不读新目标补历史。
- `backup` 仅记已检查的 projectId/seq/hash/restoreTested，不把本机备份绝对路径写入事件。

返回 `schemaVersion:1, mappings:[完整迁移映射], problems:[逐项错误]`；有 problems 的 CLI exit code 为 2，不能把部分成功当成全量完成。输入内目标/来源映射冲突先整体拒绝；其他失败逐项报告，已提交项不撤回。相同输入以新 cmdId 重跑也不追加事件，返回相同映射；修改来源身份或目标则 migration-conflict。完成映射是历史登记事实，不承诺目标文件此后永不变化。

写前与全日志回放共同验证 source hash/rev、目标身份、穷尽历史映射及关联保留；元数据更新不能改 migration provenance。原 blob 和日志保留。快照在自己的 seq/hash 锚点比较，不清空历史。health/fsck 验证映射结构，当前文件变化/缺失仍属可用性，不是存储损坏。

## 5. 中断、竞争与可重复恢复

| 中断/失败点 | 重跑结果 |
|---|---|
| 授权/备份/来源/路径/缺 blob/目标不同字节 | 无迁移事件，无工作区写入；修复前置条件后重跑 |
| 来源 blob 或导出的目标文件在多次验证读取之间变化 | 拒绝并报告；不提交迁移事件。目标读取复用有界安全 reader 的对象身份/mtime/ctime检查，另比较两次完整 hash；不承诺抵抗最后一次检查之后的外部修改或保留全部元数据的恶意竞争 |
| WAL 部分写，原 store 能确认恢复尾部 | 恢复原字节边界并报原错误；重跑只写一条迁移事件，无需手工删文件 |
| 进程死在未完成 JSON 尾部 | 冷开验证有效前缀；授权写打开使用现有 framing 恢复路径，然后重跑该映射。只读打开不修复；完整但坏 hash/未知事件不会自动丢弃 |
| commit 已持久化、响应/close acknowledgement 丢失 | store 只读，关闭后冷开；日志已含映射则重跑返回同一映射，不重复写 |
| 批次已完成 A、B 不可恢复或进程退出 | A 保留；按原数组重跑时 A 幂等，B 显式报错/续跑。不要人工删除已完成映射或清理 store blob |

[可复现合成测试](<../test/docs/doc-migration-write.test.mjs>)提供三个中断序列：写入前 17 字节后 EIO → 尾部回滚 → 重跑；成功 fsync 后 close 丢 ack → 冷开 → 重跑；只保留计划 commit 前 41 字节模拟崩溃 → 冷开 → 两次重跑。断言原/最终日志字节、完整 hash 链、事件数、docId集合与映射一致；无需手工清理。文件全部位于临时合成 board/workspace/backup，绝不访问默认 store。

## 6. 兼容读取与 inline 写封锁

[readInlineArchive(handle,docId,sourceRev)](<../lib/core/documents/migration-archive.js>) 返回 `source:'inline-archive',readOnly:true,gitManaged:false,domain:'inline-utf8'` 与原 hash/body。只读清单同样标明档案来源；旧 inline endpoint 不猜 external 正文。

旧 persisted docId@rev 与无 fixed 的历史 hash 证据仍按原 blob 审计；迁移文档的历史 @rev 新引用也按映射取原 hash，不解释为当前文件。裸 docId 的新证据走 external 自动固定/降级；既有 fixed Git 证据原样保留，不改为 workspace 或 inline 域。历史缺 blob 仍明确报错。

迁移文档的旧 doc.put/doc.link 永远返回 inline-write-disabled，不写 blob。未迁移的内嵌文档也不再是可写格式：项目默认是禁写内嵌，`doc.put`（新建与既有编辑）和 `doc.link` 一律返回 `inline-write-disabled`(409)，拒绝发生在写 blob/追加事件之前，store 字节与事件数不变。新内容的唯一生产写入通道是工作区文件 + 外置登记；内嵌只作为只读档案。

唯一的生产例外是 human 显式打开的本项目开关：

```text
{op:'doc.inline_policy',cmdId,actor:{kind:'human'},authorized:true,
 expected:{projectRev:<当前rev>},disabled:false}
```

开关状态写入 `project/updated`（带 actor 与 cmdId，可按事件追溯），必须先拿到当前 projectRev。`disabled:false` 只恢复**未迁移**内嵌文档的旧 doc.put/doc.link 语义（含 baseRev 规则）；它不把迁移档案变回可编辑 inline，不修改外置登记、历史或文件。`disabled:true` 恢复禁写。agent/system 调用一律 `forbidden-role`；没有环境变量、配置文件或工具参数后门。

新项目创世记录即带 `inlineWritesDisabled:true`；没有该字段的旧项目按禁用处理（只有显式 `false` 放行）。宿主入口（`project_doc` 工具、`POST /commands`）在**打开项目之前**先用与 core 同一套形态校验（title 的 `String` 强制转换、body 长度、link 归一化），再用无锁只读重放 peek 已持久化的项目记录做策略判定：注定被拒的内嵌写入不会创建新项目，也不会触发冷开恢复写入；peek 读不到时回落到正常打开，由 core 的同一道闸兜底。`project_doc put` 不再隐式创建项目，新工作区应先发布计划。迁移工具本身不受开关影响，是唯一的内嵌→外置转换通道。

合成夹具需要制造内嵌档案覆盖兼容读取时，用 `ProjectService({privilegedInlineWrites:true})` 构造（仅测试/seed 代码路径，HTTP、agent 工具与环境变量都触达不到）；见 [TEST-ENV](<TEST-ENV.md>)。

## 7. 回退、RPO 与门禁

1. 人工停止写入，保全失败现场与报告；不要自动 quarantine、salvage 或改写真实日志。
2. 首选保持新代码、恢复确切缺失 blob/目标文件或绑定前置条件，再按同一映射续跑；路径冲突改映射需人工重新确认，已完成映射不能静默改指。
3. **代码回退**：恢复切换前代码版本，且同步恢复切换前经过演练的**整个看板一致性备份**；不能只回退代码或只删 migrated 事件。已产生 migrated 的日志对 pre-D6 读方为 incompatible-event（含快照覆盖段），其 salvage 前缀停在该 commit 之前。
4. **数据回退**：全量恢复匹配的 store/元数据/绑定/密钥，先在隔离副本核对项目、任务、文档数、关联、hash链与历史证据，再由人决定切换。恢复操作和服务重启不属于工具自动授权。
5. **RPO＝所恢复的一致性备份时点**。备份之后的所有看板写入（含非文档写入）都会丢失；外部工作区/Git 文件与其他副作用不会回滚，须单独核对。没有零数据丢失承诺。

现有 [stores-replay 门禁](<../scripts/stores-replay.mjs>)继续要求投影文档数等于创建身份数：doc/created 与 doc/external-registered 各创建一个 docId；migrated 仅转换既有身份，**不能计作创建**。只统计 doc/created 会误拒合法外置登记；把 migrated 加进创建数则会掩盖重复身份，故明确不计。合成测试反向断言迁移前后 docId 集合/数量完全相同，并独立登记一个 external 后才允许文档总数加一。旧注册表拒读测试维持，不放松未知事件门禁。

测试入口均接入 test:core：[只读矩阵](<../test/docs/doc-migration.test.mjs>)、[写入/恢复矩阵](<../test/docs/doc-migration-write.test.mjs>)。阶段实现门禁为 audit:check、test-discovery 与这两套测试，以及既有 doc-external*/doc-fixed*/replay-snapshot/event-compat/stores-replay*。最终隔离候选、真实数据授权副本核对和独立审查由主控执行；本文不宣称已完成真实迁移或人工验收。

delegation: no — 受限实现子代理直接完成，未再委派。

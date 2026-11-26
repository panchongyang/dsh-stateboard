/**
 * 测试职责：核对空间内已登记文件 → 明确采集 → 精确回读/漂移的完整 core 链。
 * 典型流程：两次采集后外部改回原文，冷开复制点，比较独立空间内的实际文件。
 * 覆盖边界：覆盖核心采集、复制、只读和漂移；不覆盖宿主协议渲染。
 * 外部前置：仅隔离的合成临时目录，无 Git 和网络依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../../lib/core/service.js';
import { createProjectReader } from '../../lib/core/project-reader.js';

const actor = { kind:'human',via:'test' };
const command = (s,id,op,args) => s.command(id,{op,cmdId:randomUUID(),actor,...args});
const ledger = root => fs.readFileSync(path.join(root,'.projectboard','state','commits.jsonl'));

// 责任：验证实际文件、历史版本和连续复制后的读取归属。
test('authorized capture keeps bytes and versions apart from current file; copied space never falls back', async t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'p2-retained-')));
  const a=path.join(base,'A'),b=path.join(base,'B'); fs.mkdirSync(a);
  const file=path.join(a,'decision.md'),initial='\uFEFF以 A 为准\r\n'; fs.writeFileSync(file,initial);
  const service=await new ProjectService({spaceRoot:a}).init();
  t.after(()=>service.close());
  const id=(await service.createProject({workspacePath:a,actor})).id;
  const reg=await command(service,id,'doc.external.register',{title:'决策',kind:'decision',relPath:'decision.md'});
  const docId=reg.docId;
  const reader=createProjectReader(service); t.after(()=>reader.close());
  const capture=()=>command(service,id,'doc.workspace_capture',{docId});
  const query=(view,extra={})=>reader.query(id,view,{docId,...extra},actor);
  await assert.rejects(command(service,id,'doc.external.register',{title:'dup',relPath:'decision.md'}),{code:'locator-already-registered'});
  await assert.rejects(command(service,id,'doc.workspace_capture',{docId,body:'not a file editor'}),{code:'invalid-command'});
  const noRef=await query('workspace_compare',{versionId:'not-retained'});
  assert.equal(noRef.state,'unavailable'); assert.equal(noRef.reason,'version-not-retained');
  const first=(await capture()).versionRef.versionId, before=ledger(a);
  assert.equal((await capture()).versionRef.versionId,first); assert.deepEqual(ledger(a),before);
  assert.equal(fs.readFileSync(file,'utf8'),initial);
  fs.writeFileSync(file,'B\n');
  assert.equal((await query('workspace_compare',{versionId:first})).state,'changed');
  assert.deepEqual(ledger(a),before);
  const second=(await capture()).versionRef.versionId;
  fs.writeFileSync(file,initial);
  assert.equal((await query('workspace_compare',{versionId:first})).state,'unchanged');
  assert.equal((await query('workspace_version',{versionId:second})).body,'B\n');
  const third=(await capture()).versionRef.versionId; assert.notEqual(first,third);
  await reader.close(); await service.close(); fs.cpSync(a,b,{recursive:true});
  const copy=await new ProjectService({spaceRoot:b}).init(); const cold=createProjectReader(copy); t.after(async()=>{await cold.close();await copy.close();});
  fs.renameSync(path.join(b,'decision.md'),path.join(b,'decision-preserved.md'));
  const log=ledger(b); const absent=await cold.query(id,'workspace_compare',{docId,versionId:first},actor);
  assert.equal(absent.state,'unavailable'); assert.equal(absent.reason,'file-missing');
  assert.equal((await cold.query(id,'workspace_version',{docId,versionId:first},actor)).body,initial);
  const page=await cold.query(id,'workspace_history',{docId,limit:2},actor);
  assert.equal(page.versions.length,2); assert.equal(page.versions[0].versionRef.versionId,third);
  assert.equal((await cold.query(id,'workspace_history',{docId,limit:2,after:page.nextCursor},actor)).versions[0].versionRef.versionId,first);
  assert.deepEqual(ledger(b),log); assert.equal(fs.existsSync(path.join(b,'decision.md')),false);
  // A registration first made in a copy remains meaningful in a subsequent copy.
  fs.writeFileSync(path.join(b,'new-in-b.txt'),'B-only');
  fs.mkdirSync(path.join(b,'decision.md')); // Formerly registered file is now an unrelated directory.
  fs.writeFileSync(path.join(b,'prior-single.txt'),'old registration');
  await command(copy,id,'doc.external.register',{title:'prior',relPath:'prior-single.txt'});
  fs.linkSync(path.join(b,'prior-single.txt'),path.join(b,'prior-alias.txt'));
  const inB=(await command(copy,id,'doc.external.register',{title:'new in B',relPath:'new-in-b.txt'})).docId;
  const captured=(await command(copy,id,'doc.workspace_capture',{docId:inB})).versionRef.versionId;
  await cold.close(); await copy.close();
  const c=path.join(base,'C'); fs.cpSync(b,c,{recursive:true}); fs.writeFileSync(path.join(c,'new-in-b.txt'),'C-only');
  const last=await new ProjectService({spaceRoot:c}).init(); const lastReader=createProjectReader(last);
  try {
    assert.equal((await lastReader.query(id,'workspace_version',{docId:inB,versionId:captured},actor)).body,'B-only');
    assert.equal((await lastReader.query(id,'workspace_compare',{docId:inB,versionId:captured},actor)).state,'changed');
    assert.notEqual((await command(last,id,'doc.workspace_capture',{docId:inB})).versionRef.versionId,captured);
  } finally { await lastReader.close(); await last.close(); }
});

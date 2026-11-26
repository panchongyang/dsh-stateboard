/**
 * 测试职责：把合成历史写成真实 JSONL，并在写入前后关闭/重开 writer。
 * 典型流程：构造 makeCommit → 关闭 service → 追加一行 → 新 service 冷开回放。
 * 边界：只写测试临时目录；不触碰已发布的冻结 state，不调用生产测试口。
 */
import fs from 'node:fs';
import { ProjectService } from '../../lib/core/service.js';

/** Append one already-validated commit after the writer is closed, then replay it. */
export async function appendCommitAndReopen(service, { rootDir, projectId, commitsFile, commit, serviceOptions = {} }) {
  await service.close();
  fs.appendFileSync(commitsFile, JSON.stringify(commit) + '\n');
  const next = new ProjectService({ rootDir, ...serviceOptions });
  await next.init();
  const handle = await next.open(projectId);
  return { svc: next, h: handle };
}

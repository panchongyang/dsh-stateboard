// 子进程只从显式安装位置载入候选；不借用父进程的模块、writer、profile 或预期投影。
async function installed() {
  const [module, root, op, text] = process.argv.slice(2);
  const { ProjectService } = await import(module);
  const service = new ProjectService({ spaceRoot: root, privilegedInlineWrites: op === 'seed' });
  try {
    await service.init();
    const id = service.resolveWorkspace(root)?.projectId;
    if (op === 'empty') return { id: id ?? null, projects: (await service.listProjectsAsync()).length };
    const { randomUUID } = await import('node:crypto');
    const cmd = (op, args) => ({ op, ...args, actor: { kind: 'human' }, cmdId: randomUUID() });
    if (op === 'seed') {
      const handle = await service.createProject({ workspacePath: root, name: '备份验收' });
      const plan = await handle.command(cmd('plan.publish', { title: '连接表', steps: [{ id: 's1', title: '实现', tasks: [
        { key: 'A', title: '保存的任务', acceptance: [{ text: '核对持久化' }] }] }] }));
      const planId = plan.events.find(e => e.type === 'plan/published').data.id;
      const taskId = Object.values(handle.state.tasks).find(t => t.title === '保存的任务').id;
      const doc = await handle.command(cmd('doc.put', { title: '说明', kind: 'note', body: '第一版\n字段甲', links: { taskIds: [taskId], planRefs: [{ planId, version: 1 }] } }));
      const docId = doc.events.find(e => e.type.startsWith('doc/') && e.data?.id).data.id;
      await handle.command(cmd('doc.put', { docId, baseRev: 1, title: '说明', kind: 'note', body: '第二版\n字段乙', links: { taskIds: [taskId], planRefs: [{ planId, version: 1 }] } }));
      return { id: handle.id, planId, taskId, docId };
    }
    if (op === 'advance') return (await service.command(id, cmd('task.create', { title: '备份之后', acceptance: [{ text: '不倒灌' }] }))).committed;
    const { planId, taskId, docId } = JSON.parse(text);
    const { doc, body } = await service.query(id, 'doc', { docId });
    const plan = await service.query(id, 'plan', { planId }), task = await service.query(id, 'task', { taskId });
    return { id, body, docRev: doc.rev, links: doc.links, plan: plan.head.steps[0].taskIds, belongs: task.task.planRef };
  } finally { await service.close(); }
}

process.stdout.write(JSON.stringify(await installed()));

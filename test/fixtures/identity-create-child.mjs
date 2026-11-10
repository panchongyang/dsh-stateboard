// @ts-check
// Child for identity-conflicts.test.mjs: one createProject on a shared root.
const [serviceUrl, rootDir, workspacePath] = process.argv.slice(2);
const { ProjectService } = await import(serviceUrl);
const svc = new ProjectService({ rootDir });
await svc.init();
try {
  const handle = await svc.createProject({ workspacePath });
  console.log(JSON.stringify({ ok: true, projectId: handle.id }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code || 'error', message: error.message }));
} finally {
  await svc.close();
}

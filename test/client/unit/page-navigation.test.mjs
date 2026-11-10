/**
 * 测试职责：保证项目导航保留未确认丢弃的嵌套草稿，并隔离迟到写完成回调。
 * 典型流程：轻量真实 bundle hook runner 配 fake transport → 草稿编辑、跳转/取消和异步完成 → 比较实例和写次数。
 * 覆盖边界：覆盖 导航意图栅栏、草稿所有权与晚返回；不覆盖浏览器 DOM/视觉或真实网络。
 * 外部前置：无；需要仓库已生成客户端 bundle，React hooks 由本地 runner 模拟。
 */
// Navigation/completion regressions: real shipped nested components + fake transport, no DOM/browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createProjectNavigation } from '../../../src/client/model/project-location.ts';

function rig() {
  const slots = [], instances = new Map(), requests = [], timers = new Map();
  let current, cursor, dirty = true, effects = [], serial = 0, factory, seen;
  const equal = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const React = {
    createContext(value) { const context = { value }; context.Provider = { context }; return context; },
    useContext(context) { return context.value; },
    createElement(type, props, ...children) { return { type, key: props?.key, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }; },
    useState(seed) { const owner = current, n = cursor++; if (!owner.hooks[n]) owner.hooks[n] = { value: typeof seed === 'function' ? seed() : seed }; return [owner.hooks[n].value, v => { const next = typeof v === 'function' ? v(owner.hooks[n].value) : v; if (!Object.is(next, owner.hooks[n].value)) { owner.hooks[n].value = next; dirty = true; } }]; },
    useRef(value) { const n = cursor++; return current.hooks[n] ??= { current: value }; },
    useMemo(fn, deps) { const n = cursor++; if (!current.hooks[n] || !equal(current.hooks[n].deps, deps)) current.hooks[n] = { deps, value: fn() }; return current.hooks[n].value; },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const owner = current, n = cursor++; if (!owner.hooks[n] || !equal(owner.hooks[n].deps, deps)) effects.push(() => { owner.hooks[n]?.cleanup?.(); owner.hooks[n] = { deps, effect: fn, cleanup: fn() }; }); },
  };
  const win = new EventTarget(); win.__ModuleLoader__ = { load(v) { factory = v.factory; } }; win.confirm = () => false; win.location = { reload() { throw Error('unexpected reload'); } };
  const doc = new EventTarget(); doc.visibilityState = 'visible';
  const source = fs.readFileSync(new URL('../../../lib/client.js', import.meta.url), 'utf8');
  new Function('window', 'document', 'globalThis', 'require', 'fetch', 'setTimeout', 'clearTimeout', source)(win, doc, { __PROJECT_BOARD__: { base: '/api', token: 'fixed' } }, () => React, (url, init) => new Promise((resolve, reject) => { requests.push({ url, init, resolve: (v, status = 200) => resolve(new Response(JSON.stringify(v), { status })), reject }); }), (fn, ms) => { timers.set(++serial, { fn, ms }); return serial; }, id => timers.delete(id));
  factory(() => React).apply({ get: () => null, slots: { inject(_name, fn) { fn(); }, register(options, component) { slots.push({ options, component }); } } });
  const Page = slots.find(s => s.options.name === 'main').component;
  function cleanup(inst) { inst.hooks.forEach(h => h?.cleanup?.()); }
  function walk(element, position) {
    if (element == null || typeof element !== 'object') return;
    if (Array.isArray(element)) { element.forEach((e, i) => walk(e, position + '/' + (e?.key ?? i))); return; }
    if (element.type?.context) { const context = element.type.context, prior = context.value; context.value = element.props.value; walk(element.props.children, position + '/provider'); context.value = prior; return; }
    if (typeof element.type === 'function') {
      let inst = instances.get(position); if (inst && inst.type !== element.type) { cleanup(inst); instances.delete(position); inst = null; }
      if (!inst) { inst = { type: element.type, hooks: [], mount: ++serial }; instances.set(position, inst); }
      seen.add(position); inst.props = element.props; current = inst; cursor = 0; const output = element.type(element.props); inst.output = output; walk(output, position + '/out');
    } else walk(element.props?.children, position + '/children');
  }
  function render() { dirty = false; seen = new Set(); walk({ type: Page, props: {} }, 'root'); for (const [key, inst] of instances) if (!seen.has(key)) { cleanup(inst); instances.delete(key); } const tasks = effects; effects = []; tasks.forEach(f => f()); }
  async function settle() { for (let i = 0; i < 50; i++) { await Promise.resolve(); if (dirty) render(); } }
  const component = name => { const found = [...instances.values()].filter(i => i.type.name === name); assert.equal(found.length, 1, `component ${name}`); return found[0]; };
  return { requests, render, settle, component, win, doc, stop() { for (const i of instances.values()) cleanup(i); }, replay() { for (const i of instances.values()) cleanup(i); for (const i of instances.values()) for (const h of i.hooks) if (h.effect) h.cleanup = h.effect(); }, jump(cwd) { slots.find(s => s.options.name === 'conversation.session.header.utilities').options.inject().onOpen(cwd); } };
}
const projects = [{ id: 'p', name: 'P', workspacePath: 'D:\\work', inlineWritesDisabled: false }, { id: 'q', name: 'Q', workspacePath: 'D:\\other' }];
async function loaded() { const h = rig(); h.render(); await h.settle(); h.requests[0].resolve({ projects }); await h.settle(); h.component('AppLayout').props.onChoose('p'); await h.settle(); for (const r of h.requests.filter(r => r.url.includes('/p/'))) r.resolve(r.url.endsWith('/board') ? { project: projects[0], columns: {} } : { plans: [] }); await h.settle(); return h; }
const writes = h => h.requests.filter(r => r.init.method !== 'GET');
async function taskDraft(h) {
  h.component('AppLayout').props.onNewTask(); await h.settle();
  let drawer = h.component('NewTaskDrawer');
  drawer.output.props.children[0].props.children[1].props.onChange({ target: { value: 'R1 retained draft' } });
  drawer.output.props.children[0].props.children[2].props.onChange({ target: { value: 'acceptance' } }); await h.settle();
  drawer = h.component('NewTaskDrawer');
  return { mount: drawer.mount, submit: drawer.output.props.children[1].props.children[1].props.children[1].props.onClick };
}

// 责任：跳转待定或失败时任务草稿实例/内容须保留，旧 submit 回调不得写；取消导航后才恢复写。
for (const cwd of ['D:\\other', 'D:\\missing', '']) test(`R1 nested task draft survives failed/in-flight jump (${cwd || 'unknown'}); old callback cannot write`, async t => {
  const h = await loaded(); t.after(h.stop); const draft = await taskDraft(h);
  const start = h.requests.length; h.component('AppLayout').props.onRefresh(); await h.settle();
  h.jump(cwd); draft.submit(); // Deliberately before any React rerender/effect.
  await h.settle(); assert.equal(writes(h).length, 0);
  let layout = h.component('AppLayout').props;
  assert.equal(layout.projectId, 'p'); assert.equal(layout.navigationPending, true); assert.match(layout.navigationMessage, /跳转目标/);
  for (const r of h.requests.slice(start)) r.reject(Error('offline')); await h.settle();
  assert.equal(h.component('NewTaskDrawer').mount, draft.mount);
  assert.equal(h.component('NewTaskDrawer').output.props.children[0].props.children[1].props.value, 'R1 retained draft');
  draft.submit(); await h.settle(); assert.equal(writes(h).length, 0);
  layout = h.component('AppLayout').props; layout.onCancelNavigation(); await h.settle();
  assert.equal(h.component('NewTaskDrawer').mount, draft.mount);
  draft.submit(); await h.settle(); assert.equal(writes(h).length, 1); assert.equal(writes(h)[0].url, '/api/projects/p/commands');
  writes(h)[0].resolve({ ok: false, error: { code: 'test-stop' } }, 400); await h.settle();
});

// 责任：匹配目标也须等丢草稿确认，新导航/手动选择必须使旧接受回调及旧写回调失效。
test('R1 matched target waits for explicit draft-loss confirmation; latest/manual choices fence late results', async t => {
  const h = await loaded(); t.after(h.stop); const draft = await taskDraft(h);
  h.jump('D:\\other'); await h.settle(); h.component('AppLayout').props.onAcceptNavigation(); await h.settle();
  assert.equal(h.component('NewTaskDrawer').mount, draft.mount); assert.equal(h.component('AppLayout').props.projectId, 'p');
  const oldAccept = h.component('AppLayout').props.onAcceptNavigation;
  h.jump('D:\\missing'); h.win.confirm = () => true; oldAccept(); await h.settle();
  assert.equal(h.component('AppLayout').props.projectId, 'p');
  h.component('AppLayout').props.onChoose('q'); await h.settle();
  draft.submit(); await h.settle(); assert.equal(writes(h).length, 0, 'captured callback cannot write former project after confirmation');
  const start = h.requests.length; h.component('AppLayout').props.onRefresh(); await h.settle();
  h.jump('D:\\work'); h.jump('D:\\other'); await h.settle();
  for (const r of h.requests.slice(start)) r.resolve(r.url.endsWith('/projects') ? { projects } : r.url.endsWith('/board') ? { project: projects[1], columns: {} } : { plans: [] });
  await h.settle(); assert.equal(h.component('AppLayout').props.projectId, 'q');
});

// 责任：文档登记草稿跳转时须保留且禁止旧 submit，取消导航后才能提交原内容。
test('R1 nested document registration retains draft; its submit is guarded and cancel restores it', async t => {
  const h = await loaded(); t.after(h.stop); h.component('AppLayout').props.onTab('docs'); await h.settle();
  for (const r of h.requests.filter(r => r.url.includes('/docs'))) r.resolve({ docs: [], schemaVersion: 1 }); await h.settle();
  h.component('DocsList').props.onRegister(); await h.settle(); const before = h.component('RegisterForm');
  const frame = before.output.props.children[1]; frame.props.children[0].props.onChange({ target: { value: 'retained doc' } });
  await h.settle();
  h.component('RegisterForm').output.props.children[1].props.children[4].props.onChange({ target: { value: 'docs/note.md' } }); await h.settle();
  const submit = h.component('RegisterForm').output.props.children[1].props.onSubmit;
  h.jump('D:\\other'); submit(); await h.settle(); assert.equal(writes(h).length, 0);
  assert.equal(h.component('RegisterForm').mount, before.mount);
  assert.equal(h.component('RegisterForm').output.props.children[1].props.children[0].props.value, 'retained doc');
  h.component('AppLayout').props.onCancelNavigation(); await h.settle(); submit(); await h.settle();
  assert.equal(writes(h).length, 1); assert.match(writes(h)[0].url, /\/docs\/external$/);
});

// 责任：计划 composer 跳转期间保留草稿但不得创建，取消导航后恢复原提交能力。
test('R1 nested plan composer retains its draft and cannot create until navigation is cancelled', async t => {
  const h = await loaded(); t.after(h.stop); h.component('AppLayout').props.onTab('plan'); await h.settle();
  h.requests.at(-1).resolve({ plans: [] }); await h.settle();
  h.component('PlansView').props.onStartCreate(); h.component('PlansView').props.onTitle('retained plan'); await h.settle();
  const before = h.component('PlanPane'), submit = h.component('PlansView').props.onSubmitCreate;
  h.jump('D:\\other'); submit(); await h.settle();
  assert.equal(writes(h).length, 0); assert.equal(h.component('PlanPane').mount, before.mount);
  assert.equal(h.component('PlansView').props.createTitle, 'retained plan');
  h.component('AppLayout').props.onCancelNavigation(); await h.settle(); submit(); await h.settle();
  assert.equal(writes(h).length, 1); assert.equal(JSON.parse(writes(h)[0].init.body).op, 'plan.create');
});

// 责任：导航新意图到来时已发出的写不能 abort 或重放，避免重复创建。
test('an already sent write is not aborted or replayed when a new intent arrives', async t => {
  const h = await loaded(); t.after(h.stop); const draft = await taskDraft(h);
  draft.submit(); await h.settle(); const sent = writes(h)[0]; assert.ok(sent);
  h.jump('D:\\other'); await h.settle(); assert.equal(sent.init.signal.aborted, false);
  sent.resolve({ ok: true, result: { events: [] } }); await h.settle();
  assert.equal(writes(h).length, 1); assert.equal(h.component('AppLayout').props.projectId, 'p');
  assert.equal(h.component('AppLayout').props.navigationPending, true);
});

// 责任：导航 owner 须隔离不同页面并支持 effect 重放，过时身份不得接受结果。
test('navigation owners isolate pages, survive replay, and reject stale identities', () => {
  const a = createProjectNavigation(null), b = createProjectNavigation(null);
  a.start(); b.start(); a.choose('p'); b.choose('p'); a.jump('D:\\other', true);
  assert.throws(() => a.assertWritable('p', 1), /尚未确认/); assert.doesNotThrow(() => b.assertWritable('p', 1));
  a.stop(); a.start(); assert.throws(() => a.assertWritable('p', 1));
  const old = a.snapshot().intent; a.jump('D:\\missing', true);
  a.resolve({ ready: true, projects }, '', old); assert.equal(a.snapshot().intent.cwd, 'D:\\missing');
  a.cancel(); assert.doesNotThrow(() => a.assertWritable('p', 1)); a.choose('q'); assert.throws(() => a.assertWritable('p', 1));
  a.choose('p'); assert.throws(() => a.assertWritable('p', 1), 'returning to P does not revive an abandoned scope');
  a.stop(); assert.throws(() => a.assertWritable('p', 3)); assert.doesNotThrow(() => b.assertWritable('p', 1)); b.stop();
});

// Release a real nonempty creation event, not an empty success placeholder.
const createdResponse = { ok: true, result: { events: [{ type: 'task/created', data: { id: 'task-from-p' } }] } };
async function resolveProjectReads(h, id) {
  for (const r of h.requests.filter(r => r.init.method === 'GET' && r.url.includes('/' + id + '/'))) {
    r.resolve(r.url.endsWith('/board') ? { project: projects.find(p => p.id === id), columns: {} } : { plans: [] });
  }
  await h.settle();
}
async function pendingTaskCreate(h) {
  const draft = await taskDraft(h); draft.submit(); await h.settle();
  assert.equal(writes(h).length, 1);
  const sent = writes(h)[0];
  assert.equal(sent.url, '/api/projects/p/commands');
  assert.equal(JSON.parse(sent.init.body).op, 'task.create');
  assert.equal(sent.init.signal.aborted, false);
  return { draft, sent };
}

// 责任：任务创建晚完成遇手动/确认跳转、P-Q-P 或关闭重开时，不得覆盖更新编辑器。
for (const route of ['manual', 'confirmed-jump', 'P-Q-P', 'close-reopen']) test(`R2 late task.create completion cannot replace a newer editor (${route})`, async t => {
  const h = await loaded(); t.after(h.stop); const { draft, sent } = await pendingTaskCreate(h);
  let selected = 'q';
  if (route === 'close-reopen') {
    h.component('NewTaskDrawer').props.onClose(); await h.settle(); selected = 'p';
  } else {
    if (route === 'confirmed-jump') {
      h.jump('D:\\other'); await h.settle(); h.win.confirm = () => true;
      h.component('AppLayout').props.onAcceptNavigation(); await h.settle();
    } else { h.component('AppLayout').props.onChoose('q'); await h.settle(); }
    await resolveProjectReads(h, 'q');
    if (route === 'P-Q-P') {
      h.component('AppLayout').props.onChoose('p'); await h.settle();
      await resolveProjectReads(h, 'p'); selected = 'p';
    }
  }
  await taskDraft(h);
  h.component('NewTaskDrawer').output.props.children[0].props.children[1].props.onChange({ target: { value: selected.toUpperCase() + ' NEW UNSAVED DRAFT' } });
  await h.settle();
  const replacement = h.component('NewTaskDrawer');
  assert.notEqual(replacement.mount, draft.mount, 'new editor must actually be a different mounted instance');
  assert.equal(replacement.output.props.children[0].props.children[1].props.value, selected.toUpperCase() + ' NEW UNSAVED DRAFT');
  const requestsBeforeCompletion = h.requests.length;
  sent.resolve(createdResponse); await h.settle();
  assert.equal(h.component('AppLayout').props.projectId, selected);
  assert.equal(h.component('NewTaskDrawer').mount, replacement.mount);
  assert.equal(h.component('NewTaskDrawer').output.props.children[0].props.children[1].props.value, selected.toUpperCase() + ' NEW UNSAVED DRAFT');
  assert.equal(h.component('NewTaskDrawer').output.props.children[0].props.children[2].props.value, 'acceptance');
  assert.equal(h.requests.length, requestsBeforeCompletion, 'abandoned completion must not select or fetch the old task');
  assert.equal(writes(h).length, 1); assert.equal(sent.init.signal.aborted, false);
});

// 责任：原编辑器在未换身份的刷新、待定/取消导航和 effect 重放后，仍须处理自己的成功结果。
for (const boundary of ['unchanged', 'ordinary-refresh', 'pending', 'cancelled', 'effect-replay']) test(`R2 original editor still handles its successful completion (${boundary})`, async t => {
  const h = await loaded(); t.after(h.stop); const { draft, sent } = await pendingTaskCreate(h);
  if (boundary === 'ordinary-refresh') {
    h.component('AppLayout').props.onRefresh(); await h.settle();
    for (const r of h.requests.filter(r => r.init.method === 'GET' && r.url.endsWith('/projects'))) r.resolve({ projects });
    await resolveProjectReads(h, 'p');
  }
  if (boundary === 'pending' || boundary === 'cancelled') {
    h.jump('D:\\other'); await h.settle();
    if (boundary === 'cancelled') { h.component('AppLayout').props.onCancelNavigation(); await h.settle(); }
  }
  if (boundary === 'effect-replay') { h.replay(); await h.settle(); }
  assert.equal(h.component('NewTaskDrawer').mount, draft.mount, 'original editing scope remains mounted');
  sent.resolve(createdResponse); await h.settle();
  const layout = h.component('AppLayout').props;
  assert.equal(layout.projectId, 'p');
  assert.equal(layout.drawer, null, 'normal completion closes its own original editor');
  assert.ok(h.requests.filter(r => r.init.method === 'GET' && r.url === '/api/projects/p/board').length > 1, 'normal completion refreshes the original project');
  assert.equal(layout.navigationPending, boundary === 'pending');
  assert.equal(writes(h).length, 1); assert.equal(sent.init.signal.aborted, false);
});

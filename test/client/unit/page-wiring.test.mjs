/**
 * 测试职责：在真实出货页面接线中验证加载/失败、项目身份与认证恢复不会误清草稿。
 * 典型流程：轻量 hook runner 执行 bundle → 手控项目列表/board 响应和会话事件 → 检查组件类型与请求。
 * 覆盖边界：覆盖 真实 page/hook 接线与迟到 scope 栅栏；不覆盖 DOM 渲染、浏览器探针或视觉。
 * 外部前置：无；读取仓库已生成客户端产物，fetch/React 使用本地替身。
 */
// Executes the shipped page/hook wiring with a small hook runner. No browser,
// DOM renderer or network probe; deferred responses exercise real async paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function harness(href = 'http://localhost/') {
  const slots = [], hooks = [], effects = [], calls = [], timers = new Map();
  let cursor = 0, dirty = false, id = 0, captured, tree;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, n) => Object.is(v, b[n]));
  const React = {
    createContext(value) { return { value, Provider: 'context-provider' }; },
    useContext(context) { return context.value; },
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(initial) {
      const n = cursor++; if (!hooks[n]) hooks[n] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[n].value, value => { const next = typeof value === 'function' ? value(hooks[n].value) : value; if (!Object.is(next, hooks[n].value)) { hooks[n].value = next; dirty = true; } }];
    },
    useRef(value) { const n = cursor++; if (!hooks[n]) hooks[n] = { current: value }; return hooks[n]; },
    useMemo(fn, deps) { const n = cursor++; if (!hooks[n] || !same(hooks[n].deps, deps)) hooks[n] = { deps, value: fn() }; return hooks[n].value; },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const n = cursor++; if (!hooks[n] || !same(hooks[n].deps, deps)) effects.push(() => { hooks[n]?.cleanup?.(); hooks[n] = { deps, effect: fn, cleanup: fn() }; }); },
  };
  const win = new EventTarget();
  win.__ModuleLoader__ = { load(value) { captured = value; } };
  win.confirm = () => false;
  const location = new URL(href);
  location.reload = () => { throw new Error('unexpected navigation'); };
  win.location = location;
  win.history = { replaceState(_state, _title, url) { location.href = String(url); } };
  const doc = new EventTarget(); doc.visibilityState = 'visible';
  const fakeFetch = (url, init) => new Promise((resolve, reject) => { calls.push({ url, init, resolve: (value, status = 200) => resolve(new Response(JSON.stringify(value), { status })), reject }); });
  const source = fs.readFileSync(new URL('../../../lib/client.js', import.meta.url), 'utf8');
  const require = name => { assert.equal(name, 'react'); return React; };
  new Function('window', 'document', 'globalThis', 'require', 'fetch', 'setTimeout', 'clearTimeout', source)(
    win, doc, { __PROJECT_BOARD__: { base: '/project-board/api', token: 'page' } }, require, fakeFetch,
    (fn, ms) => { const key = ++id; timers.set(key, { fn, ms }); return key; }, key => timers.delete(key),
  );
  const entry = captured.factory(require);
  let sessionListener; let snapshot = { byId: {} };
  const selectedPanels = [];
  entry.apply({
    get: name => name === 'sessions' ? { list: { getSnapshot: () => snapshot, subscribe(fn) { sessionListener = fn; return () => { sessionListener = null; }; } } } : null,
    slots: { inject(_name, fn) { fn(); }, register(options, component) { slots.push({ options, component }); } },
    layout: { selectPanel(id) { assert.ok(slots.some(({ options }) => options.key === id)); selectedPanels.push(id); } },
  });
  const Page = slots.find(s => s.options.name === 'main').component;
  function render() { cursor = 0; dirty = false; tree = Page().children[0]; while (effects.length) effects.shift()(); return tree; }
  async function settle() { for (let n = 0; n < 30; n++) { await Promise.resolve(); if (dirty) render(); } return tree; }
  function stop() { hooks.forEach(h => h.cleanup?.()); }
  return { render, settle, stop, calls, timers, win, doc, entry, selectedPanels, tree: () => tree,
    session(value) { snapshot = value; sessionListener?.(); },
    jump(cwd) { slots.find(s => s.options.name === 'conversation.session.header.utilities').options.inject().onOpen(cwd); },
    replay() { hooks.forEach(h => h.cleanup?.()); hooks.forEach(h => { if (h.effect) h.cleanup = h.effect(); }); },
    content() { const element = tree.props.children; return element.type(element.props); },
  };
}

const projects = [{ id: 'p', name: 'P', workspacePath: 'D:\\work' }, { id: 'other', name: 'Other', workspacePath: 'D:\\other' }];

// 责任：直达链接等待项目身份确认，历史变化保留已挂编辑页。
test('direct Flow opens the registered panel and validates the linked project before loading', async (t) => {
  const h = harness('http://localhost/?view=flow&project=other#focus=tsk_sample');
  t.after(h.stop);
  assert.deepEqual(h.selectedPanels, ['project-board']);
  h.render();
  await h.settle();
  assert.equal(h.tree().props.projectId, '');
  h.calls[0].resolve({ projects });
  await h.settle();
  assert.equal(h.tree().props.projectId, 'other');
  h.calls.find(({ url }) => url.endsWith('/other/board')).resolve({ project: projects[1], columns: {} });
  await h.settle();
  assert.equal(h.content().type.name, 'FlowBoard');
  assert.equal(h.content().props.focus, 'tsk_sample');
  h.tree().props.onTab('plan');
  h.win.dispatchEvent(new Event('hashchange'));
  await h.settle();
  assert.equal(h.content().type.name, 'PlanPane', 'history events must preserve a mounted editor');
  h.tree().props.onChoose('p');
  await h.settle();
  assert.equal(h.win.location.hash, '');
  assert.equal(h.win.location.searchParams.get('project'), 'p');
});

// 责任：实际页面慢/失败列表须显示 Loading/Error 且不自动建项目，成功后仅按 main cwd 定位。
test('actual page waits on slow/failed lists, never mounts create automatically, then locates main cwd', async t => {
  const h = harness(); t.after(h.stop); h.render(); await h.settle();
  assert.equal(h.content().type.name, 'LoadingState'); assert.equal(h.tree().props.projectId, '');
  h.calls[0].reject(new Error('offline')); await h.settle();
  assert.equal(h.content().type.name, 'ErrorState'); assert.equal(h.tree().props.projectId, '');
  h.session({ byId: { selected: { cwd: 'D:\\work', retainedBy: { mainView: 1 } } } });
  h.tree().props.onRefresh(); await h.settle();
  h.calls[1].resolve({ projects }); await h.settle();
  assert.equal(h.tree().props.projectId, 'p');
  assert.equal(h.calls.filter(c => c.url.endsWith('/board')).length, 1);
  h.tree().props.onView('list'); await h.settle(); assert.equal(h.content().type.name, 'LoadingState');
  h.calls.find(c => c.url.endsWith('/board')).reject(new Error('board offline'));
  await h.settle(); assert.equal(h.content().type.name, 'ErrorState', 'list view must not turn a failed read into empty tasks');
});

// 责任：未知上下文成功空列表须显示可选择空态而非创建表单，普通刷新须合并请求。
test('unknown context stays selectable; successful empty list is not a creation form', async t => {
  const h = harness(); t.after(h.stop); h.render(); await h.settle(); h.calls[0].resolve({ projects: [] }); await h.settle();
  assert.equal(h.content().type.name, 'EmptyState'); assert.equal(h.tree().props.projectId, '');
  h.tree().props.onRefresh(); h.tree().props.onRefresh(); await h.settle();
  assert.equal(h.calls.length, 2, 'ordinary manual refreshes share one flight');
  h.calls[1].resolve({ projects }); await h.settle();
  assert.equal(h.tree().props.projectId, '', 'first project is not an identity source');
  h.tree().props.onChoose('other'); await h.settle(); assert.equal(h.tree().props.projectId, 'other');
});

// 责任：显式跳转须压过旧身份，未匹配或未知 cwd 只能空态，不能自动创建。
test('explicit jumps override stale identity but unmatched/unknown jumps never auto-create', async t => {
  const h = harness(); t.after(h.stop); h.render(); await h.settle(); h.calls[0].resolve({ projects }); await h.settle();
  h.tree().props.onChoose('p'); await h.settle();
  h.jump('D:\\missing'); await h.settle();
  assert.equal(h.tree().props.projectId, ''); assert.equal(h.content().type.name, 'EmptyState');
  assert.match(h.tree().props.locationMessage, /未匹配/);
  h.jump('D:\\other'); await h.settle(); assert.equal(h.tree().props.projectId, 'other');
  h.jump(''); await h.settle(); assert.equal(h.tree().props.projectId, ''); assert.equal(h.content().type.name, 'EmptyState');
});

// 责任：认证 mismatch 或成功空刷新须保留已挂文档/计划身份，取消恢复刷新不得丢草稿。
test('refresh mismatch/empty success preserves mounted doc/plan identity and cancels page reload safely', async t => {
  const h = harness(); t.after(h.stop); h.render(); await h.settle(); h.calls[0].resolve({ projects }); await h.settle();
  h.tree().props.onChoose('p'); await h.settle();
  h.calls.find(c => c.url.endsWith('/board')).resolve({ project: projects[0], columns: {} });
  h.calls.find(c => c.url.endsWith('/plans')).resolve({ plans: [] }); await h.settle();
  for (const tab of ['docs', 'plan']) {
    h.tree().props.onTab(tab); await h.settle(); const before = h.content();
    const start = h.calls.length; h.tree().props.onRefresh(); await h.settle();
    for (const call of h.calls.slice(start)) call.resolve({ ok: false, error: { code: 'token-mismatch' } }, 403);
    await h.settle(); const after = h.content();
    assert.equal(after.type, before.type); assert.equal(after.props.key, before.props.key);
    assert.equal(h.tree().props.access.code, 'token-mismatch');
    h.tree().props.onRecoverAccess(); await h.settle(); assert.equal(h.content().type, before.type); assert.equal(h.tree().props.projectId, 'p');
  }
  const start = h.calls.length; h.tree().props.onRefresh(); await h.settle();
  for (const call of h.calls.slice(start)) call.resolve(call.url.endsWith('/projects') ? { projects: [] } : call.url.endsWith('/plans') ? { plans: [] } : { project: projects[0], columns: {} });
  await h.settle(); assert.equal(h.tree().props.projectId, 'p'); assert.match(h.tree().props.locationMessage, /已不在列表/);
  assert.equal(h.content().type.name, 'PlanPane');
});

// 责任：真实 hook effect cleanup/setup 后须恢复新读取，旧 scope 晚响应不能替换已选看板。
test('actual hook effect replay resumes and late old scope cannot replace selected board', async t => {
  const h = harness(); t.after(h.stop); h.render(); await h.settle();
  h.replay(); await h.settle(); assert.equal(h.calls.length, 2); assert.equal(h.calls[0].init.signal.aborted, true);
  h.calls[0].resolve({ projects: [{ id: 'stale' }] }); h.calls[1].resolve({ projects }); await h.settle();
  assert.deepEqual(h.tree().props.projects, projects);
  h.tree().props.onChoose('p'); await h.settle(); const a = h.calls.filter(c => c.url.includes('/p/'));
  h.tree().props.onChoose('other'); await h.settle(); const b = h.calls.filter(c => c.url.includes('/other/'));
  for (const call of b) call.resolve(call.url.endsWith('/board') ? { project: projects[1], columns: {} } : { plans: [] });
  await h.settle(); for (const call of a) call.resolve(call.url.endsWith('/board') ? { project: projects[0], columns: {} } : { plans: [] });
  await h.settle(); assert.equal(h.tree().props.project.id, 'other');
  h.stop(); assert.equal(h.timers.size, 0);
});

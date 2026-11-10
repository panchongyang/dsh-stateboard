/**
 * 测试职责：提供无测试注册的独立 bundle、React 替身及合成数据。
 * 典型流程：读取真实 bundle → 构造独立 React/hook 替身 → 返回逐例重建的模块与合成数据。
 * 覆盖边界：覆盖 出货产物的离线契约；不覆盖真实 DOM、浏览器视觉、网络或宿主会话。
 * 外部前置：需要仓库现有客户端构建产物；不启动浏览器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadClientBundle() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '../..', 'lib', 'client.js'), 'utf8');
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(options) { captured = options; },
    },
  };

  const React = {
    createContext(value) { return { value, Provider: 'context-provider' }; },
    useContext(context) { return context.value; },
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, function () {}]; },
    useEffect() {},
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); },
    useRef(value) { return { current: value === undefined ? null : value }; },
  };
  const requireStub = (name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
  };

  new Function('window', 'require', source)(fakeWindow, requireStub);
  const exportsValue = captured?.factory(requireStub);
  return { here, source, captured, requireStub, exportsValue };
}

export function flattenTree(node, out) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  (node.children || []).forEach(function (child) {
    if (Array.isArray(child)) child.forEach(function (item) { flattenTree(item, out); });
    else flattenTree(child, out);
  });
  return out;
}
export function nodeText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('|');
  return nodeText(node.children || []);
}

export function cardsFixture() {
  const cards = [
    { id: 'tsk_a', title: '回调路由', state: 'ready', labels: ['ui'], acceptance: { met: 0, total: 2 }, evidenceCount: 0 },
    { id: 'tsk_b', title: '补 401 测试', state: 'in_progress', labels: ['gate:audit'], acceptance: { met: 1, total: 2 }, evidenceCount: 3, owner: { sessionId: 'session-abcdef123456' } },
    { id: 'tsk_c', title: '文档排版', state: 'review', requiresAudit: true, acceptance: { met: 2, total: 2 }, evidenceCount: 1 },
    { id: 'tsk_d', title: '崩溃对账', state: 'done', blocked: { code: 'external-dependency', note: '等上游' } },
  ];
  return cards;
}

export function editFixture(t) {
  const editForm = {
    steps: [{ key: 's_1', id: 's1', title: '核心', tasks: [
      { key: 't_1', taskId: 'tsk_a', title: '状态机', description: 'd', priority: '200', weight: '2', deps: '', acceptance: '', labels: 'core', requiresAudit: true },
      { key: 't_2', taskId: '', title: '新任务', description: '', priority: '', weight: '', deps: '', acceptance: '验收一\n验收二', labels: '', requiresAudit: false },
    ] }],
  };
  const editParsed = t.planEditSteps(editForm);
  return { editForm, editParsed };
}

export function tableFixture() {
  const TICK = '\u0060';
  const tableBody = [
    '| 名称 | 数量 | 备注 |',
    '| :--- | ---: | :---: |',
    '| **a** | 12 | ' + TICK + 'x' + TICK + ' |',
    '| a \\| b | 3 |  |',
  ].join('\n');
  return tableBody;
}

export function multiSummariesFixture() {
  const multiSummaries = [
    { id: 'p_arch_new', title: '归档计划', status: 'archived', updatedAt: '2026-10-26T10:00:00Z', focus: false },
    { id: 'p_draft', title: '草稿计划', status: 'draft', updatedAt: '2026-10-25T10:00:00Z', focus: false },
    { id: 'p_act_old', title: '旧计划', status: 'active', updatedAt: '2026-10-24T10:00:00Z', focus: false },
    { id: 'p_act_new', title: '演示计划', status: 'active', updatedAt: '2026-10-26T09:00:00Z', focus: true },
  ];
  return multiSummaries;
}

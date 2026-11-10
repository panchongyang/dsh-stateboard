// 状态、操作和证据的展示词汇表：只翻译已有结果，不把观测提升为正确性结论。
import type { Actor, Evidence, Plan, CommandResult, ApiError } from './types.ts';

export const STATE_LABELS: Record<string, string> = {
  backlog: '待办', ready: '就绪', in_progress: '进行中', review: '评审中',
  done: '已完成', blocked: '阻塞', canceled: '已取消', interrupted: '待对账',
};
export const STATE_ORDER = ['backlog', 'ready', 'in_progress', 'review', 'done'];
export const STATE_TONE: Record<string, string> = {
  backlog: 'muted', ready: 'accent', in_progress: 'warn', review: 'violet',
  done: 'success', blocked: 'danger', interrupted: 'warn', canceled: 'muted',
};
export const TAB_ITEMS = [
  { id: 'board', label: '看板' },
  { id: 'docs', label: '文档' },
  { id: 'plan', label: '计划' },
  { id: 'health', label: '健康' },
];

// 文档与证据使用不同词汇，不能以同一个展示标签推断协议类型。
export const DOC_KIND_LABELS: Record<string, string> = { spec: '规格', design: '设计', decision: '决策', note: '笔记', runbook: '运行手册' };
export const EVIDENCE_KIND_LABELS: Record<string, string> = { file: '文件', doc: '文档', command: '命令', test: '测试', note: '备注', url: '链接' };
export const EVIDENCE_KINDS = ['file', 'doc', 'command', 'test', 'note', 'url'];
export const EVIDENCE_PLACEHOLDER: Record<string, string> = {
  file: '相对工作区的路径，例如 lib/client.js',
  doc: 'docId@rev，例如 doc_mvh…@3',
  command: '执行的命令，例如 node test/client-smoke.mjs',
  test: '测试名，例如 client-smoke',
  note: '一句说明',
  url: 'http(s) 链接',
};
export const PLAN_STATUS_LABELS: Record<string, string> = { draft: '草稿', published: '已发布', superseded: '已被替代', active: '进行中', archived: '已归档' };
export const PLAN_STATUS_TONE: Record<string, string> = { draft: 'accent', active: 'success', published: 'success', archived: 'muted', superseded: 'muted' };
export const RECONCILE_LABELS: Record<string, string> = { resume: '继续', completed: '已完成', discard: '放弃' };
export const ACTOR_LABELS: Record<string, string> = { agent: '代理', human: '人类', system: '系统' };
export const BLOCKER_LABELS: Record<string, string> = {
  'external-dependency': '外部依赖', 'waiting-human': '等待人类', 'missing-credential': '缺少凭据',
  'upstream-bug': '上游问题', unknown: '未知原因',
};
export const BLOCKER_CODES = ['external-dependency', 'waiting-human', 'missing-credential', 'upstream-bug', 'unknown'];

// 事件与操作保留独立映射；未知值透传，避免隐藏新版本结果。
export const EVENT_LABELS: Record<string, string> = {
  'task/created': '任务创建', 'task/updated': '任务更新', 'task/readied': '任务就绪', 'task/claimed': '任务领取',
  'task/released': '任务释放', 'task/submitted': '任务提交', 'task/verified': '任务通过', 'task/rejected': '任务驳回',
  'task/blocked': '任务阻塞', 'task/unblocked': '解除阻塞', 'task/interrupted': '任务待对账', 'task/reconciled': '任务对账',
  'task/canceled': '任务取消', 'task/reopened': '任务重开', 'task/orphaned': '任务脱离计划',
  'work/intent': '写入意图', 'work/result': '完成意图', 'work/abandoned': '放弃意图',
  'lease/granted': '授予租约', 'lease/revoked': '撤销租约', 'lease/expired': '租约过期',
  'session/bound': '绑定会话', 'session/detached': '解绑会话', 'session/checkpoint': '会话检查点', 'session/handoff': '会话交接',
  'doc/created': '创建文档', 'doc/updated': '更新文档', 'doc/drift': '文档漂移',
  'plan/published': '计划发布', 'plan/revised': '计划修订', 'plan/superseded': '计划被替代',
  'project/created': '创建项目', 'project/updated': '项目更新',
};
export const OP_LABELS: Record<string, string> = {
  claim: '领取', begin: '开始', submit: '提交', verify: '通过', reject: '驳回', block: '阻塞',
  unblock: '解除阻塞', release: '释放', reconcile: '对账', cancel: '取消', reopen: '重开',
  gate: '审计开关', update: '更新', ready: '置为就绪', override: '强制覆盖',
};

// 错误提示只解释现有错误码，不增加重试或降级副作用。
export const ERROR_HINTS: Record<string, string> = {
  'stale-revision': '版本已过期，请刷新后重试',
  'illegal-transition': '当前状态不允许这个操作',
  'lease-held': '其他会话持有租约',
  'lease-expired': '租约已过期：有未关闭的执行意图时请中断或对账，否则重新领取',
  'fencing-stale': '租约令牌过期，请重新读取并对账',
  'dependency-unmet': '依赖尚未完成',
  'acceptance-unmet': '验收项尚未全部满足',
  'missing-evidence': '缺少合格证据',
  'verification-required': '需要人类验收，或审计门的独立 AI 审计',
  'schema-migration-required': '项目需要维护者离线升级至 schema v3；请勿重复写入',
  'forbidden-role': '当前角色无权执行',
  'incompatible-event': '日志包含当前版本无法理解的新事件，已拒绝打开（需升级或恢复快照）',
  'project-inactive': '项目已暂停或归档',
  'not-found': '对象不存在',
  'read-only': '项目当前只读',
  'forbidden': '请求被拒绝，请检查访问权限或联系维护者',
  'token-mismatch': '页面凭据与当前插件实例不匹配；保留草稿后重新加载页面',
  'origin-rejected': '请求来源被拒绝，请从正确的宿主地址打开页面或联系维护者',
  'fetch-site-rejected': '跨站请求被拒绝，请从正确的宿主地址打开页面',
  'page-config-missing': '页面凭据未装配；请保留草稿后重新加载页面',
  'hash-chain-broken': '项目日志损坏，已进入只读',
  'invalid-command': '请求参数不合法',
  'plan-not-found': '计划不存在',
  'plan-title-taken': '计划标题已存在',
  'plan-archived': '计划已归档',
  'plan-not-draft': '只有草稿计划可以发布',
  'plan-not-active': '聚焦只对已发布计划生效',
  'plan-has-live-work': '计划里有进行中的任务或活跃租约，无法归档',
};
export const REASON_LABELS: Record<string, string> = {
  'task is not ready': '任务尚未就绪',
  'another session holds the lease': '其他会话持有租约',
  'you do not hold the lease': '你不是租约持有者',
  'the lease expired': '租约已过期',
  'an intent is already open': '已有未关闭的执行意图',
  'task is not in progress': '任务不在进行中',
  'task is not in review': '任务不在评审中',
  'task is not blocked': '任务未被阻塞',
  'task is not interrupted': '任务不在待对账状态',
  'task is not terminal': '任务不是终态',
  'terminal task': '任务已是终态',
  'only in_progress/review can be blocked': '只有进行中/评审中的任务可阻塞',
  'not backlog': '任务不在待办',
  'deps are not done': '依赖未完成',
  'human only': '仅人类可操作',
  'human/verifier only': '仅人类或验证者可操作',
  'human or lease owner only': '仅人类或租约持有者可操作',
  'only the lease owner or a human can cancel': '只有租约持有者或人类可以取消',
  'only a human can cancel a gated task': '已开启审计的任务只能由人类取消',
  'project is paused/archived': '项目已暂停或归档',
  'not available': '当前不可用',
  'not-audit-gate': '非门控任务需要人类验收；agent 不能在评审中开门',
  'not-independent': '参与过实现，请交给独立审计会话或人类',
  'worker-unknown': '实现者未知，请由人类验收',
  'human only in review or to disable a gate': '评审中改门、关闭审计门仅人类可操作',
  'review-gate-locked': '评审中的 agent 不能改审计门；可驳回返工或请人类处理',
  'gate-locked': '只有人类可以关闭审计门',
  'unassign-human-only': '仅人类可以清空委派人；驳回可保留委派',
  'drift-human-only': 'agent 不能刷新或豁免漂移；请驳回返工或交给人类',
};

// 未知审计身份不能显示成人类验收，代理报告始终标注自述。
export function auditActorLabel(audit: { by?: Actor }): string {
  const kind = audit && audit.by && audit.by.kind;
  return kind === 'agent' ? 'AI审计（自述）' : kind === 'human' ? '人类验收记录' : '审计记录（身份未知）';
}

export function stateLabel<T extends string | undefined>(value: T): string | T { return STATE_LABELS[value!] || value; }
export function docKindLabel<T extends string | undefined>(value: T): string | T { return DOC_KIND_LABELS[value!] || value; }
export function evidenceKindLabel<T extends string | undefined>(value: T): string | T { return EVIDENCE_KIND_LABELS[value!] || value; }
/** 只有列出的内容漂移可由人类验收豁免，命令执行失败不等于内容漂移。 */
export const DRIFT_WAIVER_LABELS: Record<string, string> = {
  'file-drift': '文件已变更',
  'doc-drift': '文档已变更',
  'file-missing': '文件缺失或不可读',
  'doc-missing': '文档缺失',
};
/** 证据指纹只说明记录过内容观测，不代表交付正确；命令与测试通常仍是提交者自报，除非带历史执行记录。无可诚实补充的信息时返回空。 */
export function evidenceObservation(evidence: Evidence): { label: string; tone: string } | null {
  if (!evidence || typeof evidence !== 'object') return null;
  if (evidence.kind === 'file' || evidence.kind === 'doc') {
    const reason = evidence.fixedState === 'current-only' ? evidence.fixedReason : null;
    if (reason === 'no-git' || reason === 'git-unavailable') return { label: 'Git 不可观测', tone: 'muted' };
    if (evidence.verifiedAt) return { label: '内容指纹已记录', tone: 'neutral' };
    return null;
  }
  if (evidence.kind === 'command' || evidence.kind === 'test') {
    return evidence.execution
      ? { label: '历史执行记录', tone: 'muted' }
      : { label: '提交者自报', tone: 'neutral' };
  }
  return null;
}
export function planStatusLabel<T extends string | undefined>(value: T): string | T { return PLAN_STATUS_LABELS[value!] || value; }
export function planStatusTone(value: string | undefined): string { return PLAN_STATUS_TONE[value!] || 'neutral'; }
/** 活动计划与草稿允许提供归档入口。 */
export function planCanArchive(summary: Plan | null | undefined): boolean { return Boolean(summary && (summary.status === 'active' || summary.status === 'draft')); }
/** 只有已归档计划提供恢复入口。 */
export function planCanUnarchive(summary: Plan | null | undefined): boolean { return Boolean(summary && summary.status === 'archived'); }
/** 只有未聚焦的活动计划提供聚焦入口。 */
export function planCanFocus(summary: Plan | null | undefined): boolean { return Boolean(summary && summary.status === 'active' && !summary.focus); }
/** 活动计划与草稿提供详情编辑入口。 */
export function planCanEdit(summary: Plan | null | undefined): boolean { return Boolean(summary && (summary.status === 'active' || summary.status === 'draft')); }
/** 按响应顺序从 plan/created 事件提取新草稿身份。 */
export function planCreatedId(result: CommandResult): string | null {
  const events = result && Array.isArray(result.events) ? result.events : [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event && event.type === 'plan/created' && event.data && event.data.id) return event.data.id;
  }
  return null;
}
/** 按响应顺序从 task/created 事件提取新任务身份。 */
export function taskCreatedId(result: CommandResult): string | null {
  const events = result && Array.isArray(result.events) ? result.events : [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event && event.type === 'task/created' && event.data && event.data.id) return event.data.id;
  }
  return null;
}
export function reasonText(reason: string | undefined): string { return REASON_LABELS[reason!] || reason || '当前不可用'; }
export function eventLabel<T extends string | undefined>(value: T): string | T { return EVENT_LABELS[value!] || value; }
export function actorLabel(value: string | undefined): string { return ACTOR_LABELS[value!] || value || '?'; }
export function blockerLabel<T extends string | undefined>(value: T): string | T { return BLOCKER_LABELS[value!] || value; }
export function stateTone(value: string | undefined): string { return STATE_TONE[value!] || 'muted'; }
export function opLabel(value: string): string { return OP_LABELS[value] || value; }
export function warningText(value: unknown): string {
  return String(value)
    .replace(/^doc-drift:/, '文档漂移:')
    .replace(/^lease expired:/, '租约过期:')
    .replace(/^task-verified:/, '任务未验证:')
    .replace(/^task-deps:/, '依赖未满足:')
    .replace(/^task-owner:/, '任务缺少持有者:')
    .replace(/^dependency-acyclic:/, '依赖成环:')
    .replace(/^doc-hash:/, '文档哈希:')
    .replace(/^doc-rev:/, '文档修订:')
    .replace(/^project-id:/, '项目 id:')
    .replace(/^project-phase:/, '项目状态:');
}
export function errorText(error: unknown): string {
  if (!error) return '请求失败';
  // HTTP 边界持有错误信封；空字段的真值回退规则保持一致，不改成仅判空。
  const hint = (error as ApiError).code && ERROR_HINTS[(error as ApiError).code!];
  if (hint) return hint + ' [' + (error as ApiError).code + ']';
  return ((error as ApiError).message || String(error)) + ((error as ApiError).code ? ' [' + (error as ApiError).code + ']' : '');
}

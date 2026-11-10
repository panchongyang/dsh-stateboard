// 外置文档的状态投影与写入守卫：管理、可用性、确认、Git 四个维度独立展示。
// 只依据已有观测判断，不读取工作区，也不把刷新或预览当成确认。
import type { Doc, DocView, Confirmation, GitObservation, ListSchema, DisplayLabel, AvailabilityLabel, PreviewState, FormMode, Actor } from './types.ts';

export const EXTERNAL_SCHEMA_VERSION = 1;

export const MANAGEMENT_LABELS: Record<string, string> = { draft: '草稿', in_review: '评审中', adopted: '已采纳', archived: '已归档' };
const MANAGEMENT_TONE: Record<string, string> = { draft: 'neutral', in_review: 'accent', adopted: 'success', archived: 'muted' };
export const MANAGEMENT_NEXT: Record<string, string[]> = {
  draft: ['in_review', 'archived'],
  in_review: ['adopted', 'draft', 'archived'],
  adopted: ['in_review', 'archived'],
  archived: ['draft'],
};

// 每个可用性值只描述已观测事实与可执行补救，不猜测文件失效原因。
export const AVAILABILITY_COPY: Record<string, AvailabilityLabel> = {
  readable: { label: '可读', tone: 'success', title: '', hint: '' },
  missing: {
    label: '路径不存在', tone: 'warn',
    title: '工作区里此刻没有这个路径',
    hint: '看板只知道该路径现在不存在，无法判断原因。在编辑器里恢复或创建该文件后点「重新读取文件」；若文件换了位置，用「重定位」指向新路径；不再需要就「解除登记」（不会删除任何文件）。',
  },
  root_unavailable: {
    label: '根目录不可达', tone: 'warn',
    title: '登记绑定的工作区根目录当前无法访问',
    hint: '根目录不存在或无法打开。确认该目录存在且本机可访问后点「重新读取文件」；若工作区换了位置，用「重定位」改到有效绑定。',
  },
  missing_binding: {
    label: '绑定失效', tone: 'warn',
    title: '登记的工作区绑定不是本项目当前有效的绑定',
    hint: '看板不会改用会话目录或其他工作区补读。用「重定位」把文档指向有效绑定；多个文档要一起换绑定时，由人类经命令接口执行 doc.external.rebind。',
  },
  permission_denied: {
    label: '无读取权限', tone: 'warn',
    title: '没有权限读取这个文件',
    hint: '调整文件或目录权限，让运行看板的进程可以读取，然后点「重新读取文件」。',
  },
  outside_root: {
    label: '越出工作区根', tone: 'danger',
    title: '路径解析到了绑定根目录之外',
    hint: '看板只读取绑定根目录内的文件。把文件放回根目录内，或用「重定位」指向根目录内的路径。',
  },
  security_rejected: {
    label: '安全拒绝', tone: 'danger',
    title: '路径被安全规则拒绝读取',
    hint: '路径经过符号链接、junction 或包含不允许的成分，首版不读取。用「重定位」指向一个普通路径。',
  },
  not_regular: {
    label: '不是普通文件', tone: 'warn',
    title: '该路径不是普通文件',
    hint: '路径指向目录、设备或其他特殊对象，看板不读取。用「重定位」指向一个普通文件。',
  },
  oversize: {
    label: '超过大小上限', tone: 'warn',
    title: '文件超过 16 MiB 读取上限',
    hint: '超限文件不读取正文、不计算完整 hash，因此不能预览也不能确认。拆分文件或重定位到较小的文件后点「重新读取文件」。',
  },
  unsupported_format: {
    label: '格式不可预览', tone: 'neutral',
    title: '这种格式不在此处预览',
    hint: '首版只预览 UTF-8 文本和 Markdown。文件已完整读取并计算了 hash，可以照常确认；正文请用相应的程序打开。',
  },
  undecodable: {
    label: '非法 UTF-8', tone: 'warn',
    title: '文件不是合法的 UTF-8 文本',
    hint: '看板不替换非法字节来凑出正文。用编辑器把文件另存为 UTF-8 后点「重新读取文件」。',
  },
  unstable: {
    label: '读取中变化', tone: 'warn',
    title: '读取期间文件一直在变化',
    hint: '两次读取之间文件被改写，本次没有返回正文和 hash。等写入结束后点「重新读取文件」。',
  },
};

const CODE_TO_AVAILABILITY: Record<string, string> = {
  'file-missing': 'missing', 'root-unavailable': 'root_unavailable', 'missing-binding': 'missing_binding',
  'permission-denied': 'permission_denied', 'outside-root': 'outside_root', 'security-rejected': 'security_rejected',
  'not-regular': 'not_regular', oversize: 'oversize', 'unsupported-format': 'unsupported_format',
  undecodable: 'undecodable', unstable: 'unstable',
};

export const CONFIRMATION_LABELS: Record<string, DisplayLabel> = {
  unconfirmed: { label: '未确认', tone: 'neutral' },
  matches_baseline: { label: '与确认版本一致', tone: 'success' },
  changed_since_confirm: { label: '确认后有改动', tone: 'accent' },
  not_comparable: { label: '无法比较', tone: 'muted' },
};
const CONFIRMATION_REASONS: Record<string, string> = {
  relocated: '重定位后还没有在新位置重新确认',
  'context-changed': '确认基线的位置与当前登记位置不同',
  domain: '确认基线的校验方式与当前不同',
  'no-complete-hash': '这次观测没有拿到完整内容 hash',
  unregistered: '文档已解除登记',
};

export const GIT_LABELS: Record<string, DisplayLabel> = {
  untracked: { label: '未跟踪', tone: 'neutral' },
  ignored: { label: '已忽略', tone: 'muted' },
  modified: { label: '有未提交修改', tone: 'accent' },
  committed: { label: '已提交，无改动', tone: 'success' },
  not_a_repo: { label: '不在 Git 仓库中', tone: 'muted' },
  git_unavailable: { label: 'Git 状态不可用', tone: 'warn' },
};

export const ROLE_LABELS: Record<string, string> = { main: '主工作区', worktree: '工作树' };

function tone(value?: string, fallback?: string): string { return value || fallback || 'neutral'; }

export function managementView(status: string | undefined): DisplayLabel {
  return { label: MANAGEMENT_LABELS[status!] || String(status || '未知'), tone: tone(MANAGEMENT_TONE[status!]) };
}

export function availabilityFromCode(code: string | undefined): string | null { return CODE_TO_AVAILABILITY[code!] || null; }

/** 列表与详情可能因并发写入不一致，登记修订较高的一方优先。 */
// 列表与详情可能来自不同请求；修订较高的登记优先，相同时保留列表记录。
export function currentRecord(row: Doc | null | undefined, view: DocView | null | undefined): Doc {
  const fromView = view && view.doc;
  if (row && fromView) return Number(row.rev) >= Number(fromView.rev) ? row : fromView;
  return row || fromView || {};
}

/** 早于登记修订的观测不能代表当前状态，墓碑与存活记录也不能混用。 */
// 旧观测不能证明新登记的状态，尤其不能把已解除登记显示成仍可读。
export function usableView(record: Doc, view: DocView | null | undefined): DocView | null {
  if (!view || !view.doc) return null;
  if (Number(view.doc.rev) < Number(record && record.rev)) return null;
  if (record && record.unregistered && !view.unregistered) return null;
  return view;
}

export function availabilityView(view: DocView | null | undefined, record?: Doc): AvailabilityLabel {
  if (record && record.unregistered) return { label: '已解除登记', tone: 'muted', title: '', hint: '', availability: null, code: null };
  if (!view) return { label: '未观测', tone: 'muted', title: '', hint: '', availability: null, code: null };
  if (view.unregistered) return { label: '已解除登记', tone: 'muted', title: '', hint: '', availability: null, code: null };
  const copy = AVAILABILITY_COPY[view.availability!];
  if (!copy) {
    return {
      label: '未知可用性', tone: 'warn', title: '读取结果无法识别：' + String(view.availability),
      hint: '这个版本的界面不认识该结果，按只读处理。', availability: view.availability, code: view.code || null,
    };
  }
  return Object.assign({ availability: view.availability, code: view.code || null }, copy);
}

export function confirmationView(confirmation: Confirmation | null | undefined): DisplayLabel & { reason: string } {
  if (!confirmation) return { label: '未观测', tone: 'muted', reason: '' };
  const base = CONFIRMATION_LABELS[confirmation.state!] || { label: String(confirmation.state), tone: 'muted' };
  const reason = confirmation.reason ? (CONFIRMATION_REASONS[confirmation.reason] || confirmation.reason) : '';
  return { label: base.label, tone: base.tone, reason };
}

export function gitView(git: GitObservation | null | undefined, availability?: string | null): DisplayLabel & { detail: string } {
  if (!git) {
    return { label: '未观测 Git', tone: 'muted', detail: availability ? '文件位置不可达时不运行 Git' : '' };
  }
  const base = GIT_LABELS[git.state!] || { label: String(git.state), tone: 'muted' };
  const parts = [];
  if (git.state === 'modified') {
    if (git.staged) parts.push('已暂存');
    if (git.unstaged) parts.push('未暂存');
  }
  if (git.detail === 'unsupported-content-transform') parts.push('路径带 filter/LFS 属性，无法可靠比较字节');
  else if (git.detail === 'not-in-index') parts.push('不在索引中');
  else if (git.detail) parts.push(String(git.detail));
  if (git.lfs) parts.push('LFS');
  return { label: base.label, tone: base.tone, detail: parts.join(' · ') };
}

/** 四维状态保持独立，不压缩成容易误导的单一成功标记。 */
export function statusDimensions(row: Doc, inspected: DocView): (DisplayLabel & { key: string; name: string })[] {
  const record = currentRecord(row, inspected);
  const view = usableView(record, inspected);
  return [
    Object.assign({ key: 'management', name: '管理状态' }, managementView(record.status)),
    Object.assign({ key: 'availability', name: '可用性' }, availabilityView(view, record)),
    Object.assign({ key: 'confirmation', name: '确认情况' }, view ? confirmationView(view.confirmation) : confirmationView(null)),
    Object.assign({ key: 'git', name: 'Git' }, view ? gitView(view.git, view.unregistered ? null : view.availability) : gitView(null, null)),
  ];
}

export function formatBytes(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未知';
  if (value < 1024) return value + ' 字节';
  if (value < 1024 * 1024) return (Math.round(value / 102.4) / 10) + ' KiB';
  return (Math.round(value / 104857.6) / 10) + ' MiB';
}

export function utf8Length(text: unknown): number {
  const value = String(text == null ? '' : text);
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  return unescape(encodeURIComponent(value)).length;
}

/** 预览区区分解除登记、不可用、格式不支持、未加载与正文；截断时必须同时说明已显示及全文字节数。 */
// 不可预览、未加载与空正文必须分开；截断时提示的确认目标仍是全文指纹。
export function previewState(view: DocView | null | undefined): PreviewState {
  if (!view) return { kind: 'not-loaded', notice: '尚未观测' };
  if (view.unregistered) return { kind: 'unregistered', notice: '文档已解除登记，不再读取工作区文件。登记记录、关联和历史都保留；工作区文件没有被删除。' };
  const observation = view.observation || {};
  if (view.availability !== 'readable' && view.availability !== 'unsupported_format') {
    return { kind: 'unavailable', notice: '没有可显示的正文：' + availabilityView(view).title + '。' };
  }
  if (!observation.previewable) {
    return { kind: 'not-previewable', notice: '这个文件不在此处预览' + (observation.detail ? '（' + detailText(observation.detail) + '）' : '') + '。下方不显示正文，这不代表文件为空。' };
  }
  const preview = observation.preview;
  if (!preview || typeof preview.text !== 'string') return { kind: 'not-loaded', notice: '这次观测没有带预览正文，点「重新读取文件」加载。' };
  const shown = utf8Length(preview.text);
  if (!preview.truncated) return { kind: 'text', text: preview.text, truncated: false, shownBytes: shown, totalBytes: preview.totalBytes, notice: '' };
  return {
    kind: 'text', text: preview.text, truncated: true, shownBytes: shown, totalBytes: preview.totalBytes,
    notice: '预览已截断：只显示前 ' + formatBytes(shown) + '（全文 ' + formatBytes(preview.totalBytes) + '）。不能据此认为已读完全文；确认针对的是完整文件的 hash。',
  };
}

export function detailText(detail: unknown): string {
  if (detail == null) return '';
  if (typeof detail === 'string') {
    return { extension: '扩展名不在预览范围内', 'utf-16le': 'UTF-16LE 编码', 'utf-16be': 'UTF-16BE 编码', 'nul-byte': '包含 NUL 字节' }[detail] || detail;
  }
  if (typeof detail === 'object' && typeof (detail as { size?: unknown }).size === 'number' && typeof (detail as { maxBytes?: unknown }).maxBytes === 'number') {
    return formatBytes((detail as { size: number }).size) + '，上限 ' + formatBytes((detail as { maxBytes: number }).maxBytes);
  }
  try { return JSON.stringify(detail); } catch (error) { return String(detail); }
}

export function isMarkdownPath(relPath: unknown): boolean {
  return /\.(md|markdown|mdown)$/i.test(String(relPath || ''));
}

/** 读取来源绑定在文档登记上，会话当前目录不改变它。 */
export function workspaceSource(doc: Doc, view: DocView | null | undefined): { bindingId: string; relPath: string; root: string | null | undefined; role: string | null; observed: boolean } {
  const record = (view && view.doc) || doc || {};
  const locator = record.locator || {};
  const context = (view && view.observation && view.observation.context) || null;
  return {
    bindingId: locator.bindingId || '',
    relPath: locator.relPath || '',
    root: context ? context.root : null,
    role: context && context.role ? (ROLE_LABELS[context.role] || context.role) : null,
    observed: Boolean(context),
  };
}

export function observedStamp(view: DocView | null | undefined): string {
  const observation = view && view.observation;
  if (!observation) return '';
  return (observation.cached ? '缓存结果' : '刚刚读取') + ' · 观测于 ' + String(observation.observedAt || '');
}

/** 墓碑与新版本响应都拒绝写入，不能靠可读性绕过守卫。 */
/** 首个外置列表响应到达前保持只读，不能默认开放写入。 */
export const PENDING_LIST_SCHEMA = { pending: true };

/** 写权限取决于最近成功列表是否明确返回版本 1；刷新失败保留原判定，不解锁。 */
// 刷新失败保留上次 schema 判定；只有明确成功的已知版本才能恢复写入。
export function nextListSchema(previous: ListSchema, result: { ok?: boolean; schemaVersion?: unknown }): ListSchema {
  if (result && result.ok) return { version: result.schemaVersion };
  return previous || PENDING_LIST_SCHEMA;
}

export function schemaBlock(listSchema: ListSchema | null | undefined): string {
  if (listSchema == null) return '';
  if (listSchema.pending) return '还没有收到外置文档列表的 schemaVersion，暂按只读处理；刷新列表成功后恢复';
  if (listSchema.version === EXTERNAL_SCHEMA_VERSION) return '';
  return '服务端的外置文档列表 schemaVersion 是 ' + String(listSchema.version) + '，这个界面只认识 1：整个外置文档面板按只读处理，请升级插件后再写入';
}

// 列表版本、详情版本和墓碑依次守卫，不能由单个可读结果越过整页只读。
export function writeBlock(view: DocView | null | undefined, listSchema?: ListSchema): string {
  const listBlocked = schemaBlock(listSchema);
  if (listBlocked) return listBlocked;
  if (!view) return '尚未观测，无法写入';
  if (view.schemaVersion !== EXTERNAL_SCHEMA_VERSION) return '服务端返回 schemaVersion ' + String(view.schemaVersion) + '，这个界面只认识 1：按只读处理，请升级插件后再写入';
  if (view.unregistered) return '已解除登记的文档不能再修改';
  return '';
}

export function confirmBlock(view: DocView | null | undefined, listSchema?: ListSchema): string {
  const blocked = writeBlock(view, listSchema);
  if (blocked) return blocked;
  // 通用守卫已排除无观测；确认还必须有完整指纹，不能只凭预览正文。
  const observation = view!.observation || {};
  if (typeof observation.contentHash !== 'string' || observation.contentHash === '') {
    return '这次观测没有完整内容 hash（' + availabilityView(view).label + '），无法确认';
  }
  if (view!.confirmation && view!.confirmation.state === 'matches_baseline') return '当前内容已与确认版本一致';
  return '';
}

export function linkedPlanRefs(record: Doc): string[] {
  const links = (record && record.links) || {};
  return (links.planRefs || []).map((ref) => { return ref.planId + ' v' + ref.version; });
}

/** 内嵌与外置列表合并展示，外置列表为其记录的唯一权威，包含墓碑且每条只显示一次。 */
// 外置列表是外置记录的唯一权威，合并后仍按更新时间排序且不改输入。
export function mergeDocRows(inlineDocs: Doc[], externalDocs: Doc[]): Doc[] {
  const rows: Doc[] = [];
  (inlineDocs || []).forEach((doc) => {
    if (doc && doc.source !== 'external') rows.push(Object.assign({}, doc, { source: 'inline' }));
  });
  (externalDocs || []).forEach((doc) => {
    if (doc) rows.push(Object.assign({}, doc, { source: 'external' }));
  });
  rows.sort((a, b) => { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
  return rows;
}

/** 只有仍存活的外置记录才安排后台缓存观测，不取预览正文。 */
export function inspectTargets(rows: Doc[]): Doc[] {
  return (rows || []).filter((row) => { return row.source === 'external' && !row.unregistered; });
}

export function rowHaystack(row: Doc): string {
  const locator = row.locator || {};
  return [row.title, row.id, row.kind, locator.relPath, locator.bindingId].filter(Boolean).join(' ').toLowerCase();
}

export function findRow(rows: Doc[], docId: string): Doc | null {
  for (let i = 0; i < (rows || []).length; i += 1) if (rows[i].id === docId) return rows[i];
  return null;
}

/** 没有绑定列表接口，只从本项目已有记录按出现顺序收集绑定。 */
export function knownBindingIds(rows: Doc[]): string[] {
  const seen: string[] = [];
  (rows || []).forEach((row) => {
    const id = row && row.locator && row.locator.bindingId;
    if (id && seen.indexOf(id) < 0) seen.push(id);
  });
  return seen;
}

export function shortHash(hash: unknown): string {
  const value = String(hash || '');
  return value.length > 16 ? value.slice(0, 12) + '…' + value.slice(-4) : value;
}

export function actorText(actor: Actor | string | null | undefined): string {
  if (!actor) return '';
  if (typeof actor === 'string') return actor;
  return [actor.kind, actor.via].filter(Boolean).join('/');
}

/** 即使文件不可用，登记上保存的确认基线仍须显示以供审计。 */
export function baselineSummary(record: Doc): { hash: string; shortHash: string; bindingId: string; relPath: string; confirmedAt: string; confirmedBy: string; inContext: boolean } | null {
  const baseline = record && record.baseline;
  if (!baseline) return null;
  return {
    hash: baseline.contentHash || '',
    shortHash: shortHash(baseline.contentHash),
    bindingId: baseline.bindingId || '',
    relPath: baseline.relPath || '',
    confirmedAt: baseline.confirmedAt || '',
    confirmedBy: actorText(baseline.confirmedBy),
    inContext: record.baselineInContext === true,
  };
}

/** 列表重载版本或记录修订变化都会触发重新观测，不复用旧结果。 */
export function observationKey(rows: Doc[], version: number): string {
  return inspectTargets(rows).map((row) => { return row.id + ':' + row.rev; }).join(',') + '#' + String(version || 0);
}

/** 表单绑定打开时的登记修订与确认指纹；失效则返回关闭原因，绝不把草稿自动重设到新修订。 */
// 草稿不能自动换修订或确认指纹；观测改变时说明关闭原因，交给人重新打开。
export function guardForm(mode: FormMode | null, view: DocView | null | undefined, listSchema: ListSchema | undefined): string {
  if (!mode) return '';
  const blocked = schemaBlock(listSchema);
  if (blocked) return blocked;
  if (!view) return '';
  if (view.unregistered) return '这条登记已被解除，表单已关闭';
  if (view.metaRev !== mode.metaRev) {
    return '登记信息已变化（metaRev ' + mode.metaRev + ' → ' + view.metaRev + '），表单已关闭，你的草稿没有提交。请看过最新内容后重新打开。';
  }
  const hash = view.observation && view.observation.contentHash;
  if (mode.name === 'confirm' && (hash || null) !== (mode.hash || null)) {
    return '文件内容已变化，确认表单已关闭。请看过新内容后重新打开并确认。';
  }
  return '';
}

/** 截断预览的同意仅对当时的准确内容指纹有效，换内容必须重新同意。 */
export function ackMatches(ackedHash: string | null | undefined, view: DocView | null | undefined): boolean {
  const hash = view && view.observation && view.observation.contentHash;
  return Boolean(ackedHash) && ackedHash === hash;
}

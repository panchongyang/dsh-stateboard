// 文档页展示的纯选择器：统一列表信号、分组、状态行、提醒与技术详情。
// 只决定哪些事实值得突出，不合并四维状态，也不执行读取或确认。
import type { Doc, DocView, RowSignal, DocGroup, MetaPart, StatusPart, Notice, ListSchema, TechnicalSection, TechnicalRow } from './types.ts';
import { docKindLabel } from './labels.ts';
import {
  actorText, availabilityView, baselineSummary, confirmationView, currentRecord, gitView, managementView,
  observedStamp, shortHash, usableView, workspaceSource, writeBlock,
} from './external-docs.ts';

/** 本年显示月日，跨年显示完整日期；需要时间时追加小时分钟，非法日期保留原输入。 */
export function shortDate(value: string | number | null | undefined | false, now?: string | number, withTime?: boolean): string {
  if (!value) return '';
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  const ref = now ? new Date(now) : new Date();
  function pad(number: number): string { return number < 10 ? '0' + number : String(number); }
  let day = pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  if (date.getFullYear() !== ref.getFullYear()) day = date.getFullYear() + '-' + day;
  return withTime ? day + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) : day;
}

export function splitRelPath(relPath: unknown): { dir: string; name: string } {
  const text = String(relPath || '');
  const cut = text.lastIndexOf('/');
  return cut < 0 ? { dir: '', name: text } : { dir: text.slice(0, cut), name: text.slice(cut + 1) };
}

function unreadable(view: DocView | null | undefined): boolean {
  return Boolean(view) && !view!.unregistered && view!.availability !== 'readable' && view!.availability !== 'unsupported_format';
}

/** 列表行只突出一个信号；attention 表示需要人工处理，安静状态的 label 留空，但 srText 保留完整状态。 */
// 墓碑与不可读优先于确认状态；旧指纹不能掩盖当前无法读取的事实。
export function rowSignal(row: Doc, inspected: DocView | null | undefined): RowSignal {
  if (!row || row.source !== 'external') return { key: 'inline', tone: 'muted', label: '', attention: false, srText: '' };
  const record = currentRecord(row, inspected);
  if (record.unregistered) return { key: 'tomb', tone: 'muted', label: '已解除登记', attention: false, srText: '已解除登记' };
  const view = usableView(record, inspected);
  if (!view) return { key: 'unobserved', tone: 'muted', label: '', attention: false, srText: '尚未观测' };
  if (view.unregistered) return { key: 'tomb', tone: 'muted', label: '已解除登记', attention: false, srText: '已解除登记' };
  if (unreadable(view)) {
    const info = availabilityView(view, record);
    return { key: 'unreadable', tone: info.tone === 'danger' ? 'danger' : 'warn', label: info.label, attention: true, srText: '不可读：' + info.label };
  }
  const state = view.confirmation && view.confirmation.state;
  if (state === 'changed_since_confirm') return { key: 'changed', tone: 'accent', label: '已改动', attention: true, srText: '确认后有改动' };
  if (state === 'not_comparable') {
    const reason = confirmationView(view.confirmation).reason;
    return { key: 'reconfirm', tone: 'accent', label: '需重新确认', attention: true, srText: '需重新确认' + (reason ? '：' + reason : '') };
  }
  if (state === 'matches_baseline') return { key: 'matched', tone: 'success', label: '', attention: false, srText: '已确认，内容未变' };
  return { key: 'unconfirmed', tone: 'muted', label: '', attention: false, srText: '未确认' };
}

export const DOC_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'attention', label: '需处理' },
  { key: 'unconfirmed', label: '未确认' },
  { key: 'tomb', label: '已解除' },
];

export function filterMatches(filter: string, signal: RowSignal): boolean {
  if (!filter || filter === 'all') return true;
  if (filter === 'attention') return Boolean(signal && signal.attention);
  return Boolean(signal) && signal.key === filter;
}

/** 按同一组行及文档身份索引的观测，计算各筛选的数量。 */
export function filterCounts(rows: Doc[], views: Record<string, DocView>): Record<string, number> {
  const counts: Record<string, number> = { all: 0, attention: 0, unconfirmed: 0, tomb: 0 };
  (rows || []).forEach((row) => {
    const signal = rowSignal(row, (views || {})[row.id!]);
    DOC_FILTERS.forEach((filter) => { if (filterMatches(filter.key, signal)) counts[filter.key] += 1; });
  });
  return counts;
}

export const INLINE_GROUP = 'inline';

/** 按目录分组，内嵌文档独立成组；组按首行顺序，组内墓碑后置，多绑定标签加短身份以免混淆。 */
export function groupDocRows(rows: Doc[]): DocGroup[] {
  const list = rows || [];
  const bindings: Record<string, boolean> = {};
  list.forEach((row) => { if (row.source === 'external' && row.locator) bindings[row.locator.bindingId || ''] = true; });
  const multi = Object.keys(bindings).length > 1;

  // 分组按首次出现建立；绑定参与键，避免相同路径的不同工作树合桶。
  const groups: DocGroup[] = [];
  const index: Record<string, DocGroup> = {};
  list.forEach((row) => {
    let key;
    let label;
    if (row.source === 'external') {
      const locator = row.locator || {};
      const dir = splitRelPath(locator.relPath).dir;
      key = 'ext:' + (locator.bindingId || '') + ':' + dir;
      label = (dir || '（根目录）') + (multi ? ' · ' + shortHash(locator.bindingId || '?') : '');
    } else {
      key = INLINE_GROUP;
      label = '看板内嵌';
    }
    if (!index[key]) { index[key] = { key, label, rows: [] }; groups.push(index[key]); }
    index[key].rows.push(row);
  });

  // 只在组内把墓碑后置，存活项与墓碑各自保持输入顺序。
  groups.forEach((group) => {
    group.rows = group.rows.filter((row) => { return !row.unregistered; })
      .concat(group.rows.filter((row) => { return Boolean(row.unregistered); }));
  });
  return groups;
}

/** 标题下方外置显示文件名，内嵌显示种类与修订。 */
export function rowSubline(row: Doc): string {
  if (row && row.source === 'external') return splitRelPath(row.locator && row.locator.relPath).name;
  return docKindLabel(row && row.kind) + (row && row.rev ? ' · 修订 ' + row.rev : '');
}

/** 页头依次显示路径、种类、管理状态与更新时间，缺少字段不补造事实。 */
export function headerMeta(record: Doc, now?: string | number): MetaPart[] {
  const parts: MetaPart[] = [];
  if (record.locator && record.locator.relPath) parts.push({ key: 'path', text: record.locator.relPath, mono: true });
  parts.push({ key: 'kind', text: docKindLabel(record.kind) });
  if (record.status) parts.push({ key: 'status', text: managementView(record.status).label });
  if (record.updatedAt) parts.push({ key: 'updated', text: '更新于 ' + shortDate(record.updatedAt, now, true) });
  return parts;
}

function confirmationPart(view: DocView, record: Doc, now?: string | number): StatusPart {
  const base = baselineSummary(record);
  const when = base && base.confirmedAt ? shortDate(base.confirmedAt, now, true) : '';
  const state = view && view.confirmation ? view.confirmation.state : null;
  if (state === 'matches_baseline') return { key: 'confirmation', tone: 'success', label: '已确认，内容未变', detail: when };
  if (state === 'changed_since_confirm') return { key: 'confirmation', tone: 'accent', label: '确认后有改动', detail: when ? '上次确认 ' + when : '' };
  if (state === 'not_comparable') {
    if (unreadable(view)) return { key: 'confirmation', tone: 'muted', label: '确认无法比较', detail: when ? '上次确认 ' + when : '' };
    return { key: 'confirmation', tone: 'accent', label: '需重新确认', detail: confirmationView(view.confirmation).reason };
  }
  if (state === 'unconfirmed') return { key: 'confirmation', tone: 'muted', label: '未确认', detail: '' };
  return { key: 'confirmation', tone: 'muted', label: '确认情况未知', detail: '' };
}

/** 摘要分别展示可用性与确认，只有未提交或未跟踪字节才突出 Git；其余细节折叠展示。 */
// Git 只在工作区字节未提交时进入摘要，其余事实保留在技术详情。
export function statusLine(record: Doc, inspected: DocView | null | undefined, now?: string | number): { parts: StatusPart[]; git: { label: string; tone: string } | null } {
  if (record && record.unregistered) return { parts: [{ key: 'tomb', tone: 'muted', label: '已解除登记', detail: '' }], git: null };
  const view = usableView(record, inspected);
  if (!view) return { parts: [{ key: 'availability', tone: 'muted', label: '尚未观测', detail: '' }], git: null };
  if (view.unregistered) return { parts: [{ key: 'tomb', tone: 'muted', label: '已解除登记', detail: '' }], git: null };
  const info = availabilityView(view, record);
  const tone = info.availability === 'readable' ? 'success' : info.tone;
  const parts = [{ key: 'availability', tone, label: info.label, detail: '' }, confirmationPart(view, record, now)];
  let git = null;
  if (view.git && (view.git.state === 'modified' || view.git.state === 'untracked')) git = { label: 'Git：' + gitView(view.git).label, tone: 'muted' };
  return { parts, git };
}

/** 正文上方只展示值得提醒的事实；没有提醒则返回空，actions 列出直接可执行的补救。 */
export function attentionNotice(record: Doc, inspected: DocView | null | undefined): Notice | null {
  if (record && record.unregistered) {
    return { kind: 'tomb', tone: 'muted', title: '这条登记已解除', hint: '只改了看板里的记录，工作区文件没有被删除；登记、关联和历史都保留，不能再修改。', actions: [] };
  }
  const view = usableView(record, inspected);
  if (!view || view.unregistered) return null;
  if (unreadable(view)) {
    const info = availabilityView(view, record);
    return { kind: 'unavailable', tone: info.tone === 'danger' ? 'danger' : 'warn', title: info.title || info.label, hint: info.hint, actions: ['reinspect', 'relocate', 'unregister'] };
  }
  const state = view.confirmation && view.confirmation.state;
  if (state === 'changed_since_confirm') {
    return { kind: 'changed', tone: 'accent', title: '文件在上次确认后被改过', hint: '看完正文后点「确认当前内容」，把它记为新的确认版本；不确认也不影响阅读。', actions: [] };
  }
  if (state === 'not_comparable') {
    const reason = confirmationView(view.confirmation).reason;
    return { kind: 'reconfirm', tone: 'accent', title: reason || '当前位置还没有确认过', hint: '在当前位置确认一次之后，才会重新比较内容是否变化。', actions: [] };
  }
  return null;
}

/** 已匹配、缺完整指纹或墓碑不展示确认；只读面板展示禁用入口与原因，而非伪装可确认。 */
// 无完整指纹或已匹配基线时不提供确认；只读则保留入口并解释禁用原因。
export function confirmOffer(inspected: DocView | null | undefined, listSchema?: ListSchema): { show: boolean; reason: string } {
  const view = inspected;
  if (!view || view.unregistered) return { show: false, reason: '' };
  const observation = view.observation || {};
  if (typeof observation.contentHash !== 'string' || observation.contentHash === '') return { show: false, reason: '' };
  const state = view.confirmation && view.confirmation.state;
  if (state === 'matches_baseline') return { show: false, reason: '' };
  if (state === 'not_comparable' && view.confirmation!.reason === 'unregistered') return { show: false, reason: '' };
  return { show: true, reason: writeBlock(view, listSchema) };
}

const GIT_NOTES: Record<string, string> = {
  ignored: '命中 .gitignore：这个文件不进 Git 提交，与看板是否读取它无关。',
  untracked: '文件还没有加入 Git。',
  modified: '工作区里有未提交的修改。',
};

function sourceSection(record: Doc, view: DocView | null | undefined): TechnicalSection {
  const source = workspaceSource(record, view);
  return {
    key: 'source', title: '读取来源',
    rows: [
      { label: '工作区绑定', value: source.bindingId || '（未知）', mono: true },
      { label: '绑定根目录', value: source.observed ? (source.root || '不可达') + (source.role ? '（' + source.role + '）' : '') : '尚未观测', mono: true },
      { label: '相对路径', value: source.relPath || '（未知）', mono: true },
      { label: '观测', value: view ? observedStamp(view) : '尚未观测' },
    ],
    note: '文档始终从登记的绑定读取，不随会话当前目录或所在工作树变化。观察和重新读取都不会确认文档。',
  };
}

function baselineSection(record: Doc, now?: string | number): TechnicalSection {
  const base = baselineSummary(record);
  if (!base) return { key: 'baseline', title: '确认基线', rows: [], note: '还没有确认过任何版本。' };
  return {
    key: 'baseline', title: '确认基线',
    rows: [
      { label: '内容 hash', value: base.shortHash, mono: true, title: base.hash },
      { label: '确认于', value: shortDate(base.confirmedAt, now, true) + (base.confirmedBy ? ' · ' + base.confirmedBy : ''), title: base.confirmedAt },
      { label: '确认时位置', value: shortHash(base.bindingId) + ' : ' + base.relPath, mono: true },
    ],
    note: base.inContext ? '' : '登记位置在确认之后改过：这份基线只作审计保留，在当前位置重新确认前不参与比较。',
  };
}

function gitSection(view: DocView | null | undefined): TechnicalSection {
  const git = view ? gitView(view.git, view.unregistered ? null : view.availability) : gitView(null, null);
  const state = view && view.git ? view.git.state : null;
  return {
    key: 'git', title: 'Git',
    rows: [{ label: '状态', value: git.label + (git.detail ? ' · ' + git.detail : '') }],
    note: GIT_NOTES[state!] || '',
  };
}

function idSection(record: Doc, view: DocView | null | undefined): TechnicalSection {
  const rows: TechnicalRow[] = [{ label: '文档 id', value: record.id || '', mono: true }];
  rows.push({ label: 'metaRev', value: String(view ? view.metaRev : record.rev), mono: true });
  if (view && view.code) rows.push({ label: '读取结果码', value: view.code, mono: true });
  if (record.createdBy) rows.push({ label: '登记者', value: actorText(record.createdBy) });
  return { key: 'ids', title: '标识', rows, note: '' };
}

/** 默认视图省略的事实按读取来源、基线、Git 和身份分组，供折叠技术区展示。 */
export function technicalSections(record: Doc, inspected: DocView | null | undefined, now?: string | number): TechnicalSection[] {
  const view = usableView(record, inspected);
  return [sourceSection(record, view), baselineSection(record, now), gitSection(view), idSection(record, view)];
}

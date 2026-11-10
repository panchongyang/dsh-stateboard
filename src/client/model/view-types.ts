// JSX 组件消费的展示投影；HTTP 部分读取仍是可选字段，不把未加载当作空数据。
import type { ExternalBody, EditPayloadStep, ExternalErrorView, Actor, Board, Doc, DocView, EditForm, EditStep, EditTask, Evidence, Filters, FormGuard, FormMode, Links, ListSchema, Plan, PlanStep, Project, Task, TaskSession, SessionSnapshot, ExternalInput } from './types.ts';
export type { ExternalBody, Actor, Board, Doc, DocView, EditForm, EditStep, EditTask, Evidence, Filters, FormGuard, FormMode, Links, ListSchema, Plan, PlanStep, Project, Task, TaskSession, SessionSnapshot, ExternalInput };
// 卡片携带验收摘要，完整任务携带验收行；选择器只消费二者共有的身份与状态。
export interface Card extends Task { acceptance?: any }
export interface Column { key: string; label: string; hint: string }
export interface Attention { blocked?: Card[]; interrupted?: Card[] }
export interface BoardView extends Omit<Board, 'columns' | 'attention'> {
  columns?: Record<string, Card[]>; attention?: Attention; rev?: number; project?: ProjectView;
  counts?: { percent?: number; weightDone?: number; weightTotal?: number; total?: number; verifiedPercent?: number; interrupted?: number };
}

// 页面级资源快照独立于卡片摘要，避免把部分列表伪装成完整详情。
export interface ProjectView extends Project { phase?: string; readOnly?: boolean; rev?: number; inlineWritesDisabled?: boolean }
export interface PlanSummary extends Plan { progress?: { done: number; total: number; percent: number }; taskCount?: number; createdBy?: Actor; updatedAt?: string; archivedFrom?: string }
export interface PlanHead extends PlanSummary { goal?: string; assumptions?: string[]; risks?: string[] }
export interface PlanDetail { plan?: PlanHead; head?: PlanHead; steps?: PlanStep[]; progress?: { done: number; total: number; percent: number } }
export interface AcceptanceItem { id?: string; text: string; met?: boolean; requiredKinds?: string[] }
export interface EvidenceItem extends Evidence { id?: string }
export interface Audit { by?: Actor & { agentId?: string }; verdict?: string; at?: string; report?: string; checklist?: { ok: boolean; item: string; note?: string }[]; evidence?: { count?: number; digest?: string }; taskRev?: number; warnings?: (string | Warning)[] }
export interface Warning { code?: string; message?: string }
export interface TaskDetail extends Task { lastAudit?: Audit }
export interface TimelineEvent { seq?: number; type?: string; actor?: Actor; at?: string }
export interface AllowedOp { op: string; enabled: boolean; reason?: string }
export interface TaskView { task?: TaskDetail; allowedOps?: AllowedOp[]; acceptance?: AcceptanceItem[]; evidence?: EvidenceItem[]; linkedDocs?: Doc[]; timeline?: TimelineEvent[]; lease?: { token?: number } }

// 表单文本与提交动作分开建模，保留用户尚未通过校验的输入。
export interface ComposerFields { beginSummary: string; evidenceKind: string; evidenceRef: string; evidenceSummary: string; acceptanceId: string; note: string; blockCode: string; blockNote: string; choice: string; reconcileNote: string }
export type ComposerSetters = { [K in keyof ComposerFields as `set${Capitalize<K>}`]: (value: string) => void };
export type Notify = (tone: string, text: string) => void;
export interface Draft { title: string; kind: string; body: string }
export interface RegisterResult { doc?: Doc; result?: { docId?: string } }
export interface ExternalWriter {
  busy: boolean; failure: ExternalErrorView | null; clear(): void;
  patch(body: ExternalBody, done?: () => void): void;
  act(action: string, body: ExternalBody, okText: string, done?: () => void, classify?: (error: unknown) => ExternalErrorView): void;
}
export interface PlanEditInitial { form?: EditForm; base?: EditPayloadStep[]; error?: string; conflict?: boolean; confirming?: boolean; publishConfirm?: boolean }

// 初始编辑快照只描述页面播种，不替代请求生命周期或写入守卫。
export interface PlansInitial { plans?: PlanSummary[]; focusPlanId?: string; selected?: PlanSummary; detail?: PlanDetail; creating?: boolean; createTitle?: string; createGoal?: string; confirmArchive?: boolean; editing?: boolean; editInitial?: PlanEditInitial }
export interface ProjectsState { projects?: ProjectView[]; ready?: boolean; loading?: boolean; error?: string }
export interface BoardState { board?: BoardView; error?: string }
export interface Toast { id: string; tone?: string; text: string; leaving?: boolean }
export interface Option { value: string | number; label: string }
export interface Tab { id: string; label: string }
export interface ToolBlock { kind?: string; content?: { type?: string; text?: string }[] }
export interface MenuItem { op: string; label: string; open?: string; run?: string; states?: string[]; confirm?: boolean }
export interface MenuGroup { id: string; label: string; items: MenuItem[] }
export interface DocEntry { row: Doc; snippet: string }
export interface DocGroup { key: string; label: string; entries: DocEntry[] }
export interface Health { checks?: { name: string; ok: boolean; detail?: string }[]; warnings?: (string | Warning)[]; leases?: { taskId?: string; sessionId?: string; expiresAt?: string; token?: number }[]; intents?: { id?: string; taskId?: string; summary?: string; startedAt?: string }[]; lastAt?: string; seq?: number; hashChain?: string; readOnly?: boolean }

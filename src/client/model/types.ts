// 客户端消费面的类型投影，不是后端实体：可选字段表示列表与详情的部分响应。
// 未经运行时检查的 JSON 叶子保持 unknown，类型断言不补默认值或创造校验。
export interface Actor { kind?: string; via?: string; sessionId?: string }
export interface PlanRef { planId?: string; stepId?: string; version?: number }
export interface Links { taskIds?: string[]; planRefs?: PlanRef[] }
export interface Acceptance { text?: string; requiredKinds?: string[] | null }
export interface Evidence {
  kind?: string; ref?: string; summary?: string; acceptanceId?: string;
  fixedState?: string; fixedReason?: string; verifiedAt?: string;
  execution?: unknown; at?: string; producedBy?: Actor;
}
export interface Task {
  id?: string; key?: string; taskId?: string; title?: string; description?: string;
  rev?: number; state?: string; priority?: number; weight?: number; updatedAt?: string;
  labels?: string[]; requiresAudit?: boolean; owner?: Actor; createdBy?: Actor;
  planRef?: PlanRef; blocked?: { code?: string; note?: string };
  evidence?: Evidence[]; deps?: string[]; acceptance?: Acceptance[];
}
export interface PlanStep { id?: string; title?: string; tasks?: Task[] }
export interface Plan { id?: string; title?: string; status?: string; focus?: boolean; rev?: number; currentVersion?: number; steps?: PlanStep[] }
export interface Board { plans?: Plan[]; plan?: Plan; columns?: Record<string, Task[]>; attention?: { blocked?: Task[]; interrupted?: Task[] } }
export interface Project { id?: string; workspacePath?: string; name?: string }
export interface Session { cwd?: string; blank?: boolean; origin?: string; updatedAt?: number; retainedBy?: { mainView?: number } }
export interface SessionSnapshot { byId?: Record<string, Session> }
export interface SessionTarget { sessionId: string; updatedAt: number }
export interface TaskSession { sessionId: string | null; source: string | null }
export interface Filters { query?: string; state?: string | null; gateOnly?: boolean; plan?: string | null; group?: string }
export interface ApiError { code?: string; message?: string; details?: { currentContentHash?: string; currentMetaRev?: number }; status?: number }
export type ClientError = Error & ApiError;

// 命令信封只描述组装所需字段，额外数据由服务端负责校验。
export interface CommandEvent { type?: string; data?: { id?: string } }
export interface CommandResult { events?: CommandEvent[] }
// 附加命令字段对本层不透明：构造器只复制，校验由服务端负责。
export interface CommandBody { op?: string; cmdId?: string; taskId?: string; expected?: { entityRev?: number }; fencingToken?: number; [key: string]: unknown }
export interface TaskView { task?: Task; lease?: { token?: number } }
export interface TaskInput { title?: unknown; description?: unknown; acceptance?: unknown; priority?: unknown; requiresAudit?: boolean }
export interface CreateTaskBody extends CommandBody { op: string; title: string; acceptance: Acceptance[]; description?: string; priority?: number; requiresAudit?: boolean }
export interface CreateTaskResult { ok: boolean; errors: string[]; body: CreateTaskBody | null }

// 外置登记、观测与展示是不同快照；版本与指纹守卫显式携带在表单上下文中。
export interface Locator { bindingId?: string; relPath?: string }
export interface Doc {
  id?: string; source?: string; rev?: number; title?: string; kind?: string; status?: string;
  locator?: Locator; unregistered?: boolean | { at?: string; by?: Actor; reason?: string }; updatedAt?: string; createdBy?: Actor | string;
  links?: Links; baselineInContext?: boolean;
  baseline?: { contentHash?: string; bindingId?: string; relPath?: string; confirmedAt?: string; confirmedBy?: Actor | string };
}
export interface Confirmation { state?: string; reason?: string }
export interface GitObservation { state?: string; staged?: boolean; unstaged?: boolean; detail?: string; lfs?: boolean }
export interface Observation {
  contentHash?: string; previewable?: boolean; detail?: unknown;
  preview?: { text?: string; truncated?: boolean; totalBytes?: number };
  context?: { root?: string; role?: string }; cached?: boolean; observedAt?: string;
}
export interface DocView { doc?: Doc; metaRev?: number; schemaVersion?: unknown; unregistered?: boolean; availability?: string; code?: string; confirmation?: Confirmation; git?: GitObservation; observation?: Observation }
export interface ListSchema { pending?: boolean; version?: unknown }
export interface DisplayLabel { label: string; tone: string }
export interface AvailabilityLabel extends DisplayLabel { title: string; hint: string; availability?: string | null; code?: string | null }
export interface PreviewState { kind: string; notice: string; text?: string; truncated?: boolean; shownBytes?: number; totalBytes?: number }
export interface ExternalInput { title?: string; kind?: string; relPath?: string; bindingId?: string; taskIds?: string[]; status?: string; reason?: string }
export interface ExternalBody extends ExternalInput { expectedMetaRev?: number; expectedContentHash?: string; links?: Links }
export type PayloadResult = { error: string; body?: never } | { body: ExternalBody; error?: never };
export interface FormGuard { listSchema?: ListSchema; baseRev?: number; baseHash?: string | null }
export interface FormMode { name?: string; metaRev?: number; hash?: string | null }
export interface RowSignal extends DisplayLabel { key: string; attention: boolean; srText: string }
export interface DocGroup { key: string; label: string; rows: Doc[] }
export interface MetaPart { key: string; text: string | undefined; mono?: boolean }
export interface StatusPart extends DisplayLabel { key: string; detail: string }
export interface TechnicalRow { label: string; value: string; mono?: boolean; title?: string }
export interface TechnicalSection { key: string; title: string; rows: TechnicalRow[]; note: string }
export interface Notice { kind: string; tone: string; title: string; hint: string; actions: string[] }
export interface ExternalErrorView { code: string | null | undefined; action: string | null; message: string }

// 编辑态保留文本字段，保存时再解析数字与列表，避免输入中间态被提前改写。
export interface EditTask {
  key?: string; taskId?: string; title?: string; description?: string; priority?: string; weight?: string;
  deps?: string; acceptance?: string; acceptanceOriginal?: Acceptance[]; labels?: string; requiresAudit?: boolean;
}
export interface EditStep { key?: string; id?: string; title?: string; tasks?: EditTask[] }
export interface EditForm { steps: EditStep[] }
export interface EditPayloadTask { key: string; taskId?: string; title: string; description: string; priority: number; weight: number; deps: string[]; labels: string[]; acceptance: Acceptance[]; requiresAudit: boolean }
export interface EditPayloadStep { id: string; title: string; tasks: EditPayloadTask[] }
export type EditStepsResult = { ok: true; steps: EditPayloadStep[]; errors?: never } | { ok: false; errors: string[]; steps?: never };
export interface EditEntry { stepId?: string; task: EditPayloadTask }
export interface EditDiff { added: number; updated: number; removed: number; removedTasks: { taskId: string; title: string }[]; stepsAdded: number; stepsRemoved: number; stepsChanged: number; changed: boolean }
export interface PlanCommand extends CommandBody { op: string; planId: string | undefined; baseVersion?: number; expected?: { entityRev?: number }; steps?: EditPayloadStep[] }

// 导航意图与已确认选择分离，选择代次用于阻止旧编辑回调跨项目写入。
export interface ProjectState { projects?: Project[]; error?: unknown; ready?: boolean; loading?: boolean }
export type LocationResult = { phase: 'matched'; cwd: string; project: Project; exact: boolean } | { phase: 'unknown' | 'failed' | 'loading' | 'unmatched'; cwd: string; project?: never; exact?: never };
export interface NavigationIntent { cwd: string; preserve: boolean }
export interface NavigationState { projectId: string; selectionVersion: number; located: boolean; createPath: string; intent: NavigationIntent | null }
export interface ProjectNavigation {
  snapshot(): NavigationState; subscribe(fn: (state: NavigationState) => void): () => void;
  start(): void; stop(): void; assertWritable(confirmedId: string, selectionVersion: number): void;
  jump(cwd: string | null, preserve?: boolean): void; choose(id: string, cwd?: string): void; cancel(): void;
  resolve(catalog: ProjectState, mainCwd: string, accept?: NavigationIntent | null): void;
}
// 只描述客户端实际消费的宿主服务，不为无关能力编造类型。
export interface HostServices {
  uiWorkspace: { openSession?: (id: string) => unknown };
  sessions: { list?: { getSnapshot?: () => SessionSnapshot; subscribe?: (fn: () => void) => (() => void) } };
}
export interface PluginContext { get<K extends keyof HostServices>(name: K): HostServices[K] }

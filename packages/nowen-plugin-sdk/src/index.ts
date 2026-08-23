export type JsonObject = Record<string, unknown>;
export type ActionResult = { success?: boolean; data?: unknown; text?: string } | unknown;

export interface NoteSummary {
  id: string; notebookId: string; title: string; contentText?: string; contentFormat: string;
  workspaceId: string | null; version: number; createdAt: string; updatedAt: string;
}
export interface Note extends NoteSummary { content: string }
export interface Notebook { id: string; parentId: string | null; name: string; description?: string; icon?: string; color?: string | null; workspaceId: string | null; createdAt: string; updatedAt: string }
export interface Tag { id: string; name: string; color: string; workspaceId: string | null; createdAt: string }
export interface Task extends JsonObject { id: string; title: string; userId: string; workspaceId: string | null; isCompleted: number; priority: number }
export interface Attachment { id: string; noteId: string; filename: string; mimeType: string; size: number; createdAt: string }
export interface DiaryEntry extends JsonObject { id: string; userId: string; workspaceId: string | null; contentText: string; mood: string; createdAt: string }
export interface Mindmap extends JsonObject { id: string; userId: string; workspaceId: string | null; title: string; data?: unknown; createdAt?: string; updatedAt?: string }

export interface NotesApi {
  get(input: { noteId: string }): Promise<Note | null>;
  list(input?: { limit?: number }): Promise<NoteSummary[]>;
  create(input: { notebookId: string; title?: string; content?: string; contentFormat?: "markdown" | "html" | "tiptap-json" }): Promise<{ id: string; version?: number }>;
  update(input: { noteId: string; title?: string; content?: string; contentFormat?: "markdown" | "html" | "tiptap-json" }): Promise<{ id: string; version: number }>;
}
export interface NotebooksApi {
  get(input: { notebookId: string }): Promise<Notebook | null>;
  list(): Promise<Notebook[]>;
  create(input: { name: string; workspaceId?: string | null; parentId?: string | null; icon?: string; color?: string | null }): Promise<{ id: string }>;
}
export interface TagsApi {
  list(): Promise<Tag[]>;
  create(input: { name: string; color?: string; workspaceId?: string | null }): Promise<{ id: string }>;
  addToNote(input: { noteId: string; tagId: string }): Promise<{ success: true }>;
  removeFromNote(input: { noteId: string; tagId: string }): Promise<{ success: true }>;
}
export interface TasksApi {
  get(input: { taskId: string }): Promise<Task>;
  list(input?: { limit?: number }): Promise<Task[]>;
  create(input: { title: string; workspaceId?: string | null; description?: string; priority?: number; dueDate?: string | null; noteId?: string | null }): Promise<{ id: string }>;
  update(input: { taskId: string; title?: string; description?: string; isCompleted?: boolean; priority?: number; dueDate?: string | null }): Promise<{ id: string }>;
}
export interface AttachmentsApi {
  get(input: { attachmentId: string }): Promise<Attachment>;
  list(input?: { limit?: number }): Promise<Attachment[]>;
}
export interface DiaryApi {
  get(input: { diaryId: string }): Promise<DiaryEntry>;
  list(input?: { limit?: number }): Promise<DiaryEntry[]>;
  create(input: { workspaceId?: string | null; contentText: string; mood?: string; createdAt?: string }): Promise<{ id: string }>;
}
export interface MindmapsApi {
  get(input: { mindmapId: string }): Promise<Mindmap>;
  list(input?: { limit?: number }): Promise<Mindmap[]>;
  create(input: { workspaceId?: string | null; title?: string; data?: unknown }): Promise<{ id: string }>;
  update(input: { mindmapId: string; title?: string; data?: unknown }): Promise<{ id: string }>;
}
export interface StorageApi {
  get(input: { key: string; scopeType?: "user" | "workspace"; scopeId?: string }): Promise<unknown>;
  set(input: { key: string; value: unknown; scopeType?: "user" | "workspace"; scopeId?: string }): Promise<{ success: true }>;
  delete(input: { key: string; scopeType?: "user" | "workspace"; scopeId?: string }): Promise<{ success: true }>;
}
export interface ExternalApi {
  fetch(input: { url: string; method?: string; headers?: Record<string, string>; body?: unknown; connection?: string }): Promise<{ status: number; ok: boolean; headers: { "content-type": string | null }; body: string }>;
}
export interface RuntimeCapabilities { apiVersion: number; runtime: "node-action" | "sandbox-js"; platform: "server" | "desktop-full"; hostApis: string[]; notes?: { read: number; write: number }; automation?: number; workspace?: number; declarativeContributions?: number }
export interface RuntimeApi { capabilities(): Promise<RuntimeCapabilities> }

export interface NowenHostApi {
  notes: NotesApi; notebooks: NotebooksApi; tags: TagsApi; tasks: TasksApi;
  attachments: AttachmentsApi; diary: DiaryApi; mindmaps: MindmapsApi;
  storage: StorageApi; external: ExternalApi; runtime: RuntimeApi;
  progress(input: { current?: number; total?: number; message?: string }): void;
}

export interface PluginExecutionInfo { executionId: string; correlationId?: string; causationId?: string; depth?: number; idempotencyKey?: string }
export interface PluginActionContext<TInput extends JsonObject = JsonObject> { input: TInput; nowen: NowenHostApi; execution?: PluginExecutionInfo }
export type PluginActionHandler<TInput extends JsonObject = JsonObject> = (context: PluginActionContext<TInput>) => ActionResult | Promise<ActionResult>;
export interface NowenPluginDefinition {
  activate?(context: { nowen: NowenHostApi }): void | Promise<void>;
  actions: Record<string, PluginActionHandler>;
  deactivate?(): void | Promise<void>;
}

export type NowenPluginErrorCode = "PLUGIN_PERMISSION_DENIED" | "RESOURCE_NOT_FOUND" | "RESOURCE_FORBIDDEN"
  | "INVALID_ARGUMENT" | "NETWORK_UNAVAILABLE" | "EXTERNAL_FETCH_DENIED" | "PLUGIN_TIMEOUT"
  | "PLUGIN_CANCELLED" | "PLUGIN_PREFLIGHT_FAILED" | "PLUGIN_ACTION_MISMATCH" | "PLUGIN_ERROR";

export class NowenPluginError extends Error {
  constructor(message: string, readonly code: NowenPluginErrorCode = "PLUGIN_ERROR") {
    super(message);
    this.name = "NowenPluginError";
  }
}

/** 编译期保留完整类型，运行时原样返回，不夹带业务实现或凭证。 */
export function definePlugin<T extends NowenPluginDefinition>(plugin: T): T { return plugin; }

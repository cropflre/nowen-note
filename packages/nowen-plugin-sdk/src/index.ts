import type { NowenHostApi } from "./hostApi.generated.js";

export * from "./hostApi.generated.js";

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
  | "PLUGIN_CANCELLED" | "PLUGIN_PREFLIGHT_FAILED" | "PLUGIN_ACTION_MISMATCH"
  | "HOST_METHOD_NOT_FOUND" | "HOST_METHOD_UNSUPPORTED" | "HOST_ARGS_TOO_LARGE"
  | "HOST_RESULT_TOO_LARGE" | "PLUGIN_ERROR";

export class NowenPluginError extends Error {
  constructor(message: string, readonly code: NowenPluginErrorCode = "PLUGIN_ERROR") {
    super(message);
    this.name = "NowenPluginError";
  }
}

/** 编译期保留完整类型，运行时原样返回，不夹带业务实现或凭证。 */
export function definePlugin<T extends NowenPluginDefinition>(plugin: T): T { return plugin; }

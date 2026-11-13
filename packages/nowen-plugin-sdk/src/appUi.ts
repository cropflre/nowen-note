import type { NowenHostApi } from "./hostApi.generated.js";
export interface PluginInspectorResource { type: "note" | "task" | "attachment"; id: string }
export interface PluginInspectorMetadata extends PluginInspectorResource {
  title: string; createdAt: string; updatedAt?: string;
  contentFormat?: string; characterCount?: number; version?: number;
  status?: string; priority?: number; dueDate?: string | null;
  noteId?: string; mimeType?: string; size?: number;
}
/** Injected only inside an isolated V3 app frame. Never includes host credentials. */
export interface PluginAppClient {
  readonly ready: Promise<void>;
  call(method: "context.get", params?: Record<string, never>): Promise<{ protocol: "nowen.plugin-ui.v3"; methods: readonly string[]; workspaceId: string | null; platform: string; theme: "light" | "dark"; selection?: PluginInspectorResource }>;
  call(method: "inspector.getResource", params?: Record<string, never>): Promise<PluginInspectorMetadata>;
  call(method: "storage.get", params: { key: string }): Promise<unknown>;
  call(method: "storage.set", params: { key: string; value: unknown }): Promise<{ success: true }>;
  call(method: "storage.delete", params: { key: string }): Promise<{ success: true }>;
  call<M extends Exclude<keyof NowenHostApi["data"], "export" | "import">>(method: `data.${M}`, ...params: Parameters<NowenHostApi["data"][M]>): ReturnType<NowenHostApi["data"][M]>;
  call(method: "notes.list" | "tasks.list", params?: Record<string, never>): Promise<Array<{ id: string; title: string; updatedAt: string; status?: string }>>;
  call(method: "navigation.open", params: { target: "all" | "favorites" | "files" | "diary" | "tasks" | "mindmaps" | "ai-chat" | "shares"; noteId?: string }): Promise<{ target: string; noteId?: string }>;
  on(name: "theme.changed" | "visibility.changed" | "destroy", listener: (data: { theme?: "light" | "dark"; visible?: boolean }) => void): () => void;
}
export function getPluginAppClient(): PluginAppClient {
  const client = (globalThis as typeof globalThis & { NowenApp?: PluginAppClient }).NowenApp;
  if (!client) throw new Error("A compatible Nowen V3 app frame is required");
  return client;
}

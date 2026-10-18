import type { NowenHostApi } from "./hostApi.generated.js";
/** Injected only inside an isolated V3 app frame. Never includes host credentials. */
export interface PluginAppClient {
  readonly ready: Promise<void>;
  call(method: "context.get", params?: Record<string, never>): Promise<{ protocol: "nowen.plugin-ui.v3"; methods: readonly string[]; workspaceId: string | null; platform: string; theme: "light" | "dark" }>;
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

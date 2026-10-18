// 此文件由 scripts/generate-plugin-host-api.mjs 根据 packages/nowen-plugin-sdk/host-api-contract.json 生成，请勿手动修改。
import type { Attachment, DiaryEntry, Mindmap, Note, Notebook, NoteSummary, Tag, Task } from "./index.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export type PluginHostRuntime = "node-action" | "sandbox-js";
export type HostApiPermission = "attachments:read" | "capture:write" | "diary:read" | "diary:write" | "external:fetch" | "mindmaps:read" | "mindmaps:write" | "notebooks:read" | "notebooks:write" | "notes:read" | "notes:write" | "plugin-storage:read" | "plugin-storage:write" | "secrets:use" | "tags:read" | "tags:write" | "tasks:read" | "tasks:write";
export type HostApiMethod = "attachments.get" | "attachments.inspect" | "attachments.list" | "capture.importUrl" | "data.delete" | "data.export" | "data.get" | "data.import" | "data.migrate" | "data.put" | "data.query" | "data.restore" | "diary.create" | "diary.get" | "diary.list" | "external.fetch" | "mindmaps.create" | "mindmaps.get" | "mindmaps.list" | "mindmaps.update" | "notebooks.create" | "notebooks.get" | "notebooks.list" | "notes.create" | "notes.get" | "notes.inspect" | "notes.list" | "notes.update" | "runtime.capabilities" | "secrets.crypt" | "secrets.digest" | "settings.get" | "storage.delete" | "storage.get" | "storage.set" | "tags.addToNote" | "tags.create" | "tags.list" | "tags.removeFromNote" | "tasks.create" | "tasks.get" | "tasks.inspect" | "tasks.list" | "tasks.update";

export interface HostApiContractEntry {
  method: HostApiMethod;
  sinceApiVersion: 1 | 2 | 3;
  permission: HostApiPermission | null;
  runtimes: readonly PluginHostRuntime[];
  maxArgsBytes: number;
  maxResultBytes: number;
}

export interface HostApiBudgets {
  readonly ipcMessageBytes: number;
  readonly hostCallArgsBytes: number;
  readonly hostCallResultBytes: number;
}

export const HOST_API_CONTRACT_VERSION = 6 as const;
export const HOST_API_BUDGETS: HostApiBudgets = deepFreeze({
  "ipcMessageBytes": 2097152,
  "hostCallArgsBytes": 262144,
  "hostCallResultBytes": 1048576
});
export const HOST_API_CONTRACT: readonly HostApiContractEntry[] = deepFreeze([
  {
    "method": "attachments.get",
    "sinceApiVersion": 1,
    "permission": "attachments:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "attachments.inspect",
    "sinceApiVersion": 3,
    "permission": "attachments:read",
    "runtimes": [
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "attachments.list",
    "sinceApiVersion": 1,
    "permission": "attachments:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "capture.importUrl",
    "sinceApiVersion": 2,
    "permission": "capture:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "data.delete",
    "sinceApiVersion": 3,
    "permission": "plugin-storage:write",
    "runtimes": [
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "data.export",
    "sinceApiVersion": 3,
    "permission": "plugin-storage:read",
    "runtimes": [
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "data.get",
    "sinceApiVersion": 3,
    "permission": "plugin-storage:read",
    "runtimes": [
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "data.import",
    "sinceApiVersion": 3,
    "permission": "plugin-storage:write",
    "runtimes": [
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "data.migrate",
    "sinceApiVersion": 3,
    "permission": "plugin-storage:write",
    "runtimes": [
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "data.put",
    "sinceApiVersion": 3,
    "permission": "plugin-storage:write",
    "runtimes": [
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "data.query",
    "sinceApiVersion": 3,
    "permission": "plugin-storage:read",
    "runtimes": [
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "data.restore",
    "sinceApiVersion": 3,
    "permission": "plugin-storage:write",
    "runtimes": [
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "diary.create",
    "sinceApiVersion": 1,
    "permission": "diary:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "diary.get",
    "sinceApiVersion": 1,
    "permission": "diary:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "diary.list",
    "sinceApiVersion": 1,
    "permission": "diary:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "external.fetch",
    "sinceApiVersion": 1,
    "permission": "external:fetch",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "mindmaps.create",
    "sinceApiVersion": 1,
    "permission": "mindmaps:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "mindmaps.get",
    "sinceApiVersion": 1,
    "permission": "mindmaps:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "mindmaps.list",
    "sinceApiVersion": 1,
    "permission": "mindmaps:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "mindmaps.update",
    "sinceApiVersion": 1,
    "permission": "mindmaps:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notebooks.create",
    "sinceApiVersion": 1,
    "permission": "notebooks:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notebooks.get",
    "sinceApiVersion": 1,
    "permission": "notebooks:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notebooks.list",
    "sinceApiVersion": 1,
    "permission": "notebooks:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notes.create",
    "sinceApiVersion": 1,
    "permission": "notes:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notes.get",
    "sinceApiVersion": 1,
    "permission": "notes:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notes.inspect",
    "sinceApiVersion": 3,
    "permission": "notes:read",
    "runtimes": [
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notes.list",
    "sinceApiVersion": 1,
    "permission": "notes:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notes.update",
    "sinceApiVersion": 1,
    "permission": "notes:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "runtime.capabilities",
    "sinceApiVersion": 1,
    "permission": null,
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "secrets.crypt",
    "sinceApiVersion": 2,
    "permission": "secrets:use",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "secrets.digest",
    "sinceApiVersion": 2,
    "permission": "secrets:use",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "settings.get",
    "sinceApiVersion": 2,
    "permission": null,
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "storage.delete",
    "sinceApiVersion": 1,
    "permission": "plugin-storage:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "storage.get",
    "sinceApiVersion": 1,
    "permission": "plugin-storage:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "storage.set",
    "sinceApiVersion": 1,
    "permission": "plugin-storage:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tags.addToNote",
    "sinceApiVersion": 1,
    "permission": "tags:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tags.create",
    "sinceApiVersion": 1,
    "permission": "tags:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tags.list",
    "sinceApiVersion": 1,
    "permission": "tags:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tags.removeFromNote",
    "sinceApiVersion": 1,
    "permission": "tags:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tasks.create",
    "sinceApiVersion": 1,
    "permission": "tasks:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tasks.get",
    "sinceApiVersion": 1,
    "permission": "tasks:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tasks.inspect",
    "sinceApiVersion": 3,
    "permission": "tasks:read",
    "runtimes": [
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tasks.list",
    "sinceApiVersion": 1,
    "permission": "tasks:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tasks.update",
    "sinceApiVersion": 1,
    "permission": "tasks:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  }
]);

export interface RuntimeCapabilities {
  apiVersion: number;
  runtime: PluginHostRuntime;
  platform: "server" | "desktop-full";
  contractVersion: number;
  budgets: HostApiBudgets;
  methods: readonly HostApiContractEntry[];
  hostApis: string[];
  notes?: { read: number; write: number };
  notebooks?: { read: number; write: number };
  tasks?: { read: number; write: number };
  automation?: number;
  workspace?: number;
  declarativeContributions?: number;
}

export interface NotesApi {
  create(input: { notebookId: string; title?: string; content?: string; contentFormat?: "markdown" | "html" | "tiptap-json" }): Promise<{ id: string; version?: number }>;
  get(input: { noteId: string }): Promise<Note | null>;
  inspect(input: { id: string }): Promise<Record<string, unknown>>;
  list(input?: { limit?: number }): Promise<NoteSummary[]>;
  update(input: { noteId: string; title?: string; content?: string; contentFormat?: "markdown" | "html" | "tiptap-json" }): Promise<{ id: string; version: number }>;
}

export interface NotebooksApi {
  create(input: { name: string; workspaceId?: string | null; parentId?: string | null; icon?: string; color?: string | null }): Promise<{ id: string }>;
  get(input: { notebookId: string }): Promise<Notebook | null>;
  list(): Promise<Notebook[]>;
}

export interface TagsApi {
  addToNote(input: { noteId: string; tagId: string }): Promise<{ success: true }>;
  create(input: { name: string; color?: string; workspaceId?: string | null }): Promise<{ id: string }>;
  list(): Promise<Tag[]>;
  removeFromNote(input: { noteId: string; tagId: string }): Promise<{ success: true }>;
}

export interface TasksApi {
  create(input: { title: string; workspaceId?: string | null; description?: string; priority?: number; dueDate?: string | null; noteId?: string | null }): Promise<{ id: string }>;
  get(input: { taskId: string }): Promise<Task>;
  inspect(input: { id: string }): Promise<Record<string, unknown>>;
  list(input?: { limit?: number }): Promise<Task[]>;
  update(input: { taskId: string; title?: string; description?: string; isCompleted?: boolean; priority?: number; dueDate?: string | null }): Promise<{ id: string }>;
}

export interface AttachmentsApi {
  get(input: { attachmentId: string }): Promise<Attachment>;
  inspect(input: { id: string }): Promise<Record<string, unknown>>;
  list(input?: { limit?: number }): Promise<Attachment[]>;
}

export interface DiaryApi {
  create(input: { workspaceId?: string | null; contentText: string; mood?: string; createdAt?: string }): Promise<{ id: string }>;
  get(input: { diaryId: string }): Promise<DiaryEntry>;
  list(input?: { limit?: number }): Promise<DiaryEntry[]>;
}

export interface MindmapsApi {
  create(input: { workspaceId?: string | null; title?: string; data?: unknown }): Promise<{ id: string }>;
  get(input: { mindmapId: string }): Promise<Mindmap>;
  list(input?: { limit?: number }): Promise<Mindmap[]>;
  update(input: { mindmapId: string; title?: string; data?: unknown }): Promise<{ id: string }>;
}

export interface StorageApi {
  delete(input: { key: string; scopeType?: "user" | "workspace"; scopeId?: string }): Promise<{ success: true }>;
  get(input: { key: string; scopeType?: "user" | "workspace"; scopeId?: string }): Promise<unknown>;
  set(input: { key: string; value: unknown; scopeType?: "user" | "workspace"; scopeId?: string }): Promise<{ success: true }>;
}

export interface PluginDataApi {
  delete(input: { collection: string; id: string; schemaVersion: number; expectedRevision: number }): Promise<{ success: true }>;
  export(): Promise<{ format: 1; pluginId: string; digest: string; entries: Array<{ key: string; value: unknown }> }>;
  get(input: { collection: string; id: string }): Promise<{ schemaVersion: number; revision: number; item: { id: string; value: Record<string, unknown>; revision: number; updatedAt: string } | null }>;
  import(input: { expectedDigest: string; snapshot: { format: 1; pluginId: string; digest: string; entries: Array<{ key: string; value: unknown }> } }): Promise<{ success: true; digest: string }>;
  migrate(input: { collection: string; expectedRevision: number; fromVersion: number; toVersion: number; defaults: Record<string, unknown> }): Promise<{ schemaVersion: number; revision: number; total: number; items: unknown[] }>;
  put(input: { collection: string; id: string; value: Record<string, unknown>; schemaVersion: number; expectedRevision: number }): Promise<{ id: string; value: Record<string, unknown>; revision: number; updatedAt: string }>;
  query(input: { collection: string; where?: Record<string, string | number | boolean | null>; orderBy?: string; descending?: boolean; offset?: number; limit?: number }): Promise<{ schemaVersion: number; revision: number; total: number; items: Array<{ id: string; value: Record<string, unknown>; revision: number; updatedAt: string }> }>;
  restore(input: { collection: string; expectedRevision: number }): Promise<{ schemaVersion: number; revision: number; total: number; items: unknown[] }>;
}

export interface ExternalApi {
  fetch(input: { url: string; method?: string; headers?: Record<string, string>; body?: unknown; connection?: string }): Promise<{ status: number; ok: boolean; headers: { "content-type": string | null }; body: string }>;
}

export interface RuntimeApi {
  capabilities(): Promise<RuntimeCapabilities>;
}

export interface CaptureApi {
  importUrl(input: { url: string; notebookId: string; tags?: string[]; comment?: string }): Promise<{ id: string; title: string; imagesImported: number; imagesSkipped: number }>;
}

export interface SettingsApi {
  get(): Promise<Record<string, unknown>>;
}

export interface SecretsApi {
  crypt(input: { connection: string; operation: "encrypt" | "decrypt"; data: string }): Promise<string>;
  digest(input: { connection: string; algorithm: "sha1" | "sha256"; parts: string[]; sort?: boolean }): Promise<string>;
}

export interface PluginProgress { current?: number; total?: number; message?: string }
export type PluginProgressCallback = (input: PluginProgress) => void;

export interface NowenHostApi {
  notes: NotesApi;
  notebooks: NotebooksApi;
  tags: TagsApi;
  tasks: TasksApi;
  attachments: AttachmentsApi;
  diary: DiaryApi;
  mindmaps: MindmapsApi;
  storage: StorageApi;
  data: PluginDataApi;
  external: ExternalApi;
  runtime: RuntimeApi;
  capture: CaptureApi;
  settings: SettingsApi;
  secrets: SecretsApi;
  progress: PluginProgressCallback;
}

import type { Note, NoteListItem, Notebook, Tag } from "@/types";

/**
 * LocalRepository 抽象层（Phase 10）。
 *
 * 为什么先做抽象、不直接换存储：
 *
 * 当前的 localStore.ts 是 **Remote-first + Offline Cache**——
 * IndexedDB 里的 schema 名字就叫 NowenCacheSchema，offlineRead.ts 的
 * withFallback() 也是"先请求服务器，失败才读本地"。
 * 把它改个名字宣布成 Local-first 是自欺欺人：权威数据仍在远端，
 * 断网时能读到什么完全取决于之前缓存过什么。
 *
 * 真正的改造顺序应该是：
 *   1. UI 依赖 Repository 接口（本文件）
 *   2. 底层实现从 Cache 换成真正的本地数据库
 *   3. Sync Engine 负责与远端对账
 *
 * 先做第 1 步的好处是：换底层时 UI 一行不用改，
 * 而且可以逐模块灰度，不必一次性重构整个前端。
 *
 * 关于移动端存储方案：**刻意不在此引入任何新依赖**。
 * Capacitor 的 SQLite 插件需要改原生工程与构建配置，
 * 必须结合项目当前的 Capacitor 版本真实评估后再定，
 * 不能为了让方案文档好看就先把库加进来。
 */

// ---------------------------------------------------------------------------
// 查询条件
// ---------------------------------------------------------------------------

export interface NoteQuery {
  notebookId?: string;
  tagId?: string;
  /** 全文关键词；实现方可退化为标题匹配。 */
  keyword?: string;
  includeTrashed?: boolean;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface WriteResult {
  id: string;
  /** 本地写入完成的时刻。语义是"已保存"，与是否同步无关。 */
  savedAt: string;
}

// ---------------------------------------------------------------------------
// 仓储接口
// ---------------------------------------------------------------------------

export interface NoteRepository {
  list(query?: NoteQuery): Promise<NoteListItem[]>;
  get(id: string): Promise<Note | null>;
  /**
   * 创建笔记。
   *
   * id 由**调用方**生成（稳定 UUID），不依赖服务器分配——
   * 否则离线状态下无法创建笔记。
   */
  create(input: Partial<Note> & { id: string }): Promise<WriteResult>;
  update(id: string, patch: Partial<Note>): Promise<WriteResult>;
  remove(id: string): Promise<void>;
}

export interface NotebookRepository {
  list(): Promise<Notebook[]>;
  get(id: string): Promise<Notebook | null>;
  create(input: Partial<Notebook> & { id: string }): Promise<WriteResult>;
  update(id: string, patch: Partial<Notebook>): Promise<WriteResult>;
  remove(id: string): Promise<void>;
}

export interface TagRepository {
  list(): Promise<Tag[]>;
  create(input: Partial<Tag> & { id: string }): Promise<WriteResult>;
  update(id: string, patch: Partial<Tag>): Promise<WriteResult>;
  remove(id: string): Promise<void>;
  attach(noteId: string, tagId: string): Promise<void>;
  detach(noteId: string, tagId: string): Promise<void>;
}

export interface LocalAttachmentRecord {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  /** 本地是否已有二进制。false 表示远端有但还没下载完。 */
  available: boolean;
}

export interface AttachmentRepository {
  listByNote(noteId: string): Promise<LocalAttachmentRecord[]>;
  /**
   * 保存附件。
   *
   * 关键语义：**立即返回 attachmentId**，不等远端上传。
   * 笔记引用这个 id 就能立刻显示图片；上传是后台的事。
   */
  save(input: {
    id: string;
    noteId: string;
    filename: string;
    mimeType: string;
    blob: Blob;
  }): Promise<LocalAttachmentRecord>;
  /** 取得可用于渲染的 URL（本地 blob 或签名地址）。 */
  resolveUrl(id: string): Promise<string | null>;
  remove(id: string): Promise<void>;
}

export type SyncStateView =
  | { mode: "device-only" }
  | {
    mode: "server";
    pendingMutations: number;
    conflictCount: number;
    lastError: string | null;
  };

export interface SyncRepository {
  /** 当前同步状态；仅用于展示，不影响读写路径。 */
  getState(): Promise<SyncStateView>;
  /** 请求立即同步一次；未开启同步时为空操作。 */
  requestSync(): Promise<void>;
}

/**
 * 统一门面。
 *
 * UI 只依赖这个接口。底层可以是：
 * - 当前的 IndexedDB Cache（过渡实现）
 * - 桌面端的 Local HTTP API → Embedded Backend → SQLite
 * - 未来移动端的 Native 本地数据库
 *
 * 三者对 UI 完全等价。
 */
export interface LocalRepository {
  notes: NoteRepository;
  notebooks: NotebookRepository;
  tags: TagRepository;
  attachments: AttachmentRepository;
  sync: SyncRepository;
}

// ---------------------------------------------------------------------------
// 运行时注册
// ---------------------------------------------------------------------------

let current: LocalRepository | null = null;

/**
 * 注册实现。
 *
 * 由平台入口在启动时调用一次（桌面端注册 HTTP 实现，
 * 移动端将来注册 Native 实现）。
 */
export function setLocalRepository(repository: LocalRepository | null): void {
  current = repository;
}

/**
 * 取得当前实现。
 *
 * 返回 null 而非抛错：改造是逐模块进行的，
 * 尚未迁移的模块继续走原有 api 路径，不应因为 Repository 未注册而崩溃。
 */
export function getLocalRepository(): LocalRepository | null {
  return current;
}

/**
 * 是否已启用 Repository 路径。
 *
 * 调用方据此在"新路径"与"既有 api 路径"之间选择，
 * 从而实现逐模块灰度而不是一次性大爆炸式切换。
 */
export function isLocalRepositoryReady(): boolean {
  return current !== null;
}

/** 生成稳定 UUID：离线创建不依赖服务器分配 ID。 */
export function newLocalId(): string {
  const cryptoApi = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  // 兜底实现：老 WebView 可能没有 randomUUID。
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

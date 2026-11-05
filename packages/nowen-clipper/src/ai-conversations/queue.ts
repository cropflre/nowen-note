import type { ArchiveReceipt, CaptureGrant, IngestPayload } from "./types";

export const AI_STORAGE_KEY = "nowenAIArchiveV1";
export const MAX_PENDING = 40;
export const MAX_QUEUE_BYTES = 3 * 1024 * 1024;
export const MAX_RETRIES = 8;
export const RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export interface PendingArchive {
  id: string;
  grantKey: string;
  scope: string;
  payload: IngestPayload;
  queuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  blocked?: string;
  started?: boolean;
}
export interface AIArchiveState { grants: Record<string, CaptureGrant>; queue: PendingArchive[] }
export const emptyAIState = (): AIArchiveState => ({ grants: {}, queue: [] });

/** Case-sensitive server paths remain part of the destination identity. */
export function archiveScope(config: { serverUrl: string; userId: string }): string {
  const url = new URL(config.serverUrl.replace(/\/+$/, ""));
  if (!["http:", "https:"].includes(url.protocol) || !config.userId) throw new Error("请先重新登录 Nowen Note，确认当前账号身份。");
  return JSON.stringify([url.href.replace(/\/+$/, ""), config.userId]);
}
export function grantKey(scope: string, provider: string, conversationId: string): string {
  return JSON.stringify([scope, provider, conversationId]);
}
export function enqueueArchive(state: AIArchiveState, item: PendingArchive): void {
  // A request that may have reached the server is immutable. Only an unsent successor can coalesce.
  const last = [...state.queue].reverse().find((entry) => entry.grantKey === item.grantKey && !entry.started
    && entry.payload.snapshot.messages.every((old) => item.payload.snapshot.messages.some((next) => next.externalMessageId === old.externalMessageId
      && next.role === old.role && next.contentHash === old.contentHash && next.captureState === old.captureState)));
  const next = state.queue.filter((entry) => entry !== last);
  if (last) item.payload.expectedRevision = last.payload.expectedRevision;
  if (next.some((entry) => entry.grantKey === item.grantKey)) item.payload.expectedRevision = -1;
  next.push(item);
  if (next.length > MAX_PENDING || new TextEncoder().encode(JSON.stringify(next)).length > MAX_QUEUE_BYTES) throw new Error("AI_SYNC_QUEUE_FULL：本地暂存已满，现有内容仍保留。请处理待同步项或清空后再保存。");
  state.queue = next;
}
export function validateReceipt(value: unknown, item: PendingArchive): value is ArchiveReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as ArchiveReceipt;
  return receipt.persisted === true && receipt.operationId === item.payload.operationId
    && receipt.sourceId === item.payload.sourceId && ["applied", "duplicate"].includes(receipt.status)
    && typeof receipt.conversationId === "string" && !!receipt.conversationId
    && typeof receipt.noteId === "string" && !!receipt.noteId
    && ["updated", "conflict"].includes(receipt.projectionStatus)
    && Number.isSafeInteger(receipt.revision) && receipt.revision >= 1
    && typeof receipt.persistedAt === "string" && Number.isFinite(Date.parse(receipt.persistedAt));
}
export function failPending(item: PendingArchive, status: number | undefined, message: string, now = Date.now()): void {
  item.attempts += 1;
  item.nextAttemptAt = now + Math.min(3_600_000, 30_000 * 2 ** Math.min(item.attempts - 1, 7));
  const terminal = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
  if (terminal || item.attempts >= MAX_RETRIES || now - item.queuedAt >= RETRY_WINDOW_MS) item.blocked = message;
}
export function acknowledgeArchive(state: AIArchiveState, item: PendingArchive, receipt: ArchiveReceipt): void {
  if (!validateReceipt(receipt, item)) throw new Error("AI_SYNC_RECEIPT_INVALID：服务端未返回对应操作的持久化回执，内容仍保留在本地。");
  const grant = state.grants[item.grantKey];
  if (!grant || grant.scope !== item.scope || grant.source.id !== receipt.sourceId
    || grant.source.accountScope !== item.payload.snapshot.accountScope) throw new Error("AI_CONTEXT_SCOPE_DENIED：保存来源已变化。");
  grant.revision = receipt.revision;
  grant.receipt = receipt;
  grant.error = receipt.projectionStatus === "conflict" ? "归档已保存，但笔记被手动修改，未覆盖笔记正文。" : undefined;
  state.queue = state.queue.filter((entry) => entry.id !== item.id);
}

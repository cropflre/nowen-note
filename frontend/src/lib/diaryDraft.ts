/**
 * 说说草稿本地存储（localStorage）
 * ---------------------------------------------------------------------------
 * 按 workspace 隔离，key 格式：nowen:diary:draft:<workspaceId>
 * 草稿有效期 20h（后端孤儿附件 24h 清理，留 4h 余量）。
 */

import { getCurrentWorkspace } from "@/lib/api";

export interface DiaryDraftMedia {
  id: string;
  type: "image" | "video";
  mimeType?: string;
}

export interface DiaryDraftPayload {
  version: 1;
  workspaceId: string;
  text: string;
  mood: string;
  media: DiaryDraftMedia[];
  updatedAt: number;
}

const DIARY_DRAFT_VERSION = 1;
export const DIARY_DRAFT_TTL_MS = 20 * 60 * 60 * 1000; // 20h

function draftKey(workspaceId: string): string {
  return `nowen:diary:draft:${workspaceId}`;
}

export function getCurrentDraftKey(): string {
  const ws = getCurrentWorkspace();
  return draftKey(ws && ws !== "personal" ? ws : "personal");
}

export function saveDiaryDraft(payload: DiaryDraftPayload): void {
  try {
    localStorage.setItem(getCurrentDraftKey(), JSON.stringify(payload));
  } catch {
    /* quota exceeded 等情况静默失败 */
  }
}

export function loadDiaryDraft(): DiaryDraftPayload | null {
  try {
    const raw = localStorage.getItem(getCurrentDraftKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DiaryDraftPayload;
    if (parsed.version !== DIARY_DRAFT_VERSION) return null;
    // 过期检查
    if (Date.now() - parsed.updatedAt > DIARY_DRAFT_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDiaryDraft(): void {
  try {
    localStorage.removeItem(getCurrentDraftKey());
  } catch {
    /* ignore */
  }
}

export function isDiaryDraftExpired(draft: DiaryDraftPayload): boolean {
  return Date.now() - draft.updatedAt > DIARY_DRAFT_TTL_MS;
}

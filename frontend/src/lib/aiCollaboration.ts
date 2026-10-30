import { api, getBaseUrl, getCurrentWorkspace } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { fetchWithAuthRefresh, getAccessToken } from "@/lib/authSession";
import { newLocalId } from "@/lib/localRepository";
import type { Note } from "@/types";

export const OPEN_AI_COLLABORATION = "nowen:open-ai-collaboration";
export function openAICollaboration(): void { window.dispatchEvent(new Event(OPEN_AI_COLLABORATION)); }
export function collaborationScope(): string { return `${getOfflineQueueStorageKey()}:${getCurrentWorkspace()}`; }
export function collaborationDraftKey(scope: string): string { return `nowen-ai-collaboration:v1:${scope}`; }

export type SkillRequest = { kind: "personal"; id: string } | { kind: "note"; id: string; notebookId: string }
  | { kind: "prompt"; name: string; prompt: string };
export interface CollaborationResult { content: string; references: Array<{ id: string; title: string }>; truncated: boolean; skillName: string }
export interface FolderSkill { id: string; name: string; notebookId: string }
export interface SaveRequest { id: string; notebookId: string; title: string; content: string; contentFormat: "markdown" }
export interface CollaborationDraft {
  input: string; output: string; title: string; intent: "capture" | "draft";
  projectId: string; targetId: string; libraryId: string; skillKey: string;
  references: CollaborationResult["references"]; truncated: boolean; saveRequest: SaveRequest | null;
}
export function emptyCollaborationDraft(): CollaborationDraft {
  return { input: "", output: "", title: "", intent: "capture", projectId: "", targetId: "", libraryId: "",
    skillKey: "auto", references: [], truncated: false, saveRequest: null };
}
export function readCollaborationDraft(scope: string): CollaborationDraft {
  const raw = localStorage.getItem(collaborationDraftKey(scope));
  if (!raw) return emptyCollaborationDraft();
  const value = JSON.parse(raw) as CollaborationDraft;
  if (!value || ["input", "output", "title", "projectId", "targetId", "libraryId", "skillKey"].some(key => typeof value[key as keyof CollaborationDraft] !== "string")
    || !["capture", "draft"].includes(value.intent) || !Array.isArray(value.references)
    || value.references.some(ref => !ref || typeof ref.id !== "string" || typeof ref.title !== "string")
    || (value.saveRequest !== null && (!value.saveRequest || ["id", "notebookId", "title", "content"].some(key => typeof value.saveRequest![key as keyof SaveRequest] !== "string") || value.saveRequest.contentFormat !== "markdown"))) throw new Error("Invalid AI draft");
  return value;
}

export function suggestSkills<T extends { key: string; name: string }>(input: string, skills: T[]): T[] {
  const normalized = input.normalize("NFKC").toLocaleLowerCase();
  if (!normalized.trim()) return [];
  return skills.map(skill => {
    const title = skill.name.normalize("NFKC").toLocaleLowerCase();
    const words = title.match(/[a-z0-9]{3,}|[\u3400-\u9fff]{2,}/g) || [];
    const tokens = new Set(words.flatMap(word => /[\u3400-\u9fff]/.test(word)
      ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]));
    const score = title.length >= 2 && normalized.includes(title) ? 100
      : [...tokens].filter(token => normalized.includes(token)).length;
    return { skill, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, 3).map(item => item.skill);
}

export async function collaborationRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const expectedScope = collaborationScope();
  const guardedFetch: typeof fetch = (input, init) => {
    if (collaborationScope() !== expectedScope) throw new Error("AI_COLLABORATION_SCOPE_CHANGED");
    return fetch(input, init);
  };
  const base = getBaseUrl();
  const ws = getCurrentWorkspace();
  const query = new URLSearchParams();
  if (ws && ws !== "personal") query.set("workspaceId", ws);
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetchWithAuthRefresh(`${base}/user-preferences/ai-reliable/collaboration/${path}${query.size ? separator + query : ""}`, {
    method: body === undefined ? "GET" : "POST", signal,
    headers: { "Content-Type": "application/json", ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, base, guardedFetch);
  if (collaborationScope() !== expectedScope) throw new Error("AI_COLLABORATION_SCOPE_CHANGED");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result as T;
}

export function makeCollaborationSave(draft: CollaborationDraft, originalLabel: string, referencesLabel: string, raw = false): SaveRequest {
  const content = raw ? draft.input : draft.output;
  if (!content.trim() || !draft.targetId) throw new Error("Missing content or destination");
  const sourceList = !raw && draft.references.length
    ? `\n\n## ${referencesLabel}\n\n${draft.references.map(ref => `- [${ref.title.replace(/[[\]\\]/g, "\\$&")}](/notes/${encodeURIComponent(ref.id)})`).join("\n")}` : "";
  return { id: newLocalId(), notebookId: draft.targetId,
    title: (draft.title.trim() || content.split("\n").find(line => line.trim())?.replace(/^#+\s*/, "") || "Note").slice(0, 120),
    content: raw ? content : `${content}\n\n---\n\n## ${originalLabel}\n\n${draft.input}${sourceList}`, contentFormat: "markdown" };
}

/** Reuse the normal API (including Native / Web offline adapters). A lost response
 * is retried with the same note ID and accepted only if the exact payload exists. */
export async function saveCollaborationNote(request: SaveRequest, scope: string): Promise<Note> {
  if (collaborationScope() !== scope) throw new Error("AI_COLLABORATION_SCOPE_CHANGED");
  try {
    const note = await api.createNote(request);
    if (collaborationScope() !== scope) throw new Error("AI_COLLABORATION_SCOPE_CHANGED");
    return note;
  } catch (error) {
    if (collaborationScope() !== scope) throw new Error("AI_COLLABORATION_SCOPE_CHANGED");
    try {
      const note = await api.getNote(request.id);
      if (collaborationScope() === scope && note.id === request.id && note.notebookId === request.notebookId
        && note.content === request.content && note.title === request.title && note.contentFormat === request.contentFormat) return note;
    } catch { /* Keep the original failure and the durable retry payload. */ }
    throw error;
  }
}

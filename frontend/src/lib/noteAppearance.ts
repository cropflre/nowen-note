import { getBaseUrl } from "@/lib/api.impl";
import { fetchWithAuthRefresh, getAccessToken } from "@/lib/authSession";
import { isNoteThemeId, type NoteThemeId } from "@/lib/noteTheme";

export interface NoteAppearanceState {
  noteId: string;
  /** null = inherit account default; non-null = explicit per-note override. */
  themeId: string | null;
}

async function appearanceRequest<T>(noteId: string, init: RequestInit): Promise<T> {
  const baseUrl = getBaseUrl().replace(/\/+$/, "");
  const token = getAccessToken();
  const response = await fetchWithAuthRefresh(`${baseUrl}/note-appearance/${encodeURIComponent(noteId)}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  }, baseUrl);
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || `HTTP ${response.status}`);
  }
  return payload;
}

export async function getNoteAppearance(noteId: string): Promise<NoteAppearanceState> {
  return appearanceRequest(noteId, { method: "GET" });
}

export async function setNoteAppearance(
  noteId: string,
  themeId: NoteThemeId | null,
): Promise<NoteAppearanceState & { updated: boolean }> {
  if (themeId !== null && !isNoteThemeId(themeId)) throw new Error("未知笔记主题");
  return appearanceRequest(noteId, {
    method: "PUT",
    body: JSON.stringify({ themeId }),
  });
}

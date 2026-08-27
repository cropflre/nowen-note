import type { Note } from "@/types";
import { api, getBaseUrl } from "@/lib/api";
import { fetchWithAuthRefresh, getAccessToken } from "@/lib/authSession";
import { getAttachmentAccessUpstreamFetch } from "@/lib/attachmentAccessUpstreamFetch";
import { clearFolderUnlockTokens, folderUnlockRequestHeaders } from "@/lib/knowledgeTreePassword";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import { readNote } from "@/lib/offlineRead";

const INSTALL_KEY = "__NOWEN_NON_BLOCKING_NOTE_FETCH_V1__";

type ApiError = Error & {
  code?: string;
  status?: number;
  currentVersion?: number;
};

async function parseNoteResponse(response: Response): Promise<Note> {
  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    if (payload?.code === "FOLDER_UNLOCK_REQUIRED") clearFolderUnlockTokens();
    const error = new Error(
      typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`,
    ) as ApiError;
    error.code = payload?.code;
    error.status = response.status;
    if (typeof payload?.currentVersion === "number") error.currentVersion = payload.currentVersion;
    throw error;
  }
  return payload as Note;
}

async function fetchNoteDetailWithoutAttachmentBarrier(id: string): Promise<Note> {
  const token = getAccessToken();
  const baseUrl = getBaseUrl();
  const response = await fetchWithAuthRefresh(
    `${baseUrl}/notes/${encodeURIComponent(id)}`,
    {
      method: "GET",
      credentials: "include",
      headers: {
        "Accept": "application/vnd.nowen.internal-note+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...folderUnlockRequestHeaders(),
      },
    },
    baseUrl,
    getAttachmentAccessUpstreamFetch(),
  );
  return parseNoteResponse(response);
}

/**
 * Keep the global attachment bridge for media/download/share traffic, but let the canonical
 * `api.getNote()` detail request use the transport captured immediately before that bridge was
 * installed. This removes the bridge's `await accessPromise` from the critical text-render path.
 *
 * Offline fallback semantics stay identical to api.impl's getNote implementation via readNote().
 */
export function installNonBlockingNoteFetch(): void {
  if (typeof window === "undefined") return;
  const runtime = window as unknown as Record<string, unknown>;
  if (runtime[INSTALL_KEY]) return;
  runtime[INSTALL_KEY] = true;

  const legacyGetNote = api.getNote.bind(api);
  api.getNote = (async (id: string) => {
    if (isMobileLocalMode()) return legacyGetNote(id);

    return readNote(id, async () => {
      const note = await fetchNoteDetailWithoutAttachmentBarrier(id);
      // Preserve api.impl's online-detail cache side effect.
      void import("@/lib/syncEngine")
        .then((module) => module.cacheNoteContent(note))
        .catch(() => undefined);
      return note;
    });
  }) as typeof api.getNote;
}

export { fetchNoteDetailWithoutAttachmentBarrier };

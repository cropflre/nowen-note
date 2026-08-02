const DRAFT_KEY_PREFIX = "nowen-draft-";
const DRAFT_INDEX_KEY = "nowen-draft-index";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface NoteDraft {
  noteId: string;
  editorMode: "tiptap" | "md";
  content: string;
  contentText: string;
  title: string;
  /** Oldest server revision this exact local body was based on. */
  baseVersion: number;
  savedAt: number;
  /** A conflict must be explicitly resolved; later autosaves cannot silently clear it. */
  conflicted?: boolean;
  serverVersion?: number;
}

function getIndex(): string[] {
  try {
    const raw = localStorage.getItem(DRAFT_INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setIndex(noteIds: string[]): void {
  try {
    if (noteIds.length === 0) localStorage.removeItem(DRAFT_INDEX_KEY);
    else localStorage.setItem(DRAFT_INDEX_KEY, JSON.stringify(noteIds));
  } catch {
    /* storage unavailable */
  }
}

function addToIndex(noteId: string): void {
  const ids = getIndex();
  if (!ids.includes(noteId)) {
    ids.push(noteId);
    setIndex(ids);
  }
}

function removeFromIndex(noteId: string): void {
  setIndex(getIndex().filter((id) => id !== noteId));
}

function keyOf(noteId: string): string {
  return `${DRAFT_KEY_PREFIX}${noteId}`;
}

function readRawDraft(noteId: string): NoteDraft | null {
  try {
    const raw = localStorage.getItem(keyOf(noteId));
    return raw ? JSON.parse(raw) as NoteDraft : null;
  } catch {
    return null;
  }
}

function mergeDraft(previous: NoteDraft | null, incoming: NoteDraft): NoteDraft {
  if (!previous) return incoming;
  const sameBody =
    previous.content === incoming.content &&
    previous.contentText === incoming.contentText &&
    previous.title === incoming.title;
  if (!sameBody) return incoming;

  const attemptedRebase = incoming.baseVersion > previous.baseVersion;
  return {
    ...incoming,
    baseVersion: Math.min(previous.baseVersion, incoming.baseVersion),
    conflicted: previous.conflicted || incoming.conflicted || attemptedRebase || undefined,
    serverVersion: Math.max(
      previous.serverVersion || 0,
      incoming.serverVersion || 0,
      attemptedRebase ? incoming.baseVersion : 0,
    ) || undefined,
  };
}

export function saveDraft(draft: NoteDraft): void {
  if (!draft.noteId || draft.noteId.startsWith("local-")) return;
  const merged = mergeDraft(readRawDraft(draft.noteId), draft);
  try {
    localStorage.setItem(keyOf(draft.noteId), JSON.stringify(merged));
    addToIndex(draft.noteId);
  } catch (error) {
    try {
      pruneOldest();
      localStorage.setItem(keyOf(draft.noteId), JSON.stringify(merged));
      addToIndex(draft.noteId);
    } catch {
      console.warn("[draftStorage] saveDraft failed:", error);
    }
  }
}

export function loadDraft(noteId: string): NoteDraft | null {
  if (!noteId) return null;
  const draft = readRawDraft(noteId);
  if (!draft) return null;
  if (Date.now() - draft.savedAt > MAX_AGE_MS) {
    clearDraft(noteId);
    return null;
  }
  return draft;
}

export function clearDraft(noteId: string): void {
  try {
    localStorage.removeItem(keyOf(noteId));
    removeFromIndex(noteId);
  } catch {
    /* ignore */
  }
}

function pruneOldest(): void {
  const ids = getIndex();
  if (ids.length === 0) return;
  let oldestId = ids[0];
  let oldestAt = Number.MAX_SAFE_INTEGER;
  for (const id of ids) {
    const draft = loadDraft(id);
    if (draft && draft.savedAt < oldestAt) {
      oldestAt = draft.savedAt;
      oldestId = id;
    }
  }
  clearDraft(oldestId);
}

export function shouldOfferRestore(
  draft: NoteDraft,
  serverVersion: number,
  serverUpdatedAt: string | undefined,
  serverContent: string | undefined,
): boolean {
  if (!draft) return false;
  if (draft.conflicted) return true;
  if (draft.baseVersion > serverVersion) return false;

  // Content equality is authoritative. A server timestamp can be newer because
  // of clock skew, metadata-only edits, another device, or a delayed projection.
  // It must never suppress a local body that is observably different.
  if (typeof serverContent === "string") {
    return serverContent !== draft.content;
  }

  // Timestamp is only a fallback when the caller cannot provide server content.
  if (serverUpdatedAt) {
    const serverTs = new Date(serverUpdatedAt).getTime();
    if (!Number.isNaN(serverTs) && serverTs >= draft.savedAt) return false;
  }
  return true;
}

export function listDrafts(): NoteDraft[] {
  const drafts: NoteDraft[] = [];
  for (const id of getIndex()) {
    const draft = loadDraft(id);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

export function clearAllDrafts(): void {
  for (const id of getIndex()) {
    try { localStorage.removeItem(keyOf(id)); } catch { /* ignore */ }
  }
  setIndex([]);
}

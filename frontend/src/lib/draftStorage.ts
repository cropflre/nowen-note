import {
  reportTransientNoteImageSource,
  stabilizeNoteContentForPersistence,
} from "@/lib/noteContentPersistence";

const DRAFT_KEY_PREFIX = "nowen-draft-";
const DRAFT_INDEX_KEY = "nowen-draft-index";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A successful request may resolve while the editor already contains a newer debounce generation.
 * Keep the acknowledged draft briefly and delete it only if no newer local snapshot replaces it.
 */
export const ACKNOWLEDGED_DRAFT_CLEAR_GRACE_MS = 10_000;

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

export interface DraftAcknowledgement {
  noteId: string;
  title: string;
  content: string;
  contentText?: string;
  serverVersion: number;
  acknowledgedAt?: number;
}

const acknowledgements = new Map<string, Required<DraftAcknowledgement>>();
const pendingClearTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

function matchesAcknowledgement(
  draft: NoteDraft,
  acknowledgement: Required<DraftAcknowledgement>,
): boolean {
  // content + title are the authoritative user-authored body. contentText may be normalized by
  // the server/search projection and must not keep an otherwise confirmed draft forever.
  return draft.content === acknowledgement.content
    && draft.title === acknowledgement.title;
}

function cancelPendingClear(noteId: string): void {
  const timer = pendingClearTimers.get(noteId);
  if (timer !== undefined) clearTimeout(timer);
  pendingClearTimers.delete(noteId);
}

function removeDraftNow(noteId: string): void {
  cancelPendingClear(noteId);
  acknowledgements.delete(noteId);
  try {
    localStorage.removeItem(keyOf(noteId));
    removeFromIndex(noteId);
  } catch {
    /* ignore */
  }
}

export function saveDraft(draft: NoteDraft): void {
  if (!draft.noteId || draft.noteId.startsWith("local-")) return;
  let stableDraft = draft;
  try {
    const content = stabilizeNoteContentForPersistence(
      draft.content,
      draft.editorMode === "tiptap" ? "tiptap-json" : "markdown",
    );
    if (content !== draft.content) stableDraft = { ...draft, content };
  } catch (error) {
    reportTransientNoteImageSource(error, { operation: "saveDraft", noteId: draft.noteId });
    return;
  }
  // A new editor snapshot invalidates any delayed cleanup created by an older ACK.
  cancelPendingClear(stableDraft.noteId);
  const merged = mergeDraft(readRawDraft(stableDraft.noteId), stableDraft);
  try {
    localStorage.setItem(keyOf(stableDraft.noteId), JSON.stringify(merged));
    addToIndex(stableDraft.noteId);
  } catch (error) {
    try {
      pruneOldest();
      localStorage.setItem(keyOf(stableDraft.noteId), JSON.stringify(merged));
      addToIndex(stableDraft.noteId);
    } catch {
      console.warn("[draftStorage] saveDraft failed:", error);
    }
  }
}

/** Record the exact body that the server has durably acknowledged. */
export function markDraftAcknowledged(input: DraftAcknowledgement): void {
  if (!input.noteId || !Number.isFinite(input.serverVersion)) return;
  cancelPendingClear(input.noteId);
  acknowledgements.set(input.noteId, {
    ...input,
    contentText: input.contentText || "",
    acknowledgedAt: input.acknowledgedAt || Date.now(),
  });
}

export function loadDraft(noteId: string): NoteDraft | null {
  if (!noteId) return null;
  const draft = readRawDraft(noteId);
  if (!draft) return null;
  if (Date.now() - draft.savedAt > MAX_AGE_MS) {
    forceClearDraft(noteId);
    return null;
  }
  return draft;
}

/**
 * Clear a draft after save success without allowing an older response to delete newer local text.
 *
 * - Conflicted draft: explicit conflict resolution is the only allowed cleanup path.
 * - No ACK marker: preserve historical/manual cleanup behavior and delete immediately.
 * - ACK body differs from current draft: refuse cleanup; the draft is newer than the response.
 * - ACK body matches: delay deletion and re-check savedAt/body after the editor debounce window.
 */
export function clearDraft(noteId: string): boolean {
  const draft = readRawDraft(noteId);
  if (!draft) {
    removeDraftNow(noteId);
    return true;
  }

  if (draft.conflicted) return false;

  const acknowledgement = acknowledgements.get(noteId);
  if (!acknowledgement) {
    removeDraftNow(noteId);
    return true;
  }
  if (!matchesAcknowledgement(draft, acknowledgement)) {
    return false;
  }
  if (pendingClearTimers.has(noteId)) return true;

  const expectedSavedAt = draft.savedAt;
  const expectedVersion = acknowledgement.serverVersion;
  const timer = setTimeout(() => {
    pendingClearTimers.delete(noteId);
    const current = readRawDraft(noteId);
    const currentAcknowledgement = acknowledgements.get(noteId);
    if (!current || !currentAcknowledgement) return;
    if (current.savedAt !== expectedSavedAt) return;
    if (currentAcknowledgement.serverVersion !== expectedVersion) return;
    if (!matchesAcknowledgement(current, currentAcknowledgement)) return;
    removeDraftNow(noteId);
  }, ACKNOWLEDGED_DRAFT_CLEAR_GRACE_MS);
  pendingClearTimers.set(noteId, timer);
  return true;
}

/** Explicit user/system discard path. Never use this for an asynchronous save response. */
export function forceClearDraft(noteId: string): void {
  removeDraftNow(noteId);
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
  forceClearDraft(oldestId);
}

export function shouldOfferRestore(
  draft: NoteDraft,
  serverVersion: number,
  serverUpdatedAt: string | undefined,
  serverContent: string | undefined,
  serverTitle?: string,
): boolean {
  if (!draft) return false;
  if (draft.conflicted) return true;
  if (draft.baseVersion > serverVersion) return false;

  // Content equality is authoritative. A server timestamp can be newer because
  // of clock skew, metadata-only edits, another device, or a delayed projection.
  // It must never suppress a local body that is observably different.
  if (typeof serverContent === "string") {
    const sameBody = serverContent === draft.content;
    const sameTitle = serverTitle === undefined || serverTitle === draft.title;
    return !(sameBody && sameTitle);
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
  for (const id of getIndex()) forceClearDraft(id);
  for (const timer of pendingClearTimers.values()) clearTimeout(timer);
  pendingClearTimers.clear();
  acknowledgements.clear();
  setIndex([]);
}

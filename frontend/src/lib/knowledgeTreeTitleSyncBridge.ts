import { api } from "@/lib/api";

export const KNOWLEDGE_TREE_CHANGED_EVENT = "nowen:knowledge-tree-changed";

const INSTALL_FLAG = "__nowenKnowledgeTreeTitleSyncBridgeInstalled";

type AsyncApiMethod = (...args: any[]) => Promise<any>;

export interface KnowledgeTreeTitleSyncApi {
  [INSTALL_FLAG]?: boolean;
  getNote?: AsyncApiMethod;
  getNotes?: AsyncApiMethod;
  search?: AsyncApiMethod;
  createNote?: AsyncApiMethod;
  updateNote?: AsyncApiMethod;
}

interface ConfirmedNoteTitle {
  id: string;
  title: string;
  updatedAt?: string;
}

function readConfirmedNoteTitle(value: unknown, fallbackId = ""): ConfirmedNoteTitle | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : fallbackId;
  const title = typeof record.title === "string" ? record.title : null;
  if (!id || title === null) return null;
  return {
    id,
    title,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
  };
}

function rememberConfirmedTitles(value: unknown, titles: Map<string, string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => rememberConfirmedTitles(item, titles));
    return;
  }
  const note = readConfirmedNoteTitle(value);
  if (note) titles.set(note.id, note.title);
}

function emitKnowledgeTreeTitleChanged(note: ConfirmedNoteTitle): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_CHANGED_EVENT, {
    detail: {
      reason: "note-title-updated",
      resourceId: note.id,
      title: note.title,
      updatedAt: note.updatedAt,
    },
  }));
}

function wrapTitleRead(
  target: KnowledgeTreeTitleSyncApi,
  methodName: "getNote" | "getNotes" | "search" | "createNote",
  titles: Map<string, string>,
): void {
  const original = target[methodName];
  if (typeof original !== "function") return;

  target[methodName] = async (...args: any[]) => {
    const result = await original.apply(target, args);
    rememberConfirmedTitles(result, titles);
    return result;
  };
}

/**
 * Keeps the knowledge tree title in sync with successful note title saves.
 *
 * The tree owns an independent node cache and already listens for
 * `nowen:knowledge-tree-changed`. This bridge only emits that event when the
 * server-confirmed title actually changes, so normal content autosaves do not
 * reload the tree.
 */
export function installKnowledgeTreeTitleSyncBridge(
  target: KnowledgeTreeTitleSyncApi = api as unknown as KnowledgeTreeTitleSyncApi,
): void {
  if (target[INSTALL_FLAG]) return;
  target[INSTALL_FLAG] = true;

  const confirmedTitles = new Map<string, string>();
  wrapTitleRead(target, "getNote", confirmedTitles);
  wrapTitleRead(target, "getNotes", confirmedTitles);
  wrapTitleRead(target, "search", confirmedTitles);
  wrapTitleRead(target, "createNote", confirmedTitles);

  const originalUpdateNote = target.updateNote;
  if (typeof originalUpdateNote !== "function") return;

  target.updateNote = async (...args: any[]) => {
    const noteId = typeof args[0] === "string" ? args[0] : "";
    const previousTitle = noteId ? confirmedTitles.get(noteId) : undefined;

    const result = await originalUpdateNote.apply(target, args);
    const confirmed = readConfirmedNoteTitle(result, noteId);
    if (!confirmed) return result;

    confirmedTitles.set(confirmed.id, confirmed.title);
    if (previousTitle !== undefined && previousTitle !== confirmed.title) {
      emitKnowledgeTreeTitleChanged(confirmed);
    }

    return result;
  };
}

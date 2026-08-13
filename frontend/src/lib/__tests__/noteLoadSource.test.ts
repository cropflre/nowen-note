import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";

const localStore = vi.hoisted(() => ({
  getNote: vi.fn(),
  isNoteDetailCached: vi.fn(),
  putNote: vi.fn(),
}));
const attachmentRuntime = vi.hoisted(() => ({
  hasPersistentNoteAttachmentReference: vi.fn((content: string | null | undefined) =>
    typeof content === "string" && content.includes("/api/attachments/")),
  primeNoteAttachmentAccess: vi.fn(async () => 1),
}));

vi.mock("@/lib/localStore", () => ({
  getNote: localStore.getNote,
  isNoteDetailCached: localStore.isNoteDetailCached,
  putNote: localStore.putNote,
}));
vi.mock("@/lib/api", () => ({
  getBaseUrl: () => "https://notes.example.com/api",
}));
vi.mock("@/lib/noteAttachmentAccessPriming", () => attachmentRuntime);

import { canApplyRevalidatedNote, loadNoteCacheFirst } from "@/lib/noteLoadSource";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    userId: "user-1",
    notebookId: "book-1",
    title: "Cached title",
    content: "cached body",
    contentText: "cached body",
    contentFormat: "tiptap-json",
    version: 3,
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    sortOrder: 0,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  } as Note;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("canApplyRevalidatedNote", () => {
  const cached = makeNote();
  const remote = makeNote({
    version: 4,
    title: "Server title",
    content: "server body",
    contentText: "server body",
    updatedAt: "2026-07-20T01:00:00.000Z",
  });

  it("allows a newer server version when the visible note is still the untouched cache", () => {
    expect(canApplyRevalidatedNote({
      current: makeNote(),
      cached,
      remote,
      hasDraft: false,
      pendingNoteId: null,
    })).toBe(true);
  });

  it("blocks revalidation when a local draft or another switch exists", () => {
    expect(canApplyRevalidatedNote({ current: cached, cached, remote, hasDraft: true, pendingNoteId: null })).toBe(false);
    expect(canApplyRevalidatedNote({ current: cached, cached, remote, hasDraft: false, pendingNoteId: "note-2" })).toBe(false);
  });

  it("blocks revalidation after the visible content changed locally", () => {
    expect(canApplyRevalidatedNote({
      current: makeNote({ content: "local edit", contentText: "local edit" }),
      cached,
      remote,
      hasDraft: false,
      pendingNoteId: null,
    })).toBe(false);
  });

  it("ignores unchanged or older server versions", () => {
    expect(canApplyRevalidatedNote({
      current: cached,
      cached,
      remote: makeNote({ version: 3 }),
      hasDraft: false,
      pendingNoteId: null,
    })).toBe(false);
  });
});

describe("loadNoteCacheFirst", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStore.isNoteDetailCached.mockReturnValue(true);
    localStore.putNote.mockResolvedValue(undefined);
    attachmentRuntime.hasPersistentNoteAttachmentReference.mockImplementation((content) =>
      typeof content === "string" && content.includes("/api/attachments/"));
    attachmentRuntime.primeNoteAttachmentAccess.mockResolvedValue(1);
  });

  it("Case 1/2: prepares a cached image note before it is reopened after a switch", async () => {
    const cached = makeNote({
      content: '{"type":"doc","content":[{"type":"image","attrs":{"src":"/api/attachments/123e4567-e89b-42d3-a456-426614174216"}}]}',
    });
    localStore.getNote.mockResolvedValue(cached);
    const prepareGate = deferred<void>();
    const remoteGate = deferred<Note>();
    const beforeUseCached = vi.fn(() => prepareGate.promise);
    const fetchRemote = vi.fn(() => remoteGate.promise);
    let settled = false;

    const loadPromise = loadNoteCacheFirst({
      noteId: cached.id,
      fetchRemote,
      beforeUseCached,
    }).then((value) => {
      settled = true;
      return value;
    });

    await vi.waitFor(() => expect(beforeUseCached).toHaveBeenCalledWith(cached));
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    prepareGate.resolve();
    await expect(loadPromise).resolves.toBe(cached);

    remoteGate.resolve(makeNote({ version: 4 }));
    await vi.waitFor(() => expect(localStore.putNote).toHaveBeenCalled());
  });

  it("covers split-editor/direct callers by priming attachments by default", async () => {
    const cached = makeNote({
      content: `![image](/api/attachments/123e4567-e89b-42d3-a456-426614174216)`,
      contentFormat: "markdown",
    });
    localStore.getNote.mockResolvedValue(cached);
    const remoteGate = deferred<Note>();

    await expect(loadNoteCacheFirst({
      noteId: cached.id,
      fetchRemote: () => remoteGate.promise,
    })).resolves.toBe(cached);

    expect(attachmentRuntime.hasPersistentNoteAttachmentReference).toHaveBeenCalledWith(cached.content);
    expect(attachmentRuntime.primeNoteAttachmentAccess).toHaveBeenCalledWith(
      cached.id,
      "https://notes.example.com/api",
    );

    remoteGate.resolve(makeNote({ version: 4 }));
    await vi.waitFor(() => expect(localStore.putNote).toHaveBeenCalled());
  });

  it("does not prime cached text-only notes", async () => {
    const cached = makeNote({ content: "plain text only" });
    localStore.getNote.mockResolvedValue(cached);
    const remoteGate = deferred<Note>();

    await expect(loadNoteCacheFirst({
      noteId: cached.id,
      fetchRemote: () => remoteGate.promise,
    })).resolves.toBe(cached);

    expect(attachmentRuntime.primeNoteAttachmentAccess).not.toHaveBeenCalled();
    remoteGate.resolve(makeNote({ version: 4 }));
    await vi.waitFor(() => expect(localStore.putNote).toHaveBeenCalled());
  });

  it("keeps cached notes available if runtime preparation fails while offline", async () => {
    const cached = makeNote();
    localStore.getNote.mockResolvedValue(cached);
    const remoteGate = deferred<Note>();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadNoteCacheFirst({
      noteId: cached.id,
      fetchRemote: () => remoteGate.promise,
      beforeUseCached: async () => { throw new Error("offline"); },
    })).resolves.toBe(cached);

    expect(warn).toHaveBeenCalledWith(
      "[noteLoadSource] cached-note preparation failed:",
      expect.any(Error),
    );
    remoteGate.reject(new Error("offline"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    warn.mockRestore();
  });

  it("uses and persists the remote body when no detailed cache exists", async () => {
    localStore.getNote.mockResolvedValue(null);
    const remote = makeNote({ version: 5 });
    const beforeUseCached = vi.fn();

    await expect(loadNoteCacheFirst({
      noteId: remote.id,
      fetchRemote: async () => remote,
      beforeUseCached,
    })).resolves.toBe(remote);

    expect(beforeUseCached).not.toHaveBeenCalled();
    expect(localStore.putNote).toHaveBeenCalledWith({ ...remote, __detailCached: true });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { installMobileLocalFirstBridge } from "@/lib/mobileLocalFirstBridge";
import {
  clearFolderUnlockTokens, forgetUnlockedFolder, rememberUnlockedFolder,
  KNOWLEDGE_TREE_PASSWORD_NOTES_LOCKED_EVENT, createNoteFolderPasswordResolver,
} from "@/lib/knowledgeTreePassword";
import type { NativeDatabase } from "@/lib/nativeDatabase";
import type { NativeLocalRepository } from "@/lib/nativeLocalRepository";
import type { Note } from "@/types";
import { unsentLocalNoteKey } from "@/lib/nativeLocalNoteOrigin";

vi.mock("@/lib/mobileLocalModuleBridge", () => ({ installMobileLocalModuleBridge: () => () => {} }));
vi.mock("@/lib/mobileLocalAdvancedTaskBridge", () => ({ installMobileLocalAdvancedTaskBridge: () => () => {} }));
vi.mock("@/lib/mobileLocalAttachmentFolderBridge", () => ({ installMobileLocalAttachmentFolderBridge: () => () => {} }));
vi.mock("@/lib/mobileLocalNoteRelationsBridge", () => ({ installMobileLocalNoteRelationsBridge: () => () => {} }));

const token = (payload: object) => `header.${btoa(JSON.stringify(payload))}.signature`;
const folder = (id: string, parentId: string | null, protectedFolder = false) => ({
  id, parentId, resourceId: id, resourceType: "notebook", nodeType: "folder",
  workspaceId: null, isPasswordProtected: protectedFolder ? 1 : 0,
}) as KnowledgeTreeNode;
const note = (id: string, notebookId: string) => ({
  id, notebookId, workspaceId: null, title: id, content: "private body",
  contentText: "private preview", version: 1,
}) as Note;
const notes = [note("private", "inner"), note("ordinary", "public")];
const confirmed = [{ noteId: "private", folderIds: ["outer", "inner"] }, { noteId: "ordinary", folderIds: [] }];
let restore: (() => void) | undefined;

function setup(deviceOnly = false) {
  const nodes = [folder("outer", null, true), folder("inner", "outer", true), folder("public", null),
    ...notes.map((item) => ({ id: `note:${item.id}`, resourceId: item.id, resourceType: "note",
      parentId: item.notebookId, workspaceId: null, isDeleted: 0,
      access: { capabilities: { canView: true } } }) as KnowledgeTreeNode)];
  const remoteTree = vi.spyOn(knowledgeTreeApi, "listForWorkspace").mockResolvedValue({ nodes });
  const authorize = vi.spyOn(api, "getNoteSlim").mockResolvedValue(notes[0]);
  const repository = {
    notes: { get: vi.fn(async (id: string) => notes.find((item) => item.id === id)) },
    listNotesForWorkspace: vi.fn(async () => notes),
    listNotesWithTags: vi.fn(async () => notes),
    searchNotes: vi.fn(async () => notes.map((item) => ({ ...item, snippet: item.contentText }))),
  } as unknown as NativeLocalRepository;
  const snapshots = new Map<string, string>();
  const db = {
    run: vi.fn(async (_sql: string, values: unknown[]) => {
      snapshots.set(String(values[0]), String(values[1]));
      return { changes: 1 };
    }),
    query: vi.fn(async (_sql: string, values: unknown[]) => snapshots.has(String(values[0]))
      ? [{ value: snapshots.get(String(values[0])) }] : []),
  } as unknown as NativeDatabase;
  if (deviceOnly) localStorage.setItem("nowen-mobile-force-local-mode", "1");
  restore = installMobileLocalFirstBridge(repository, db, "user");
  return { remoteTree, authorize, repository, nodes, snapshots };
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("nowen-token", token({ userId: "user" }));
  Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
});
afterEach(() => { restore?.(); restore = undefined; vi.restoreAllMocks(); Reflect.deleteProperty(window, "Capacitor"); });

describe("signed-in Android folder password access", () => {
  it("keeps malformed navigation cycles fail-closed even with live confirmation", async () => {
    const { remoteTree, nodes } = setup();
    remoteTree.mockResolvedValue({
      nodes: nodes.map((node) => node.id === "public" ? { ...node, parentId: "note:ordinary" } : node),
      passwordAuthorizedNotes: confirmed,
    });
    expect(await api.getNotes()).toEqual([]);
    await expect(api.getNote("ordinary")).rejects.toThrow("目录密码状态无法确认");
  });

  it.each(["partial", "entire"])("checks the authoritative protection chain when navigation hides the %s parent chain", async (hidden) => {
    const { remoteTree, authorize, nodes } = setup();
    const projected = nodes.filter((node) => node.id !== "outer" && (hidden !== "entire" || node.id !== "inner"))
      .map((node) => node.id === "inner" || (hidden === "entire" && node.resourceId === "private")
        ? { ...node, parentId: null } : node);
    remoteTree.mockResolvedValue({ nodes: projected, passwordAuthorizedNotes: confirmed });
    rememberUnlockedFolder("inner", token({ userId: "user" }));
    expect((await api.getNotes()).map((item) => item.id)).toEqual(["ordinary"]);
    await expect(api.getNote("private")).rejects.toMatchObject({ code: "FOLDER_UNLOCK_REQUIRED" });
    rememberUnlockedFolder("outer", token({ userId: "user" }));
    expect((await api.getNotes()).map((item) => item.id)).toEqual(["private", "ordinary"]);
    expect(authorize).not.toHaveBeenCalled();
    await api.getNote("private");
    expect(authorize).toHaveBeenCalledWith("private");
  });

  it.each([
    ["all notes", () => api.getNotes()],
    ["favorites", () => api.getNotes({ isFavorite: "1" })],
    ["tag", () => api.getNotesWithTag("tag")],
    ["multiple tags", () => api.getNotesWithTags(["tag-a", "tag-b"])],
    ["search snippets", () => api.search("private")],
    ["search suggestions", () => api.searchNotes("private")],
  ])("uses live folder confirmation for %s", async (_name, read) => {
    const { remoteTree, authorize, nodes } = setup();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    remoteTree.mockResolvedValue({ nodes, passwordAuthorizedNotes: confirmed });
    expect((await read()).map((item) => item.id)).toEqual(["private", "ordinary"]);
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each(["missing", "deleted", "denied"])("does not authorize a %s live note from folder confirmation alone", async (state) => {
    const { remoteTree, authorize, nodes } = setup();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    const changed = nodes.flatMap((node) => node.resourceId !== "private" ? [node] : state === "missing" ? [] : [{
      ...node, isDeleted: state === "deleted" ? 1 : 0,
      access: { ...node.access, capabilities: { ...node.access.capabilities, canView: state !== "denied" } },
    }]);
    remoteTree.mockResolvedValue({ nodes: changed, passwordAuthorizedNotes: confirmed });
    expect((await api.getNotes()).map((item) => item.id)).toEqual(["ordinary"]);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("fails closed for malformed live confirmation", async () => {
    const { remoteTree, authorize, nodes } = setup();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    remoteTree.mockResolvedValue({ nodes, passwordAuthorizedNotes: null as unknown as typeof confirmed });
    expect(await api.getNotes()).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("authorizes 200 previews from the live tree without per-note requests, but still checks an opened body", async () => {
    const { remoteTree, authorize, repository, nodes } = setup();
    const many = Array.from({ length: 200 }, (_, index) => note(`private-${index}`, "inner"));
    vi.mocked(repository.listNotesForWorkspace).mockResolvedValue(many);
    remoteTree.mockResolvedValue({ nodes: [...nodes, ...many.map((item) => ({
      id: `note:${item.id}`, resourceId: item.id, resourceType: "note", parentId: "inner",
      workspaceId: null, isDeleted: 0, access: { capabilities: { canView: true } },
    }) as KnowledgeTreeNode)], passwordAuthorizedNotes: [...confirmed,
      ...many.map((item) => ({ noteId: item.id, folderIds: ["outer", "inner"] }))] });
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    expect(await api.getNotes()).toEqual(many);
    expect(remoteTree).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
    await api.getNote("private");
    expect(authorize).toHaveBeenCalledWith("private");
  });

  it("requires every ancestor to be confirmed by the server on each listing", async () => {
    const { remoteTree, authorize, nodes } = setup();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    remoteTree.mockResolvedValue({ nodes, passwordAuthorizedNotes: [confirmed[1]] });
    expect((await api.getNotes()).map((item) => item.id)).toEqual(["ordinary"]);
    expect(authorize).not.toHaveBeenCalled();
    remoteTree.mockResolvedValue({ nodes, passwordAuthorizedNotes: [] });
    expect(await api.getNotes()).toEqual([]);
  });

  it("uses the live parent chain after a note moves to another locked folder", async () => {
    const { remoteTree, nodes } = setup();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    remoteTree.mockResolvedValue({
      nodes: [...nodes.map((node) => node.resourceId === "private" ? { ...node, parentId: "other" } : node),
        folder("other", null, true)], passwordAuthorizedNotes: [{ noteId: "private", folderIds: ["other"] }, confirmed[1]],
    });
    expect((await api.getNotes()).map((item) => item.id)).toEqual(["ordinary"]);
  });

  it("does not reuse live unlock confirmation from an offline snapshot", async () => {
    const { remoteTree, authorize, nodes } = setup();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    remoteTree.mockResolvedValue({ nodes, passwordAuthorizedNotes: confirmed });
    await api.getNotes();
    remoteTree.mockRejectedValue(new TypeError("Failed to fetch"));
    authorize.mockRejectedValue(new TypeError("Failed to fetch"));
    expect((await api.getNotes()).map((item) => item.id)).toEqual(["ordinary"]);
    expect(authorize).toHaveBeenCalledWith("private");
  });

  it("rejects a live confirmation if a folder was relocked and unlocked while the tree was pending", async () => {
    const { remoteTree, nodes } = setup();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    let finish!: (value: Awaited<ReturnType<typeof knowledgeTreeApi.listForWorkspace>>) => void;
    remoteTree.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const read = api.getNotes();
    await vi.waitFor(() => expect(remoteTree).toHaveBeenCalled());
    clearFolderUnlockTokens();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    finish({ nodes, passwordAuthorizedNotes: confirmed });
    expect((await read).map((item) => item.id)).toEqual(["ordinary"]);
  });

  it("limits old-server per-note authorization to four concurrent requests", async () => {
    const { remoteTree, authorize, repository, nodes } = setup();
    const many = Array.from({ length: 200 }, (_, index) => note(`private-${index}`, "inner"));
    vi.mocked(repository.listNotesForWorkspace).mockResolvedValue(many);
    remoteTree.mockResolvedValue({ nodes: [...nodes, ...many.map((item) => ({
      id: `note:${item.id}`, resourceId: item.id, resourceType: "note", parentId: "inner", workspaceId: null,
    }) as KnowledgeTreeNode)] });
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    let active = 0;
    let maximum = 0;
    authorize.mockImplementation(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return notes[0];
    });
    expect(await api.getNotes()).toEqual(many);
    expect(authorize).toHaveBeenCalledTimes(200);
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it("stops queued old-server requests on relock and removes previews approved earlier in the same read", async () => {
    const { remoteTree, authorize, repository, nodes } = setup();
    const many = Array.from({ length: 8 }, (_, index) => note(`private-${index}`, "inner"));
    vi.mocked(repository.listNotesForWorkspace).mockResolvedValue(many);
    remoteTree.mockResolvedValue({ nodes: [...nodes, ...many.map((item) => ({
      id: `note:${item.id}`, resourceId: item.id, resourceType: "note", parentId: "inner", workspaceId: null,
    }) as KnowledgeTreeNode)] });
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    const finishes: Array<(value: Note) => void> = [];
    authorize.mockImplementation(() => new Promise((resolve) => { finishes.push(resolve); }));
    const read = api.getNotes();
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(4));
    finishes[0](notes[0]); finishes[1](notes[0]);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(6));
    clearFolderUnlockTokens();
    for (const finish of finishes.slice(2)) finish(notes[0]);
    expect(await read).toEqual([]);
    expect(authorize).toHaveBeenCalledTimes(6);
  });

  it("keeps a proven unsent local note readable across bridge restart, then denies fallback when its marker is revoked", async () => {
    const { remoteTree, nodes, snapshots, repository } = setup();
    snapshots.set(unsentLocalNoteKey("personal", "ordinary"), "1");
    remoteTree.mockResolvedValue({ nodes: nodes.filter((node) => node.resourceId !== "ordinary") });
    expect((await api.getNotes()).map((item) => item.id)).toEqual(["ordinary"]);
    await expect(api.getNote("ordinary")).resolves.toEqual(notes[1]);
    remoteTree.mockRejectedValue(new TypeError("Failed to fetch"));
    restore?.();
    const db = { query: vi.fn(async (_sql: string, values: unknown[]) => snapshots.has(String(values[0]))
      ? [{ value: snapshots.get(String(values[0])) }] : []) } as unknown as NativeDatabase;
    restore = installMobileLocalFirstBridge(repository, db, "user");
    await expect(api.getNote("ordinary")).resolves.toEqual(notes[1]);
    snapshots.delete(unsentLocalNoteKey("personal", "ordinary"));
    await expect(api.getNote("ordinary")).rejects.toThrow("目录密码状态无法确认");
  });

  it("does not use a marker from another workspace or an invalid marker value", async () => {
    const { remoteTree, nodes, snapshots } = setup();
    remoteTree.mockResolvedValue({ nodes: nodes.filter((node) => node.resourceId !== "ordinary") });
    snapshots.set(unsentLocalNoteKey("workspace:other", "ordinary"), "1");
    await expect(api.getNote("ordinary")).rejects.toThrow("目录密码状态无法确认");
    snapshots.set(unsentLocalNoteKey("personal", "ordinary"), "unknown");
    await expect(api.getNote("ordinary")).rejects.toThrow("目录密码状态无法确认");
  });

  it("a local marker still requires all inherited password ancestors to be unlocked", async () => {
    const { remoteTree, nodes, snapshots, authorize } = setup();
    remoteTree.mockResolvedValue({ nodes: nodes.filter((node) => node.resourceId !== "private") });
    snapshots.set(unsentLocalNoteKey("personal", "private"), "1");
    await expect(api.getNote("private")).rejects.toMatchObject({ code: "FOLDER_UNLOCK_REQUIRED" });
    rememberUnlockedFolder("inner", token({ userId: "user" }));
    await expect(api.getNote("private")).rejects.toMatchObject({ code: "FOLDER_UNLOCK_REQUIRED" });
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each([
    ["all notes", () => api.getNotes()],
    ["favorites", () => api.getNotes({ isFavorite: "1" })],
    ["tag", () => api.getNotesWithTag("tag")],
    ["multiple tags", () => api.getNotesWithTags(["tag-a", "tag-b"])],
    ["search snippets", () => api.search("private")],
    ["search suggestions", () => api.searchNotes("private")],
  ])("hides a synced note missing from the cached tree in %s even when its notebook is public", async (_name, read) => {
    const { remoteTree, nodes } = setup();
    remoteTree.mockResolvedValue({ nodes: nodes.filter((node) => node.resourceId !== "ordinary") });
    await api.getNotes(); // persist an older snapshot lacking the synced note's real parent chain
    remoteTree.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await read()).toEqual([]);
    await expect(api.getNote("ordinary")).rejects.toThrow("目录密码状态无法确认");
    await expect(api.getNoteSlim("ordinary")).rejects.toThrow("目录密码状态无法确认");
  });
  it.each([
    ["all notes", () => api.getNotes()],
    ["favorites", () => api.getNotes({ isFavorite: "1" })],
    ["tag", () => api.getNotesWithTag("tag")],
    ["multiple tags", () => api.getNotesWithTags(["tag-a", "tag-b"])],
    ["search snippets", () => api.search("private")],
    ["search suggestions", () => api.searchNotes("private")],
  ])("hides locked descendants from %s", async (_name, read) => {
    setup();
    expect((await read()).map((item) => item.id)).toEqual(["ordinary"]);
  });

  it("requires every protected ancestor and revalidates the server token before returning local edits", async () => {
    const { authorize } = setup();
    await expect(api.getNote("private")).rejects.toMatchObject({ code: "FOLDER_UNLOCK_REQUIRED" });
    rememberUnlockedFolder("outer", token({ userId: "user", exp: Date.now() / 1000 + 3600 }));
    await expect(api.getNoteSlim("private")).rejects.toMatchObject({ code: "FOLDER_UNLOCK_REQUIRED" });
    rememberUnlockedFolder("inner", token({ userId: "user", exp: Date.now() / 1000 + 3600 }));
    await expect(api.getNote("private")).resolves.toEqual(notes[0]);
    expect(authorize).toHaveBeenCalledWith("private");
    clearFolderUnlockTokens();
    await expect(api.getNote("private")).rejects.toMatchObject({ code: "FOLDER_UNLOCK_REQUIRED" });
  });

  it("refuses stale tokens rejected by the server, including private previews", async () => {
    const { authorize } = setup();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    const denied = Object.assign(new Error("folder locked"), { status: 403, code: "FOLDER_UNLOCK_REQUIRED" });
    authorize.mockRejectedValue(denied);
    await expect(api.getNote("private")).rejects.toBe(denied);
    expect((await api.getNotes()).map((item) => item.id)).toEqual(["ordinary"]);
  });

  it.each([
    { userId: "user", exp: Date.now() / 1000 - 60 },
    { userId: "another-account", exp: Date.now() / 1000 + 3600 },
  ])("refuses expired or another account's unlock tokens", async (payload) => {
    setup();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token(payload));
    await expect(api.getNote("private")).rejects.toMatchObject({ code: "FOLDER_UNLOCK_REQUIRED" });
    expect((await api.getNotes()).map((item) => item.id)).toEqual(["ordinary"]);
  });

  it("refuses a protected body if its folder is relocked while server authorization is pending", async () => {
    const { authorize } = setup();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    let finish!: (value: Note) => void;
    authorize.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const read = api.getNote("private");
    await vi.waitFor(() => expect(authorize).toHaveBeenCalled());
    clearFolderUnlockTokens();
    finish(notes[0]);
    await expect(read).rejects.toMatchObject({ code: "FOLDER_UNLOCK_REQUIRED" });
  });

  it("keeps ordinary notes readable offline using the server snapshot, but never authorizes protected bodies offline", async () => {
    const { remoteTree, authorize } = setup();
    await api.getNotes();
    remoteTree.mockRejectedValue(new TypeError("Failed to fetch"));
    authorize.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.getNote("ordinary")).resolves.toEqual(notes[1]);
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    await expect(api.getNote("private")).rejects.toThrow("Failed to fetch");
  });

  it("does not replace missing password metadata with an unprotected local projection", async () => {
    const { remoteTree } = setup();
    remoteTree.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.getNote("private")).rejects.toThrow();
  });

  it("keeps device-only notes local without server authorization", async () => {
    const { remoteTree, authorize } = setup(true);
    await expect(api.getNote("private")).resolves.toEqual(notes[0]);
    expect((await api.getNotes()).map((item) => item.id)).toEqual(["private", "ordinary"]);
    expect(remoteTree).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
  });

  it("invalidates an already opened protected note when any ancestor is relocked", async () => {
    setup();
    for (const id of ["outer", "inner"]) rememberUnlockedFolder(id, token({ userId: "user" }));
    await api.getNote("private");
    const events: string[][] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<{ noteIds: string[] }>).detail.noteIds);
    window.addEventListener(KNOWLEDGE_TREE_PASSWORD_NOTES_LOCKED_EVENT, listener);
    try {
      forgetUnlockedFolder("outer");
      expect(events).toEqual([["private"]]);
      restore?.(); restore = undefined;
      clearFolderUnlockTokens();
      expect(events).toHaveLength(1);
    } finally { window.removeEventListener(KNOWLEDGE_TREE_PASSWORD_NOTES_LOCKED_EVENT, listener); }
  });

  it("uses the real cross-type parent chain, and refuses missing ancestors or cycles", () => {
    const { nodes } = setup();
    const privateNode = nodes.find((node) => node.resourceId === "private")!;
    const child = { ...privateNode, id: "note:child", resourceId: "child", parentId: privateNode.id };
    const childNote = { id: "child", notebookId: "public" };
    expect(createNoteFolderPasswordResolver([...nodes, child])(childNote)).toEqual(["inner", "outer"]);
    expect(createNoteFolderPasswordResolver([...nodes, child])(childNote, true)).toEqual(["inner", "outer"]);
    expect(createNoteFolderPasswordResolver(nodes)({ id: "new-local-note", notebookId: "inner" })).toBeNull();
    expect(createNoteFolderPasswordResolver(nodes)({ id: "new-local-note", notebookId: "inner" }, true)).toEqual(["inner", "outer"]);
    expect(createNoteFolderPasswordResolver([child])(childNote)).toBeNull();
    expect(createNoteFolderPasswordResolver([{ ...child, parentId: child.id }])(childNote)).toBeNull();
    expect(createNoteFolderPasswordResolver([{ ...folder("public", null), isPasswordProtected: undefined }])(childNote)).toBeNull();
  });
});

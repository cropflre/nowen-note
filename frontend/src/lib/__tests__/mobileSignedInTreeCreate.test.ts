import { afterEach, describe, expect, it, vi } from "vitest";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "../knowledgeTreeApi";
import { installMobileLocalKnowledgeTreeBridge } from "../mobileLocalKnowledgeTreeBridge";
import type { NativeLocalRepository } from "../nativeLocalRepository";
import type { NativeDatabase } from "../nativeDatabase";
import type { Note } from "@/types";

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; vi.restoreAllMocks(); });

function setup(parent?: KnowledgeTreeNode) {
  const drafts: Array<Note & { treeParentId: string | null }> = [];
  const metadata = new Map<string, string>();
  let pending = true;
  const db = {
    run: vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith("DELETE")) metadata.delete(String(values[0]));
      else metadata.set(String(values[0]), String(values[1]));
      return { changes: 1 };
    }),
    query: vi.fn(async (sql: string, values: unknown[]) => sql.includes("sync_outbox") ? (pending ? [{ id: "queued" }] : [])
      : metadata.has(String(values[0])) ? [{ value: metadata.get(String(values[0])) }] : []),
  } as unknown as NativeDatabase;
  const repository = {
    listPersonalTreeOverrides: vi.fn(async () => []),
    listPersonalTreeFolderDrafts: vi.fn(async () => []),
    listLocalTreeDrafts: vi.fn(async () => drafts),
    createPersonalTreeNote: vi.fn(async (input: Note, notebookId: string | null) => {
      drafts.push({ ...input, userId: "user", workspaceId: null, notebookId: notebookId || "hidden-root",
        isTrashed: 0, version: 1, treeParentId: notebookId ? `notebook:${notebookId}` : null });
      return { id: input.id, savedAt: "now" };
    }),
    notes: { get: vi.fn(async (id: string) => drafts.find((note) => note.id === id)) },
  } as unknown as NativeLocalRepository;
  const remoteCreate = vi.spyOn(knowledgeTreeApi, "createForWorkspace").mockRejectedValue(new TypeError("Failed to fetch"));
  const remoteList = vi.spyOn(knowledgeTreeApi, "listForWorkspace").mockResolvedValue({ nodes: parent ? [parent] : [], passwordAuthorizedNotes: [] });
  restore = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: false }, db);
  return { repository, db, drafts, metadata, remoteCreate, remoteList, ack: () => { pending = false; } };
}

const folder = (protectedFolder: boolean): KnowledgeTreeNode => ({
  id: "notebook:folder", resourceId: "folder", parentId: null, resourceType: "notebook", nodeType: "folder",
  workspaceId: null, isDeleted: 0, isPasswordProtected: protectedFolder ? 1 : 0,
  access: { capabilities: { canView: true, canCreate: true } },
}) as KnowledgeTreeNode;

describe("signed-in native personal tree creation", () => {
  it.each(["markdown", "note"] as const)("creates a %s root without network and keeps it visible after bridge restart", async (nodeType) => {
    const state = setup();
    state.remoteList.mockRejectedValue(new TypeError("Failed to fetch"));
    const node = await knowledgeTreeApi.createForWorkspace("personal", { parentId: null, nodeType, title: "Offline" });
    expect(state.remoteCreate).not.toHaveBeenCalled();
    expect(await state.repository.notes.get(node.resourceId)).toMatchObject({ title: "Offline" });
    expect(node.id).toBe(`note:${node.resourceId}`);
    restore?.();
    restore = installMobileLocalKnowledgeTreeBridge(state.repository, { deviceOnly: false }, state.db);
    expect((await knowledgeTreeApi.listForWorkspace("personal")).nodes).toMatchObject([{ id: node.id, parentId: null }]);
  });

  it("creates in a cached ordinary folder and hands structure over to the live server node", async () => {
    const state = setup(folder(false));
    await knowledgeTreeApi.listForWorkspace("personal");
    state.remoteList.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const node = await knowledgeTreeApi.createForWorkspace("personal", { parentId: "notebook:folder", nodeType: "markdown", title: "Child" });
    expect(state.repository.createPersonalTreeNote).toHaveBeenCalledWith(expect.anything(), "folder");
    state.remoteList.mockResolvedValue({ nodes: [folder(false), { ...node, parentId: "new-parent" }] });
    const tree = await knowledgeTreeApi.listForWorkspace("personal");
    expect(tree.nodes.filter((item) => item.resourceId === node.resourceId)).toHaveLength(1);
    expect(tree.nodes.find((item) => item.id === node.id)?.parentId).toBe("new-parent");
    expect(state.db.run).toHaveBeenCalledWith("DELETE FROM native_runtime_meta WHERE key=?", [`localTreeDraft:personal:${node.resourceId}`]);
  });

  it("retains server checks for protected folders and workspaces", async () => {
    const state = setup(folder(true));
    await expect(knowledgeTreeApi.createForWorkspace("personal", { parentId: "notebook:folder", nodeType: "note", title: "Protected" })).rejects.toThrow("Failed to fetch");
    await expect(knowledgeTreeApi.createForWorkspace("workspace", { parentId: null, nodeType: "note", title: "Shared" })).rejects.toThrow("Failed to fetch");
    expect(state.repository.createPersonalTreeNote).not.toHaveBeenCalled();
  });

  it("does not project an ACKed note omitted by the live authorization tree", async () => {
    const state = setup();
    await knowledgeTreeApi.createForWorkspace("personal", { parentId: null, nodeType: "note", title: "Root" });
    state.ack();
    expect((await knowledgeTreeApi.listForWorkspace("personal")).nodes).toEqual([]);
  });
});

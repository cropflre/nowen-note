import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { installMobileLocalModuleBridge } from "../mobileLocalModuleBridge";
import type { NativeDatabase } from "../nativeDatabase";
import type { NativeLocalRepository } from "../nativeLocalRepository";

afterEach(() => localStorage.removeItem("nowen-current-workspace"));
it("rejects Native workspace file operations before using personal rows or writes", async () => {
  const query = vi.fn(); const run = vi.fn(); const notebooks = vi.fn();
  const restore = installMobileLocalModuleBridge({ notebooks: { list: notebooks } } as unknown as NativeLocalRepository,
    { query, run } as unknown as NativeDatabase, "scope-test-user");
  try {
    localStorage.setItem("nowen-current-workspace", "workspace-a");
    for (const operation of [() => api.files.list(), () => api.files.stats(), () => api.files.get("file-a"),
      () => api.files.upload(new File(["test"], "workspace.txt")), () => api.files.rename("file-a", "new-name"), () => api.files.remove("file-a"),
      () => api.files.tools.similar("file-a"), () => api.files.tools.batchRename([{id:"file-a",filename:"new.png",expectedFilename:"old.png"}])]) {
      await expect(operation()).rejects.toMatchObject({ code: "MOBILE_WORKSPACE_FILES_UNSUPPORTED" });
    }
    expect(query).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(notebooks).not.toHaveBeenCalled();
  } finally { restore(); }
});

it("rejects Native visual tools before local SQL or server fallback and restores the original facade",async()=>{
  const query=vi.fn(),run=vi.fn();
  const original=api.files.tools;
  const restore=installMobileLocalModuleBridge({} as NativeLocalRepository,{query,run} as unknown as NativeDatabase,"owner");
  try {
    await expect(api.files.tools.similar("file-a")).rejects.toMatchObject({code:"MOBILE_ASSET_TOOLS_UNSUPPORTED"});
    await expect(api.files.tools.batchRename([{id:"file-a",filename:"new.png",expectedFilename:"old.png"}])).rejects.toMatchObject({code:"MOBILE_ASSET_TOOLS_UNSUPPORTED"});
    expect(query).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
  } finally {restore();}
  expect(api.files.tools).toBe(original);
});

it("rejects Native organization and metadata filters before personal SQL or server calls", async () => {
  const query = vi.fn(); const run = vi.fn();
  const restore = installMobileLocalModuleBridge({} as NativeLocalRepository, { query, run } as unknown as NativeDatabase, "native-assets-user");
  try {
    expect((await api.files.organization.list()).supported).toBe(false);
    for (const operation of [() => api.files.organization.get("file"), () => api.files.organization.createTag("Design"),
      () => api.files.organization.tagFiles(["file"], ["tag"], "add"), () => api.files.organization.saveSmartFolder("Images", { category: "image" }),
      () => api.files.list({ tagIds: ["tag"] }), () => api.files.list({ duplicateOnly: true })]) {
      await expect(operation()).rejects.toMatchObject({ code: "MOBILE_ASSET_ORGANIZATION_UNSUPPORTED" });
    }
    expect(query).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  } finally { restore(); }
});

it("keeps Native recently-added browsing available without organization support", async () => {
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const query = vi.fn().mockResolvedValue([
    { id: "recent", filename: "recent.txt", mimeType: "text/plain", createdAt: recent },
    { id: "old", filename: "old.txt", mimeType: "text/plain", createdAt: old },
  ]);
  const resolveUrl = vi.fn().mockResolvedValue("native://recent");
  const restore = installMobileLocalModuleBridge({ attachments: { resolveUrl } } as unknown as NativeLocalRepository,
    { query } as unknown as NativeDatabase, "native-assets-user");
  try {
    const result = await api.files.list({ recentDays: 7 });
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe("recent");
    expect(resolveUrl).toHaveBeenCalledTimes(1);
    expect(resolveUrl).toHaveBeenCalledWith("recent");
  } finally { restore(); }
});

it("rejects Native file recycle-bin mutations before local deletion or server fallback", async () => {
  const query = vi.fn(), run = vi.fn();
  localStorage.setItem("nowen-current-workspace", "personal");
  const original = api.files.trash;
  const restore = installMobileLocalModuleBridge({} as NativeLocalRepository, { query, run } as unknown as NativeDatabase, "owner");
  try {
    expect((await api.files.trash.list()).supported).toBe(false);
    for (const mutation of [() => api.files.remove("file"), () => api.files.batchRemove(["file"]), () => api.files.trash.restore(["file"]), () => api.files.trash.purge(["file"])]) {
      await expect(mutation()).rejects.toMatchObject({ code: "MOBILE_ASSET_TRASH_UNSUPPORTED" });
    }
    expect(query).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  } finally { restore(); }
  expect(api.files.trash).toBe(original);
});

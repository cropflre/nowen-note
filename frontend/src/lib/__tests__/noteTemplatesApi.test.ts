import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  getCurrentWorkspace: () => "personal",
  getBaseUrl: () => "https://note.example.com/api",
}));

import { noteTemplatesApi } from "@/lib/noteTemplatesApi";

describe("noteTemplatesApi", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ templates: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("列表请求不在挂载路径后追加尾斜杠", async () => {
    await noteTemplatesApi.list();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://note.example.com/api/note-templates?workspaceId=personal",
    );
  });

  it("lets the server resolve a shared folder's workspace instead of using the current personal view", async () => {
    await noteTemplatesApi.list({ parentId: "shared folder" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://note.example.com/api/note-templates?parentId=shared+folder",
    );
    await noteTemplatesApi.createNote("template", "shared folder");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://note.example.com/api/note-templates/template/create-note?parentId=shared+folder",
    );
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body)).toEqual({ parentId: "shared folder" });
  });

  it("preserves explicit workspace boundaries and personal root creation", async () => {
    await noteTemplatesApi.list({ parentId: "folder", workspaceId: "SMT" });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("workspaceId=SMT&parentId=folder");
    await noteTemplatesApi.createNote("template", null);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("create-note?workspaceId=personal");
    await noteTemplatesApi.remove("template", "SMT");
    expect(fetchMock.mock.calls[2]?.[0]).toContain("template?workspaceId=SMT");
  });

  it("rejects a delayed template response after switching accounts (DCC-006)", async () => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    localStorage.setItem("nowen-token", "first-account");
    const request = noteTemplatesApi.list({ parentId: "folder" });
    localStorage.setItem("nowen-token", "second-account");
    release(new Response(JSON.stringify({ templates: [{ name: "first account template" }] })));
    await expect(request).rejects.toThrow("账号、服务器或空间已切换");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  getCurrentWorkspace: () => "personal",
  getServerUrl: () => "https://note.example.com",
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
});

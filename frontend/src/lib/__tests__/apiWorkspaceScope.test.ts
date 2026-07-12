import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

describe("API 工作区参数", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("个人空间不传 workspaceId，兼容旧服务端", async () => {
    localStorage.setItem("nowen-server-url", "https://note.example.com");
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([api.getNotes(), api.getNotebooks(), api.getTags(), api.getNotesWithTag("tag-1"), api.search("测试")]);

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toContain("https://note.example.com/api/notes");
    expect(urls).toContain("https://note.example.com/api/notebooks");
    expect(urls).toContain("https://note.example.com/api/tags");
    expect(urls).toContain("https://note.example.com/api/notes?tagId=tag-1");
    expect(urls).toContain("https://note.example.com/api/search?q=%E6%B5%8B%E8%AF%95");
    expect(urls.every((url) => !url.includes("workspaceId=personal"))).toBe(true);
  });

  it("协作工作区继续传 workspaceId", async () => {
    localStorage.setItem("nowen-server-url", "https://note.example.com");
    localStorage.setItem("nowen-current-workspace", "workspace-1");
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([api.getNotes(), api.getNotebooks(), api.getTags(), api.getNotesWithTag("tag-1")]);

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.every((url) => url.includes("workspaceId=workspace-1"))).toBe(true);
  });
});

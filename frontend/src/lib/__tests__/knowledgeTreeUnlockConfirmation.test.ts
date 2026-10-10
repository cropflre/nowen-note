import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { knowledgeTreeApi } from "@/lib/knowledgeTreeApi";
import { rememberUnlockedFolder } from "@/lib/knowledgeTreePassword";

const token = (payload: object) => `header.${btoa(JSON.stringify(payload))}.signature`;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("nowen-token", token({ userId: "user" }));
});
afterEach(() => { vi.restoreAllMocks(); });

it.each(["list", "workspace"])("sends unlock tokens and preserves live confirmation through display sorting (%s)", async (method) => {
  const unlock = token({ userId: "user", exp: Date.now() / 1000 + 3600 });
  rememberUnlockedFolder("folder", unlock);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
    JSON.stringify({ nodes: [], passwordAuthorizedNotes: [{ noteId: "note", folderIds: ["folder"] }] }), { status: 200 },
  ));
  const result = await (method === "list" ? knowledgeTreeApi.list() : knowledgeTreeApi.listForWorkspace("personal", true));
  expect(result).toEqual({ nodes: [], passwordAuthorizedNotes: [{ noteId: "note", folderIds: ["folder"] }] });
  const init = fetchMock.mock.calls[0][1]!;
  expect(new Headers(init.headers).get("X-Folder-Unlock-Tokens")).toBe(unlock);
  expect(init.cache).toBe("no-store");
});

it("keeps old-server responses distinguishable from a live denial", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ nodes: [] }), { status: 200 }));
  expect(await knowledgeTreeApi.listForWorkspace("personal")).toEqual({ nodes: [] });
});

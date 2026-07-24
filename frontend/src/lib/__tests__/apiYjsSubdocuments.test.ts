import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

describe("Y.js Subdocument API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("requests the manifest, a section snapshot and a section update", async () => {
    localStorage.setItem("nowen-server-url", "https://note.example.com");
    const responses = [
      { rootGuid: "root", generation: 7, structureVersion: 3, sections: [{ id: "section-a", guid: "guid-a", startBlock: 0, endBlock: 10 }] },
      { guid: "guid-a", stateBase64: "AQ==" },
      { success: true, content: "{}", contentText: "", sectionGuid: "guid-a", version: 2, generation: 7, structureVersion: 3 },
    ];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getYjsSubdocumentManifest("note/with slash");
    await api.getYjsSubdocumentState("note/with slash", "section/a");
    await api.applyYjsSubdocumentUpdate("note/with slash", "section/a", "AQ==", 7);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://note.example.com/api/notes/note%2Fwith%20slash/yjs/subdocuments",
      "https://note.example.com/api/notes/note%2Fwith%20slash/yjs/subdocuments/section%2Fa",
      "https://note.example.com/api/notes/note%2Fwith%20slash/yjs/subdocuments/section%2Fa",
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ updateBase64: "AQ==", generation: 7 }),
    });
  });
});

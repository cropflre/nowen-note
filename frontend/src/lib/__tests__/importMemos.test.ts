import { describe, expect, it, vi, beforeEach } from "vitest";
import { importMemos } from "@/lib/importService";
import { api } from "@/lib/api";

// Polyfill File.prototype.text for jsdom environment if missing
if (typeof File !== "undefined" && !File.prototype.text) {
  File.prototype.text = function(this: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

// Mock the api module
vi.mock("@/lib/api", () => {
  return {
    api: {
      postDiary: vi.fn().mockResolvedValue({ id: "diary_id" }),
      importNotes: vi.fn().mockResolvedValue({ count: 2 }),
      diaryImages: {
        upload: vi.fn().mockResolvedValue({ id: "image_id" }),
      },
    },
  };
});

describe("importMemos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("successfully imports memos as diaries", async () => {
    const memosData = [
      {
        content: "Hello memos 1 #tag1",
        createdTs: 1680000000,
        visibility: "PUBLIC",
      },
      {
        content: "Hello memos 2 #tag2",
        createdTs: 1680000060,
        visibility: "PRIVATE",
      },
    ];

    const jsonFile = new File([JSON.stringify(memosData)], "memos.json", {
      type: "application/json",
    });

    const progressCallbacks: any[] = [];
    const onProgress = vi.fn((p) => {
      progressCallbacks.push(p);
    });

    const result = await importMemos(jsonFile, "diaries", onProgress, {
      workspaceId: "test-workspace-id",
    });

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);

    expect(api.postDiary).toHaveBeenCalledTimes(2);
    expect(api.postDiary).toHaveBeenNthCalledWith(
      1,
      {
        contentText: "Hello memos 1 #tag1",
        images: [],
        visibility: "PUBLIC",
        createdAt: "2023-03-28 10:40:00", // 1680000000 UTC
      },
      "test-workspace-id"
    );
    expect(api.postDiary).toHaveBeenNthCalledWith(
      2,
      {
        contentText: "Hello memos 2 #tag2",
        images: [],
        visibility: "PRIVATE",
        createdAt: "2023-03-28 10:41:00", // 1680000060 UTC
      },
      "test-workspace-id"
    );

    // Verify progress callbacks
    expect(progressCallbacks.some((p) => p.phase === "reading")).toBe(true);
    expect(progressCallbacks.some((p) => p.phase === "uploading")).toBe(true);
    expect(progressCallbacks.some((p) => p.phase === "done")).toBe(true);
  });

  it("successfully imports memos as notes", async () => {
    const memosData = [
      {
        content: "Hello memos 1 #tag1",
        createdTs: 1680000000,
        visibility: "PUBLIC",
      },
      {
        content: "Hello memos 2 #tag2",
        createdTs: 1680000060,
        visibility: "PRIVATE",
      },
    ];

    const jsonFile = new File([JSON.stringify(memosData)], "memos_backup.json", {
      type: "application/json",
    });

    const onProgress = vi.fn();

    const result = await importMemos(jsonFile, "notes", onProgress, {
      workspaceId: "test-workspace-id",
    });

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);

    expect(api.importNotes).toHaveBeenCalledTimes(1);
    expect(api.importNotes).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Hello memos 1 tag1",
          notebookName: "Memos",
          notebookPath: ["Memos"],
        }),
        expect.objectContaining({
          title: "Hello memos 2 tag2",
          notebookName: "Memos",
          notebookPath: ["Memos"],
        }),
      ]),
      undefined,
      undefined,
      "test-workspace-id"
    );
  });
});

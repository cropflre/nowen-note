import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    miCloudVerify: vi.fn(),
    miCloudNotes: vi.fn(),
  },
  getBaseUrl: () => "/api",
}));

import {
  importMiNotes,
  MI_CLOUD_IMPORT_BATCH_SIZE,
  MI_CLOUD_IMPORT_BATCH_TIMEOUT_MS,
} from "../miNoteService";

function response(payload: unknown, status = 201): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe("importMiNotes", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue("test-token"),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("splits a large import into bounded batches and reuses the created notebook", async () => {
    const requestBodies: Array<{ noteIds: string[]; notebookId?: string }> = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as {
        noteIds: string[];
        notebookId?: string;
      };
      requestBodies.push(body);
      return response({
        success: true,
        count: body.noteIds.length,
        notebookId: body.notebookId || "created-notebook",
        errors: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const noteIds = Array.from(
      { length: MI_CLOUD_IMPORT_BATCH_SIZE * 2 + 2 },
      (_, index) => `note-${index}`,
    );
    const result = await importMiNotes("cookie", noteIds);

    expect(result).toEqual({ success: true, count: noteIds.length, errors: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestBodies.map((body) => body.noteIds.length)).toEqual([
      MI_CLOUD_IMPORT_BATCH_SIZE,
      MI_CLOUD_IMPORT_BATCH_SIZE,
      2,
    ]);
    expect(requestBodies[0].notebookId).toBeUndefined();
    expect(requestBodies[1].notebookId).toBe("created-notebook");
    expect(requestBodies[2].notebookId).toBe("created-notebook");

    const firstRequest = fetchMock.mock.calls[0][1] as RequestInit;
    expect(firstRequest.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    });
  });

  it("reports how many notes were imported before a later batch fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({
        success: true,
        count: MI_CLOUD_IMPORT_BATCH_SIZE,
        notebookId: "created-notebook",
        errors: [],
      }))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const noteIds = Array.from(
      { length: MI_CLOUD_IMPORT_BATCH_SIZE * 2 },
      (_, index) => `note-${index}`,
    );

    await expect(importMiNotes("cookie", noteIds)).rejects.toThrow(
      `已成功导入 ${MI_CLOUD_IMPORT_BATCH_SIZE} 条，剩余 ${MI_CLOUD_IMPORT_BATCH_SIZE} 条未完成。network down`,
    );
  });

  it("turns a batch abort into an actionable import timeout message", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = importMiNotes("cookie", ["note-1"]);
    const assertion = expect(pending).rejects.toThrow(
      "当前批次导入超时。服务端可能仍在处理，请稍后刷新目标笔记本确认结果，避免重复导入。",
    );

    await vi.advanceTimersByTimeAsync(MI_CLOUD_IMPORT_BATCH_TIMEOUT_MS);
    await assertion;
  });

  it("does not call the backend when no valid note IDs are selected", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(importMiNotes("cookie", ["", ""])).resolves.toEqual({
      success: false,
      count: 0,
      errors: ["请选择要导入的笔记"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

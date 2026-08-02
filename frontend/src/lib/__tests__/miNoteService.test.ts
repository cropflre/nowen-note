import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    miCloudVerify: vi.fn(),
    miCloudNotes: vi.fn(),
  },
  getBaseUrl: () => "/api",
}));

import {
  cancelMiCloudImport,
  importMiNotes,
  resumeActiveMiCloudImport,
  type MiCloudImportJob,
} from "../miNoteService";

function job(overrides: Partial<MiCloudImportJob> = {}): MiCloudImportJob {
  return {
    id: "job-1",
    notebookId: "notebook-1",
    status: "queued",
    total: 4,
    processed: 0,
    succeeded: 0,
    failed: 0,
    currentExternalId: null,
    error: null,
    retryOfJobId: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-07-31T00:00:00.000Z",
    errors: [],
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const encoder = new TextEncoder();
  const body = events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("MiCloud background import jobs", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue("test-token"),
    });
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("creates one job, opens one SSE stream, and preserves repeated Xiaomi rows", async () => {
    const noteIds = ["note-1", "note-1", "note-2", "note-1"];
    const queued = job();
    const completed = job({
      status: "completed",
      processed: 4,
      succeeded: 4,
      finishedAt: "2026-07-31T00:01:00.000Z",
      updatedAt: "2026-07-31T00:01:00.000Z",
    });
    const progress: MiCloudImportJob[] = [];

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/micloud/import-jobs" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { noteIds: string[] };
        expect(body.noteIds).toEqual(noteIds);
        return jsonResponse({ job: queued }, 202);
      }
      if (url === "/api/micloud/import-jobs/job-1/events") {
        return sseResponse([
          { event: "progress", data: job({ status: "running", processed: 2, succeeded: 2 }) },
          { event: "done", data: completed },
        ]);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await importMiNotes("cookie", noteIds, undefined, (value) => progress.push(value));

    expect(result).toEqual({
      success: true,
      count: 4,
      failedCount: 0,
      errors: [],
      jobId: "job-1",
      cancelled: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(progress.at(-1)?.status).toBe("completed");

    const createInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(createInit.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    });
  });

  it("resumes the active server-side job after the page is reopened", async () => {
    const active = job({ status: "running", processed: 1, succeeded: 1 });
    const completed = job({
      status: "completed",
      processed: 4,
      succeeded: 4,
      finishedAt: "2026-07-31T00:01:00.000Z",
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/micloud/import-jobs/active") {
        return jsonResponse({ job: active });
      }
      if (url === "/api/micloud/import-jobs/job-1/events") {
        return sseResponse([{ event: "done", data: completed }]);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resumeActiveMiCloudImport()).resolves.toMatchObject({
      success: true,
      count: 4,
      jobId: "job-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends a single cancellation request", async () => {
    const cancelling = job({ status: "cancelling", processed: 2, succeeded: 2 });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ job: cancelling }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cancelMiCloudImport("job-1")).resolves.toEqual(cancelling);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/micloud/import-jobs/job-1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not create a job when no valid rows are selected", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(importMiNotes("cookie", ["", ""])).resolves.toEqual({
      success: false,
      count: 0,
      failedCount: 0,
      errors: ["请选择要导入的笔记"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

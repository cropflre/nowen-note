import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrationApi } from "../migrations";
import { createHash } from "node:crypto";
import { File as NodeFile } from "node:buffer";

const mocks = vi.hoisted(() => ({ request: vi.fn(), scope: "server:user-1" }));
vi.mock("../api", () => ({ getBaseUrl: () => "https://nowen.test/api" }));
vi.mock("../authSession", () => ({ getAccessToken: () => "login-token", fetchWithAuthRefresh: mocks.request }));
vi.mock("../offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => { vi.clearAllMocks(); mocks.scope = "server:user-1"; });

describe("migration REST client", () => {
  it("reads capabilities only from the current authenticated server and preserves the abort signal", async () => {
    const controller = new AbortController();
    const caps = { schemaVersion: 1, formats: ["nmf-v1"], humanApprovalRequired: true, adapterApiVersion: 1, adapters: [] };
    mocks.request.mockResolvedValue(json(caps));
    await expect(migrationApi.capabilities(controller.signal)).resolves.toEqual(caps);
    expect(mocks.request.mock.calls[0][0]).toBe("https://nowen.test/api/migrations/capabilities");
    expect(mocks.request.mock.calls[0][1]).toMatchObject({ signal: controller.signal, credentials: "include", headers: { Authorization: "Bearer login-token" } });
    mocks.request.mockResolvedValue(json({ ...caps, adapters: [{}] }));
    await expect(migrationApi.capabilities()).rejects.toThrow("MIGRATION_INVALID_RESPONSE");
    mocks.request.mockImplementation(async () => { mocks.scope = "server:user-2"; return json(caps); });
    await expect(migrationApi.capabilities()).rejects.toThrow("MIGRATION_ACCOUNT_CHANGED");
  });
  it("rejects a capability body parsed after an account change (DCC-006)", async () => {
    const response = json({});
    vi.spyOn(response, "json").mockImplementation(async () => {
      mocks.scope = "server:user-2";
      return { schemaVersion: 1, formats: ["nmf-v1"], humanApprovalRequired: true };
    });
    mocks.request.mockResolvedValue(response);
    await expect(migrationApi.capabilities()).rejects.toThrow("MIGRATION_ACCOUNT_CHANGED");
  });
  it("uploads the File body without loading its contents into JavaScript memory", async () => {
    const file = new File(["# body"], "笔记 name.md");
    mocks.request.mockResolvedValue(json({ id: "job/1", status: "SCANNING" }));
    await migrationApi.upload("job/1", file);
    const [url, init, baseUrl] = mocks.request.mock.calls[0];
    expect(url).toBe("https://nowen.test/api/migrations/job%2F1/uploads?filename=%E7%AC%94%E8%AE%B0+name.md");
    expect(init.body).toBe(file);
    expect(init.headers).toEqual({ Authorization: "Bearer login-token", "Content-Type": "application/octet-stream" });
    expect(init.credentials).toBe("include");
    expect(baseUrl).toBe("https://nowen.test/api");
  });

  it("sends the reviewed preview digest and preserves server rejection details", async () => {
    mocks.request.mockResolvedValue(json({ error: "Preview changed", code: "MIGRATION_PREVIEW_STALE" }, 409));
    await expect(migrationApi.approve("job-1", "digest-reviewed")).rejects.toMatchObject({
      status: 409, code: "MIGRATION_PREVIEW_STALE", message: "Preview changed",
    });
    expect(mocks.request.mock.calls[0][0]).toContain("/job-1/approve");
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({ previewDigest: "digest-reviewed" });
  });

  it("rejects a response from the previous account before the next staged upload", async () => {
    mocks.request.mockImplementation(async () => { mocks.scope = "server:user-2"; return json({ id: "old-job" }); });
    await expect(migrationApi.get("old-job")).rejects.toThrow("MIGRATION_ACCOUNT_CHANGED");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("includes every report page instead of silently downloading only the first hundred items", async () => {
    mocks.request.mockResolvedValueOnce(json({ job: { id: "job-1" }, items: [{ id: "item-1" }], nextCursor: "item-1" }))
      .mockResolvedValueOnce(json({ job: { id: "job-1" }, items: [{ id: "item-2" }], nextCursor: null }));
    const report = await migrationApi.report("job-1");
    expect(report.items).toEqual([{ id: "item-1" }, { id: "item-2" }]);
    expect(mocks.request.mock.calls[1][0]).toContain("report?limit=100&cursor=item-1");
  });

  it("rejects HTML login pages and malformed history instead of presenting success", async () => {
    mocks.request.mockResolvedValueOnce(new Response("<html>Login required</html>", { status: 200 }));
    await expect(migrationApi.list()).rejects.toThrow("MIGRATION_INVALID_RESPONSE");
    mocks.request.mockResolvedValueOnce(json({ items: null }));
    await expect(migrationApi.list()).rejects.toThrow("MIGRATION_INVALID_RESPONSE");
  });
});

describe("resumable migration uploads", () => {
  it("hashes bounded slices, resumes confirmed offsets and reconciles a lost chunk response", async () => {
    const chunkBytes = 4 * 1024 * 1024;
    const bytes = new Uint8Array(chunkBytes + 3); bytes.fill(42);
    const file = new NodeFile([bytes], "large.zip") as unknown as File;
    const fullRead = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Whole-file read forbidden"));
    const hash = createHash("sha256").update(bytes).digest("hex");
    let offset = 0;
    const session = () => ({ id: "up-1", jobId: "job-1", sha256: hash, size: file.size, chunkBytes, offset, status: "OPEN" });
    mocks.request.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/upload-sessions")) { expect(JSON.parse(init.body as string).sha256).toBe(hash); return json(session(), 201); }
      if (url.includes("/chunks")) {
        const chunk = init.body as Blob;
        expect(chunk.size).toBeLessThanOrEqual(chunkBytes);
        expect(init.headers).toMatchObject({ "X-Chunk-SHA256": createHash("sha256").update(new Uint8Array(await chunk.arrayBuffer())).digest("hex") });
        if (offset === 0) { offset = chunkBytes; throw new TypeError("Lost response after commit"); }
        expect(url).toContain(`offset=${chunkBytes}`); offset = file.size; return json(session());
      }
      if (url.endsWith("/up-1")) return json(session());
      if (url.endsWith("/complete")) return json({ id: "job-1", status: "UPLOADING" }, 202);
      throw new Error(url);
    });
    await expect(migrationApi.uploadResumable("job-1", file)).resolves.toMatchObject({ status: "UPLOADING" });
    expect(fullRead).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.filter(([url]) => url.includes("/chunks"))).toHaveLength(2);
  });

  it("does not send bytes after an account switch or a corrupt server offset", async () => {
    const file = new NodeFile(["small file"], "small.md") as unknown as File;
    mocks.request.mockImplementation(async () => { mocks.scope = "server:user-2"; return json({ id: "up-1" }); });
    await expect(migrationApi.uploadResumable("job-1", file)).rejects.toThrow("MIGRATION_ACCOUNT_CHANGED");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    mocks.scope = "server:user-1"; mocks.request.mockClear();
    mocks.request.mockImplementation(async (_url: string, init: RequestInit) => json({ id: "up-1", jobId: "job-1", size: file.size,
      sha256: JSON.parse(init.body as string).sha256, offset: file.size + 1, chunkBytes: 4 * 1024 * 1024, status: "OPEN" }));
    await expect(migrationApi.uploadResumable("job-1", file)).rejects.toThrow("MIGRATION_INVALID_RESPONSE");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});

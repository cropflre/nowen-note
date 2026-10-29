import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrationApi } from "../migrations";

const mocks = vi.hoisted(() => ({ request: vi.fn(), scope: "server:user-1" }));
vi.mock("../api", () => ({ getBaseUrl: () => "https://nowen.test/api" }));
vi.mock("../authSession", () => ({ getAccessToken: () => "login-token", fetchWithAuthRefresh: mocks.request }));
vi.mock("../offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => { vi.clearAllMocks(); mocks.scope = "server:user-1"; });

describe("migration REST client", () => {
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

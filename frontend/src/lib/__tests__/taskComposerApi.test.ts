import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchWithAuthRefresh } from "../authSession";
import { confirmTaskComposition, getTaskComposerContext, previewTaskComposition, registerTaskComposerCache, type TaskComposerBatch } from "../taskComposerApi";

const state = vi.hoisted(() => ({ workspace: "personal", account: "a", local: false }));
vi.mock("../api.impl", () => ({ getBaseUrl: () => "http://fixture/api", getCurrentWorkspace: () => state.workspace }));
vi.mock("../offlineScope", () => ({ getOfflineQueueStorageKey: () => `account:${state.account}` }));
vi.mock("../mobileLocalMode", () => ({ isMobileLocalMode: () => state.local }));
vi.mock("../authSession", () => ({ fetchWithAuthRefresh: vi.fn(), getAccessToken: () => "test-access-token" }));
const input = { text: "Review report", timezone: "Asia/Shanghai", lang: "en" as const, maxTasks: 12, projectId: null, fromDate: null, toDate: null, focusCount: 3, recognizeRepeat: true, recognizeTime: true };
const batch: TaskComposerBatch = { requestId: "request", previewId: "preview", timezone: "Asia/Shanghai", tasks: [{ clientId: "a", title: "Review", description: "", priority: 2, startDate: null, dueDate: null, dueAt: null, projectId: null, repeatRule: "none", repeatInterval: 1, repeatEndDate: null, repeatEndCount: null, allowDuplicate: false }] };
let removeCache: (() => void) | undefined;
beforeEach(() => { vi.clearAllMocks(); state.workspace = "personal"; state.account = "a"; state.local = false; Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); });
afterEach(() => { removeCache?.(); removeCache = undefined; });
it("uses the captured workspace and existing authenticated transport", async () => {
  state.workspace = "workspace-a"; const context = getTaskComposerContext();
  vi.mocked(fetchWithAuthRefresh).mockResolvedValue(new Response(JSON.stringify({ tasks: [] })));
  await previewTaskComposition(context, input, new AbortController().signal);
  const [url, init] = vi.mocked(fetchWithAuthRefresh).mock.calls[0];
  expect(url).toBe("http://fixture/api/ai/task-plan/preview?workspaceId=workspace-a");
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-access-token");
  expect(JSON.parse(String(init?.body))).toEqual(input);
});
it("offline and device-only mode fail before a network request", async () => {
  Object.defineProperty(navigator, "onLine", { value: false });
  await expect(confirmTaskComposition(getTaskComposerContext(), batch)).rejects.toMatchObject({ code: "OFFLINE" });
  Object.defineProperty(navigator, "onLine", { value: true }); state.local = true;
  await expect(confirmTaskComposition(getTaskComposerContext(), batch)).rejects.toMatchObject({ code: "LOCAL_MODE_UNAVAILABLE" });
  expect(fetchWithAuthRefresh).not.toHaveBeenCalled();
});
it("rejects cross-account responses without caching them", async () => {
  const cache = vi.fn(); removeCache = registerTaskComposerCache(cache);
  vi.mocked(fetchWithAuthRefresh).mockImplementation(async () => { state.account = "b"; return new Response(JSON.stringify({ tasks: [{ id: "a", title: "Private" }], createdCount: 1 })); });
  await expect(confirmTaskComposition(getTaskComposerContext(), batch)).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
  expect(cache).not.toHaveBeenCalled();
});
it("reports real API failures and rejects malformed success responses", async () => {
  vi.mocked(fetchWithAuthRefresh).mockResolvedValueOnce(new Response(JSON.stringify({ code: "FORBIDDEN" }), { status: 403 }));
  await expect(confirmTaskComposition(getTaskComposerContext(), batch)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  vi.mocked(fetchWithAuthRefresh).mockResolvedValueOnce(new Response(JSON.stringify({ tasks: [], createdCount: 0 })));
  await expect(confirmTaskComposition(getTaskComposerContext(), batch)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
it("caches only committed task rows and reports cache failure separately from creation", async () => {
  const cache = vi.fn().mockRejectedValue(new Error("disk full")); removeCache = registerTaskComposerCache(cache);
  const result = { tasks: [{ id: "created", title: "Review" }], createdCount: 1, replayed: false };
  vi.mocked(fetchWithAuthRefresh).mockResolvedValue(new Response(JSON.stringify(result)));
  expect(await confirmTaskComposition(getTaskComposerContext(), batch)).toMatchObject({ createdCount: 1, refreshFailed: true });
  expect(fetchWithAuthRefresh).toHaveBeenCalledOnce(); expect(cache).toHaveBeenCalledWith(result.tasks);
});

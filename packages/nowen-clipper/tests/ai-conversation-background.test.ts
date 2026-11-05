import assert from "node:assert/strict";
import test from "node:test";
import { AI_STORAGE_KEY } from "../src/ai-conversations/queue";
import type { ArchiveSource, CapturePreview } from "../src/ai-conversations/types";

test("background consent, durable receipts, account switches and revoked-source rebinding retain their boundaries", async (t) => {
  const extensionId = "fixture-extension";
  const popupUrl = `chrome-extension://${extensionId}/popup/index.html`;
  const data: Record<string, any> = { nowenClipperConfig: { serverUrl: "https://note.example.test", username: "alice", userId: "user-a", token: "access-a" } };
  const listeners: Array<(message: any, sender: any, send: (response: any) => void) => unknown> = [];
  const changed: Array<(changes: any) => void> = [];
  let reads = 0;
  const rawPreview: CapturePreview = { stableIds: true, accountMarker: null, warnings: ["partial"], snapshot: {
    provider: "chatgpt", accountScope: "", externalConversationId: "fixture-c", sourceUrl: "https://chatgpt.com/c/fixture-c", title: "Fixture", completeness: "partial", capturedAt: new Date().toISOString(),
    messages: [{ externalMessageId: "m-1", localSequence: 0, role: "user", text: "hello", blocks: [{ type: "markdown", text: "hello" }], capturedHtml: "<p>hello</p>", contentHash: "not-trusted", captureState: "stable" }],
  } };
  const store = { get: async (key: string) => structuredClone({ [key]: data[key] }), set: async (patch: Record<string, unknown>) => { Object.assign(data, structuredClone(patch)); } };
  globalThis.chrome = {
    runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`, onMessage: { addListener: (listener: any) => listeners.push(listener) } },
    storage: { local: store, sync: store, onChanged: { addListener: (listener: any) => changed.push(listener) } },
    tabs: { get: async (id: number) => ({ id, url: rawPreview.snapshot.sourceUrl }), onRemoved: { addListener() {} }, sendMessage: async (_id: number, message: any) => {
      if (message.type === "CONTENT_SCRIPT_PING") return { type: "CONTENT_SCRIPT_PONG", protocolVersion: "1" };
      if (message.type === "AI_PREVIEW_CONTENT") { reads += 1; return { ok: true, preview: structuredClone(rawPreview) }; }
      return { ok: true };
    } },
    alarms: { create: async () => undefined, onAlarm: { addListener() {} } },
  } as unknown as typeof chrome;
  let invalidReceipt = false;
  let sourceOffline = false;
  let sourceForbidden = false;
  const sources = new Map<string, ArchiveSource>();
  const ingested: any[] = [];
  const revisions = new Map<string, number>();
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/api/me") return Response.json({ id: "user-a", username: "alice", role: "user" });
    if (url.pathname.endsWith("/sources") && init?.method === "POST") {
      const source: ArchiveSource = { ...body, id: `source-${sources.size + 1}` };
      sources.set(source.id, source);
      return Response.json(source);
    }
    if (url.pathname.includes("/sources/") && init?.method === "PATCH") {
      const id = url.pathname.split("/").at(-1)!;
      Object.assign(sources.get(id)!, body);
      return Response.json(sources.get(id));
    }
    if (url.pathname.includes("/sources/") && init?.method === "GET") {
      if (sourceOffline) throw new TypeError("Failed to fetch");
      if (sourceForbidden) return Response.json({ error: "Source access denied", code: "AI_SOURCE_NOT_AUTHORIZED" }, { status: 403 });
      return Response.json(sources.get(url.pathname.split("/").at(-1)!));
    }
    if (url.pathname.endsWith("/conversations/ingest")) {
      ingested.push(body);
      const revision = (revisions.get(body.sourceId) || 0) + 1;
      revisions.set(body.sourceId, revision);
      return Response.json({ operationId: body.operationId, sourceId: invalidReceipt ? "wrong-source" : body.sourceId, conversationId: "archive-c", noteId: "note-c", revision, status: "applied", persisted: true, persistedAt: new Date().toISOString(), projectionStatus: "updated" });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  await import("../src/ai-conversations/background");
  const popup = { id: extensionId, url: popupUrl, tab: { id: 99 }, frameId: 0 };
  const content = { id: extensionId, url: rawPreview.snapshot.sourceUrl, tab: { id: 1 }, frameId: 0 };
  async function send(type: string, payload: object = {}, sender: any = popup): Promise<any> {
    return new Promise((resolve) => {
      const handled = listeners.some((listener) => listener({ type, tabId: 1, ...payload }, sender, resolve) === true);
      if (!handled) resolve(undefined);
    });
  }
  await t.test("ungranted content gets no read access and webpage senders cannot request preview or save", async () => {
    assert.deepEqual(await send("AI_CAPTURE_PERMISSION", { url: rawPreview.snapshot.sourceUrl }, content), { allowed: false, accountMarker: null });
    assert.equal(reads, 0);
    assert.equal(await send("AI_PREVIEW", {}, { id: extensionId, url: "https://evil.test" }), undefined);
    assert.equal(await send("AI_SAVE", {}, content), undefined);
    assert.equal(await send("AI_PREVIEW", {}, { ...popup, id: "wrong-extension" }), undefined);
    assert.equal(reads, 0);
  });
  let sourceId = "";
  await t.test("explicit preview and save return only an exact persisted receipt", async () => {
    const preview = await send("AI_PREVIEW");
    assert.equal(preview.ok, true);
    assert.equal(reads, 1);
    assert.equal(preview.preview.snapshot.messages[0].capturedHtml, undefined);
    const saved = await send("AI_SAVE", { previewId: preview.previewId, notebookId: "notebook-a", sourceName: "My ChatGPT", automatic: true });
    assert.equal(saved.ok, true);
    assert.equal(saved.pending, 0);
    assert.equal(saved.grant.receipt.persisted, true);
    assert.equal(saved.grant.receipt.revision, 1);
    sourceId = saved.grant.source.id;
    assert.equal(ingested[0].snapshot.messages[0].text, "hello");
    assert.notEqual(ingested[0].snapshot.messages[0].contentHash, "not-trusted");
    assert.equal(ingested[0].snapshot.messages[0].capturedHtml, undefined);
    assert.equal((await send("AI_CAPTURE_PERMISSION", { url: rawPreview.snapshot.sourceUrl }, content)).allowed, true);
    assert.equal((await send("AI_CAPTURE_PERMISSION", { url: "https://chatgpt.com/c/other" }, content)).allowed, false);
  });
  await t.test("switching Nowen identity never inherits another account's grant or queued content", async () => {
    const prior = data.nowenClipperConfig;
    data.nowenClipperConfig = { ...prior, userId: "user-b", token: "access-b" };
    changed.forEach((listener) => listener({ nowenClipperConfig: { oldValue: prior, newValue: data.nowenClipperConfig } }));
    assert.equal((await send("AI_CAPTURE_PERMISSION", { url: rawPreview.snapshot.sourceUrl }, content)).allowed, false);
    assert.equal((await send("AI_STATUS")).grant, undefined);
    data.nowenClipperConfig = prior;
  });
  await t.test("remote pause and 403 stop capture while a transient outage retains recent explicit consent", async () => {
    sourceOffline = true;
    assert.equal((await send("AI_CAPTURE_PERMISSION", { url: rawPreview.snapshot.sourceUrl }, content)).allowed, true);
    sourceOffline = false;
    sources.get(sourceId)!.captureEnabled = false;
    assert.equal((await send("AI_CAPTURE_PERMISSION", { url: rawPreview.snapshot.sourceUrl }, content)).allowed, false);
    const first = await send("AI_PREVIEW");
    await send("AI_SAVE", { previewId: first.previewId, notebookId: "notebook-a", sourceName: "My ChatGPT", automatic: true });
    assert.equal((await send("AI_CAPTURE_PERMISSION", { url: rawPreview.snapshot.sourceUrl }, content)).allowed, true);
    sourceForbidden = true;
    assert.equal((await send("AI_CAPTURE_PERMISSION", { url: rawPreview.snapshot.sourceUrl }, content)).allowed, false);
    sourceForbidden = false;
  });
  await t.test("pause and revoke stop further capture; new alias creates a separate source", async () => {
    await send("AI_MANAGE", { action: "pause" });
    assert.equal((await send("AI_CAPTURE_PERMISSION", { url: rawPreview.snapshot.sourceUrl }, content)).allowed, false);
    assert.equal((await send("AI_AUTOSAVE", { preview: rawPreview }, content)).ok, false);
    await send("AI_MANAGE", { action: "revoke" });
    assert.equal(sources.get(sourceId)?.permissionState, "revoked");
    const preview = await send("AI_PREVIEW");
    const rebound = await send("AI_SAVE", { previewId: preview.previewId, notebookId: "notebook-a", sourceName: "New ChatGPT account", automatic: false });
    assert.equal(rebound.ok, true);
    assert.notEqual(rebound.grant.source.id, sourceId);
    assert.notEqual(rebound.grant.source.accountScope, sources.get(sourceId)?.accountScope);
    assert.equal(sources.get(sourceId)?.permissionState, "revoked");
  });
  await t.test("DCC-001: invalid receipt leaves content queued rather than claiming success", async () => {
    invalidReceipt = true;
    const preview = await send("AI_PREVIEW");
    const result = await send("AI_SAVE", { previewId: preview.previewId, notebookId: "notebook-a", sourceName: "New ChatGPT account", automatic: false });
    assert.equal(result.ok, true);
    assert.equal(result.currentPending, 1);
    assert.match(result.grant.error, /AI_SYNC_RECEIPT_INVALID/);
    assert.equal(data[AI_STORAGE_KEY].queue.length, 1);
    assert.equal(data[AI_STORAGE_KEY].queue[0].payload.snapshot.messages[0].text, "hello");
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { AI_STORAGE_KEY } from "../src/ai-conversations/queue";
import type { ArchiveSource, CapturedMessage, CapturePreview } from "../src/ai-conversations/types";

test("one click saves the whole conversation, keeps saving new messages and keeps its boundaries", async (t) => {
  const extensionId = "fixture-extension";
  const popupUrl = `chrome-extension://${extensionId}/popup/index.html`;
  const data: Record<string, any> = { nowenClipperConfig: { serverUrl: "https://note.example.test", username: "alice", userId: "user-a", token: "access-a" } };
  const listeners: Array<(message: any, sender: any, send: (response: any) => void) => unknown> = [];
  const changed: Array<(changes: any) => void> = [];
  let reads = 0;
  let optionsOpened = 0;
  const openedTabs: string[] = [];
  const message = (id: string, text: string, role: "user" | "assistant" = "user"): CapturedMessage => ({
    externalMessageId: id, localSequence: 0, role, text, blocks: [{ type: "markdown", text }], capturedHtml: `<p>${text}</p>`, contentHash: "not-trusted", captureState: "stable",
  });
  const rawPreview: CapturePreview = { stableIds: true, accountMarker: null, warnings: ["partial"], snapshot: {
    provider: "chatgpt", accountScope: "", externalConversationId: "fixture-c", sourceUrl: "https://chatgpt.com/c/fixture-c", title: "Fixture", completeness: "partial", capturedAt: new Date().toISOString(),
    messages: [message("m-1", "hello")],
  } };
  /** Points the tab (and what the page would read) at another conversation or message list. */
  const showConversation = (id: string, messages = [message("m-1", "hello")]) => {
    rawPreview.snapshot.externalConversationId = id;
    rawPreview.snapshot.sourceUrl = `https://chatgpt.com/c/${id}`;
    rawPreview.snapshot.messages = messages.map((entry, index) => ({ ...entry, localSequence: index }));
  };
  const store = { get: async (key: string) => structuredClone({ [key]: data[key] }), set: async (patch: Record<string, unknown>) => { Object.assign(data, structuredClone(patch)); } };
  globalThis.chrome = {
    runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`, openOptionsPage: async () => { optionsOpened += 1; }, onMessage: { addListener: (listener: any) => listeners.push(listener) } },
    storage: { local: store, sync: store, onChanged: { addListener: (listener: any) => changed.push(listener) } },
    tabs: { get: async (id: number) => ({ id, url: rawPreview.snapshot.sourceUrl }), create: async ({ url }: { url: string }) => { openedTabs.push(url); }, onRemoved: { addListener() {} }, sendMessage: async (_id: number, request: any) => {
      if (request.type === "CONTENT_SCRIPT_PING") return { type: "CONTENT_SCRIPT_PONG", protocolVersion: "1" };
      if (request.type === "AI_PREVIEW_CONTENT") { reads += 1; return { ok: true, preview: structuredClone(rawPreview) }; }
      return { ok: true };
    } },
    alarms: { create: async () => undefined, onAlarm: { addListener() {} } },
  } as unknown as typeof chrome;
  let invalidReceipt = false;
  let sourceOffline = false;
  let sourceForbidden = false;
  let archiveDisabled = false;
  let conflictFor = "";
  const disabled = () => Response.json({ error: "此服务器未开启 AI 对话归档", code: "AI_MEMORY_DISABLED" }, { status: 404 });
  const sources = new Map<string, ArchiveSource>();
  const ingested: any[] = [];
  const notebooks: Array<{ id: string; name: string; parentId: null; workspaceId: null }> = [{ id: "notebook-a", name: "Notebook A", parentId: null, workspaceId: null }];
  const revisions = new Map<string, number>();
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/api/me") return Response.json({ id: "user-a", username: "alice", role: "user" });
    if (url.pathname === "/api/notebooks" && init?.method === "POST") {
      const created = { id: `notebook-${notebooks.length + 1}`, name: body.name, parentId: null, workspaceId: null } as const;
      notebooks.push(created); return Response.json(created);
    }
    if (url.pathname === "/api/notebooks") return Response.json(notebooks);
    if (archiveDisabled && url.pathname.startsWith("/api/ai-memory/")) return disabled();
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
      if (body.snapshot.externalConversationId === conflictFor) return Response.json({ error: "检测到消息插入、重排或对话分支变化", code: "AI_MESSAGE_ORDER_CONFLICT" }, { status: 409 });
      ingested.push(body);
      const key = `${body.sourceId}:${body.snapshot.externalConversationId}`;
      const revision = (revisions.get(key) || 0) + 1;
      revisions.set(key, revision);
      return Response.json({ operationId: body.operationId, sourceId: invalidReceipt ? "wrong-source" : body.sourceId, conversationId: `archive-${body.snapshot.externalConversationId}`, noteId: `note-${body.snapshot.externalConversationId}`, revision, status: "applied", persisted: true, persistedAt: new Date().toISOString(), projectionStatus: "updated" });
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
  /** A click on the page button: the content script sends what it read at that moment. */
  const click = () => send("AI_QUICK_SAVE", { preview: structuredClone(rawPreview) }, content);
  const autoSaveAllowed = async (url = rawPreview.snapshot.sourceUrl) => (await send("AI_CAPTURE_PERMISSION", { url }, content)).allowed;
  /** Whether another conversation saves by itself, asked from a tab showing that conversation. */
  const allowedFor = async (id: string) => {
    const shown = structuredClone(rawPreview.snapshot);
    showConversation(id);
    try { return await autoSaveAllowed(); } finally { Object.assign(rawPreview.snapshot, shown); }
  };

  await t.test("nothing is read or saved before a click, and only this extension's page button or popup can save", async () => {
    assert.equal(await autoSaveAllowed(), false);
    assert.equal((await send("AI_QUICK_STATUS", {}, content)).state, "idle");
    assert.equal(await send("AI_QUICK_SAVE", { preview: rawPreview }, { id: extensionId, url: "https://evil.test" }), undefined);
    assert.equal(await send("AI_QUICK_SAVE", { preview: rawPreview }, { ...content, id: "wrong-extension" }), undefined);
    assert.equal(await send("AI_QUICK_SAVE", {}, content), undefined, "the page button must send what it read during the click");
    assert.equal(await send("AI_QUICK_SAVE", { preview: rawPreview }, { ...content, frameId: 3 }), undefined);
    assert.equal((await send("AI_AUTOSAVE", { preview: rawPreview }, content)).ok, false);
    assert.equal(reads, 0);
    assert.equal(ingested.length, 0);
  });

  let sourceId = "";
  await t.test("one click saves into the AI conversations notebook under a source named after the site, then keeps saving", async () => {
    const saved = await click();
    assert.deepEqual([saved.ok, saved.state, saved.automatic, saved.canOpen, saved.message], [true, "saved", true, true, undefined]);
    assert.equal(reads, 0, "the page already sent what it read");
    assert.deepEqual(notebooks.map((notebook) => notebook.name), ["Notebook A", "AI 对话"]);
    const [source] = sources.values();
    sourceId = source.id;
    assert.equal(source.displayName, "ChatGPT");
    assert.equal(source.notebookId, "notebook-2");
    assert.equal(source.captureEnabled, true);
    assert.equal(ingested[0].mode, "manual");
    assert.equal(ingested[0].snapshot.messages[0].text, "hello");
    assert.notEqual(ingested[0].snapshot.messages[0].contentHash, "not-trusted");
    assert.equal(ingested[0].snapshot.messages[0].capturedHtml, undefined);
    assert.equal(await autoSaveAllowed(), true);
    assert.equal(await allowedFor("other"), false, "only the clicked conversation saves by itself");
    showConversation("fixture-c", [message("m-1", "hello"), message("m-2", "a new reply", "assistant")]);
    assert.equal((await send("AI_AUTOSAVE", { preview: structuredClone(rawPreview) }, content)).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ingested.at(-1).mode, "automatic");
    assert.deepEqual(ingested.at(-1).snapshot.messages.map((entry: CapturedMessage) => entry.text), ["hello", "a new reply"]);
    await send("AI_QUICK_OPEN", {}, content);
    assert.deepEqual(openedTabs, ["https://note.example.test/?noteId=note-fixture-c"]);
    assert.doesNotMatch(JSON.stringify(await send("AI_QUICK_STATUS", {}, content)), /note\.example|source-|notebook/, "the page learns no server, source or note details");
  });

  await t.test("other conversations of the site share that source and notebook; the popup button saves the same way", async () => {
    showConversation("fixture-d");
    const saved = await send("AI_QUICK_SAVE");
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(reads, 1, "from the popup the page is read once, for this click");
    assert.equal(saved.grant.source.id, sourceId);
    assert.equal(sources.size, 1);
    assert.equal(notebooks.length, 2);
    assert.equal(saved.noteUrl, "https://note.example.test/?noteId=note-fixture-d");
    showConversation("fixture-c", [message("m-1", "hello"), message("m-2", "a new reply", "assistant")]);
  });

  await t.test("switching Nowen identity never inherits another account's saving or queued content", async () => {
    const prior = data.nowenClipperConfig;
    data.nowenClipperConfig = { ...prior, userId: "user-b", token: "access-b" };
    changed.forEach((listener) => listener({ nowenClipperConfig: { oldValue: prior, newValue: data.nowenClipperConfig } }));
    assert.equal(await autoSaveAllowed(), false);
    assert.equal((await send("AI_STATUS")).grant, undefined);
    assert.equal((await send("AI_QUICK_STATUS", {}, content)).state, "idle");
    data.nowenClipperConfig = prior;
  });

  await t.test("pausing or revoking in Nowen and a 403 stop auto-saving, an outage does not, and the next click turns saving back on", async () => {
    sourceOffline = true;
    assert.equal(await autoSaveAllowed(), true);
    sourceOffline = false;
    sources.get(sourceId)!.captureEnabled = false;
    assert.equal(await autoSaveAllowed(), false);
    assert.equal((await click()).state, "saved");
    assert.equal(sources.get(sourceId)!.captureEnabled, true);
    assert.equal(await autoSaveAllowed(), true);
    Object.assign(sources.get(sourceId)!, { permissionState: "revoked", captureEnabled: false });
    assert.equal(await autoSaveAllowed(), false);
    assert.equal((await click()).state, "saved");
    assert.deepEqual([sources.get(sourceId)!.permissionState, sources.get(sourceId)!.captureEnabled], ["granted", true]);
    sourceForbidden = true;
    assert.equal(await autoSaveAllowed(), false);
    sourceForbidden = false;
  });

  await t.test("a server with the archive switched off says so and keeps the content, which the next click sends", async () => {
    assert.equal((await click()).state, "saved");
    archiveDisabled = true;
    assert.equal(await autoSaveAllowed(), false);
    assert.match((await send("AI_STATUS")).grant.error, /^AI_MEMORY_DISABLED/);
    const kept = await click();
    assert.equal(kept.state, "error");
    assert.match(kept.message, /未开启 AI 对话归档/);
    assert.equal(data[AI_STORAGE_KEY].queue.length, 1);
    assert.equal(data[AI_STORAGE_KEY].queue[0].payload.snapshot.messages[0].text, "hello");
    archiveDisabled = false;
    const sent = await click();
    assert.equal(sent.state, "saved");
    assert.equal(data[AI_STORAGE_KEY].queue.length, 0);
    assert.equal(await autoSaveAllowed(), true);
  });

  await t.test("stopping auto-save from the page stops only this conversation; clicking again resumes it", async () => {
    // Pausing the source above stopped every conversation of it; a click turns each one back on.
    const shown = structuredClone(rawPreview.snapshot);
    showConversation("fixture-d");
    assert.equal((await click()).automatic, true);
    Object.assign(rawPreview.snapshot, shown);
    const stopped = await send("AI_QUICK_STOP", {}, content);
    assert.deepEqual([stopped.state, stopped.automatic], ["saved", false]);
    assert.equal(await autoSaveAllowed(), false);
    assert.equal((await send("AI_AUTOSAVE", { preview: structuredClone(rawPreview) }, content)).ok, false);
    assert.equal(await allowedFor("fixture-d"), true);
    assert.equal((await click()).automatic, true);
    assert.equal(await autoSaveAllowed(), true);
  });

  await t.test("an edited or regenerated conversation pauses only itself, and the next click saves a new copy without touching the saved one", async () => {
    conflictFor = "fixture-c";
    const savedBefore = ingested.filter((entry) => entry.snapshot.externalConversationId === "fixture-c").length;
    showConversation("fixture-c", [message("m-1", "hello"), message("m-2b", "a regenerated reply", "assistant")]);
    assert.equal((await send("AI_AUTOSAVE", { preview: structuredClone(rawPreview) }, content)).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const paused = await send("AI_QUICK_STATUS", {}, content);
    assert.equal(paused.state, "error");
    assert.match(paused.message, /另存一份/);
    assert.equal(paused.automatic, false);
    assert.equal(await autoSaveAllowed(), false);
    assert.equal(await allowedFor("fixture-d"), true, "other conversations of the source keep saving");
    const copy = await click();
    assert.deepEqual([copy.state, copy.automatic], ["saved", true]);
    const latest = ingested.at(-1);
    assert.equal(latest.snapshot.externalConversationId, "fixture-c~2");
    assert.equal(latest.snapshot.title, "Fixture（第 2 份）");
    assert.deepEqual(latest.snapshot.messages.map((entry: CapturedMessage) => entry.text), ["hello", "a regenerated reply"]);
    assert.equal(ingested.filter((entry) => entry.snapshot.externalConversationId === "fixture-c").length, savedBefore, "the saved archive is left as it was");
    assert.equal(data[AI_STORAGE_KEY].queue.length, 0, "nothing was dropped that the copy does not contain");
    showConversation("fixture-c", [message("m-1", "hello"), message("m-2b", "a regenerated reply", "assistant"), message("m-3", "more")]);
    assert.equal((await send("AI_AUTOSAVE", { preview: structuredClone(rawPreview) }, content)).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ingested.at(-1).snapshot.externalConversationId, "fixture-c~2", "later messages keep going to the copy");
    conflictFor = "";
  });

  await t.test("DCC-001: invalid receipt leaves content queued rather than claiming success", async () => {
    invalidReceipt = true;
    showConversation("fixture-e");
    const result = await click();
    assert.equal(result.state, "saving");
    assert.match((await send("AI_STATUS")).grant.error, /AI_SYNC_RECEIPT_INVALID/);
    assert.equal(data[AI_STORAGE_KEY].queue.length, 1);
    assert.equal(data[AI_STORAGE_KEY].queue[0].payload.snapshot.messages[0].text, "hello");
    invalidReceipt = false;
  });

  await t.test("without a Nowen login the click opens the sign-in page and saves nothing", async () => {
    const prior = data.nowenClipperConfig;
    const before = ingested.length;
    data.nowenClipperConfig = { ...prior, token: "" };
    const result = await click();
    assert.equal(result.ok, false);
    assert.match(result.error, /登录/);
    assert.equal(optionsOpened, 1);
    assert.equal(ingested.length, before);
    data.nowenClipperConfig = prior;
  });
});

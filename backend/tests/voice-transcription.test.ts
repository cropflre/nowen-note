import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import JSZip from "jszip";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-voice-"));
process.env.DB_PATH = path.join(tmpDir, "voice.db"); process.env.ELECTRON_USER_DATA = tmpDir;
let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let speech: typeof import("../src/services/speechTranscription");
let settings: typeof import("../src/services/userSpeechSettings");
let extract: typeof import("../src/routes/attachments").extractInlineBase64Images;
const originalFetch = globalThis.fetch;
const AUDIO_ID = "11fe46d6-1a50-4a3b-b251-8486a1e7e9ea";
const TEXT_ID = "22fe46d6-1a50-4a3b-b251-8486a1e7e9ea";
test.before(async () => {
  const [schema, router, service, speechSettings, attachments] = await Promise.all([import("../src/db/schema"), import("../src/routes/voice"), import("../src/services/speechTranscription"), import("../src/services/userSpeechSettings"), import("../src/routes/attachments")]);
  db = schema.getDb(); closeDb = schema.closeDb; speech = service; settings = speechSettings; extract = attachments.extractInlineBase64Images;
  app = new Hono(); app.route("/voice", router.default); app.route("/attachments", attachments.default);
  for (const id of ["voice-a", "voice-b"]) db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(id, id);
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('voice-nb','voice-a','Voice')").run();
  db.prepare("INSERT INTO notes (id,userId,notebookId,title,content,contentText) VALUES ('voice-note','voice-a','voice-nb','Voice','{}','Voice')").run();
  const attachmentsDir = attachments.getAttachmentsDir(); fs.mkdirSync(attachmentsDir, { recursive: true }); fs.writeFileSync(path.join(attachmentsDir, "voice.webm"), Buffer.from([1, 2, 3]));
  const insert = db.prepare("INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,path) VALUES (?,'voice-note','voice-a',?,?,3,'voice.webm')");
  insert.run(AUDIO_ID, "voice.webm", "audio/webm"); insert.run(TEXT_ID, "text.txt", "text/plain");
});
test.after(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
test.afterEach(() => { globalThis.fetch = originalFetch; });
const request = (attachmentId: string, user = "voice-a") => app.request("/voice/transcriptions", { method: "POST", headers: { "X-User-Id": user, "Content-Type": "application/json" }, body: JSON.stringify({ attachmentId }) });

test("speech settings are isolated, masked, and independent from chat settings", async () => {
  settings.setUserSpeechSettings("voice-a", { apiUrl: "https://speech.example/v1", apiKey: "secret-a", model: "whisper-1", language: "zh" });
  const response = await app.request("/voice/settings", { headers: { "X-User-Id": "voice-a" } }); const data = await response.json();
  assert.equal(data.apiKeySet, true); assert.equal(data.configured, true); assert.equal(JSON.stringify(data).includes("secret-a"), false);
  assert.equal(settings.getUserSpeechSettings("voice-b").apiUrl, "");
  settings.setUserSpeechSettings("voice-a", { apiUrl: "https://speech.example/v1", model: "whisper-1", language: null });
  assert.equal(settings.getUserSpeechSettings("voice-a").apiKey, "secret-a");
});
test("anonymous, unauthorized, missing and non-audio attachments cannot be transcribed", async () => {
  assert.equal((await app.request("/voice/settings")).status, 401);
  assert.equal((await request(AUDIO_ID, "voice-b")).status, 403);
  assert.equal((await request(TEXT_ID)).status, 400);
  assert.equal((await request("33fe46d6-1a50-4a3b-b251-8486a1e7e9ea")).status, 404);
});
test("API tokens cannot read speech credentials or invoke paid speech services", async () => {
  for (const endpoint of ["settings", "transcriptions", "test"]) {
    const response = await app.request(`/voice/${endpoint}`, { method: endpoint === "settings" ? "GET" : "POST", headers: { "X-User-Id": "voice-a", "X-Auth-Mode": "api-token" } });
    assert.equal(response.status, 403);
  }
});
test("multipart transcription uses server credentials and returns preview text", async () => {
  globalThis.fetch = (async (url, options) => {
    assert.equal(url, "https://speech.example/v1/audio/transcriptions");
    assert.equal((options!.headers as Record<string, string>).Authorization, "Bearer secret-a");
    const form = options!.body as FormData; assert.equal(form.get("model"), "whisper-1"); assert.equal((form.get("file") as File).name, "voice.webm");
    return new Response(JSON.stringify({ text: "今天讨论发布计划", language: "zh" }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const response = await request(AUDIO_ID); assert.equal(response.status, 200); assert.equal((await response.json()).text, "今天讨论发布计划");
});
test("provider failure does not change the stored recording or leak secrets", async () => {
  globalThis.fetch = (async () => new Response("secret-a provider diagnostic", { status: 401 })) as typeof fetch;
  const response = await request(AUDIO_ID); assert.equal(response.status, 502); assert.equal((await response.text()).includes("secret-a"), false);
  assert.equal((db.prepare("SELECT size FROM attachments WHERE id=?").get(AUDIO_ID) as { size: number }).size, 3);
});
test("missing speech configuration and oversized recordings fail before provider upload", async () => {
  await assert.rejects(speech.transcribeSpeech({ apiUrl: "", apiKey: "", model: "whisper-1", language: null }, new Uint8Array(3), "voice.webm", "audio/webm"), /配置/);
  db.prepare("UPDATE attachments SET size=? WHERE id=?").run(speech.MAX_TRANSCRIPTION_BYTES + 1, AUDIO_ID);
  assert.equal((await request(AUDIO_ID)).status, 413); db.prepare("UPDATE attachments SET size=3 WHERE id=?").run(AUDIO_ID);
});
test("ZIP imported audio is extracted into attachment storage and references remain discoverable", async () => {
  const data = Buffer.from([4, 5, 6]).toString("base64");
  const result = extract(`<audio controls src="data:audio/mp4;base64,${data}"></audio>`, "voice-a", "voice-note", null);
  assert.equal(result.replacedCount, 1); assert.match(result.content, /\/api\/attachments\//);
  const row = db.prepare("SELECT mimeType FROM attachments WHERE id=?").get(result.attachmentIds[0]) as { mimeType: string }; assert.equal(row.mimeType, "audio/mp4");
  const refs = await import("../src/lib/attachmentRefs"); assert.deepEqual([...refs.extractAttachmentIdsFromContent(result.content)], result.attachmentIds);
});
test("the existing upload pipeline preserves recorded audio MIME and ownership", async () => {
  for (const mimeType of ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus"]) {
    const form = new FormData(); form.set("noteId", "voice-note");
    form.set("file", new File([new Uint8Array([1, 2, 3, mimeType.length])], `voice.${mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm"}`, { type: mimeType }));
    const response = await app.request("/attachments", { method: "POST", headers: { "X-User-Id": "voice-a" }, body: form });
    assert.equal(response.status, 201); const result = await response.json(); assert.match(result.mimeType, /^audio\//);
    const row = db.prepare("SELECT noteId, userId FROM attachments WHERE id=?").get(result.id) as { noteId: string; userId: string };
    assert.deepEqual(row, { noteId: "voice-note", userId: "voice-a" });
  }
});
test("reliable Markdown ZIP exports include nested audio sources even with inline images enabled", async () => {
  const service = await import("../src/services/reliableExportJobs");
  const created = service.createReliableMarkdownExportJob({ userId: "voice-a", inlineImages: true, notes: [{ id: "voice-note", title: "Voice", notebookName: "Memo", createdAt: "2026-09-30", updatedAt: "2026-09-30", markdown: `<audio controls><source src="/api/attachments/${AUDIO_ID}" type="audio/webm"></audio>` }] });
  let snapshot = created;
  for (let i = 0; i < 300 && snapshot.state !== "ready" && snapshot.state !== "error"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10)); snapshot = service.getReliableExportJob(created.id, "voice-a")!;
  }
  assert.equal(snapshot.state, "ready", snapshot.message);
  const downloadApp = new Hono(); downloadApp.get("/download/:token", service.handleReliableExportDownload);
  const response = await downloadApp.request(`/download/${snapshot.downloadToken}`); assert.equal(response.status, 200);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const markdown = await zip.file("Memo/Voice.md")!.async("string"); assert.match(markdown, /<audio/); assert.match(markdown, /\.\/assets\//); assert.equal(markdown.includes(`/api/attachments/${AUDIO_ID}`), false);
  const asset = Object.values(zip.files).find((entry) => !entry.dir && entry.name.endsWith(".webm")); assert.ok(asset); assert.deepEqual([...await asset.async("uint8array")], [1, 2, 3]);
});

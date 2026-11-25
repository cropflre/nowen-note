import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { AI_IMPORT_LIMITS, parseAIImport, type ImportedSnapshot } from "../src/lib/ai-memory-import-parser";

const source = { provider: "chatgpt", accountScope: "my-export" };
const node = (id: string, parent: string | null, text: unknown, extra: any = {}) => ({ id, parent, children: [], message: {
  id, author: { role: id.startsWith("u") ? "user" : "assistant" }, status: "finished_successfully", content: { content_type: "text", parts: [text] }, ...extra } });
const conversation = (id = "conversation-1") => ({ id, title: "Example", current_node: "a1", mapping: { u1: node("u1", null, "Hello"), a1: node("a1", "u1", "```js\nconst x = 1;\n```") } });
async function parse(data: string | Buffer, filename = "conversations.json", provider = "chatgpt") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ai-import-"));
  const filePath = path.join(directory, "source"); fs.writeFileSync(filePath, data);
  const snapshots: ImportedSnapshot[] = [];
  try { const report = await parseAIImport({ directory, filePath, filename, source: { ...source, provider }, onSnapshot: async snapshot => { snapshots.push(snapshot); } }); return { snapshots, report }; }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
test("AI import parses ChatGPT mapping with stable IDs, roles and Markdown code", async () => {
  const { snapshots, report } = await parse(JSON.stringify([conversation()]));
  assert.equal(report.accepted, 1); assert.equal(snapshots[0].externalConversationId, "conversation-1");
  assert.deepEqual(snapshots[0].messages.map(message => message.externalMessageId), ["u1", "a1"]);
  assert.deepEqual(snapshots[0].messages.map(message => message.role), ["user", "assistant"]);
  assert.match(snapshots[0].messages[1].text, /```js/); assert.equal(snapshots[0].completeness, "unknown");
});
test("AI import follows selected branch and reports omitted alternatives and attachments", async () => {
  const value = conversation(); (value.mapping as any).other = node("other", "u1", "other reply");
  (value.mapping as any).a1.message.content.parts.push({ asset_pointer: "missing.png" });
  const { snapshots, report } = await parse(JSON.stringify([value]));
  assert.equal(snapshots[0].messages.length, 2); assert.equal(snapshots[0].completeness, "partial");
  assert.match(snapshots[0].messages[1].text, /未导入/); assert.match(report.warnings.join(" "), /分支.*附件/);
});
test("AI import rejects ambiguous branches without current_node instead of inventing latest", async () => {
  const value: any = conversation(); delete value.current_node; value.mapping.other = node("other", "u1", "other reply");
  await assert.rejects(parse(JSON.stringify([value])), { code: "AI_IMPORT_NO_CONVERSATIONS" });
});
test("AI import skips invalid rows and duplicate conversations across numbered shards", async () => {
  const zip = new JSZip(); zip.file("conversations-0.json", JSON.stringify([conversation(), null]));
  zip.file("conversations-1.json", JSON.stringify([conversation(), conversation("second")])); zip.file("attachment.bin", "ignored");
  const { snapshots, report } = await parse(await zip.generateAsync({ type: "nodebuffer" }), "export.zip");
  assert.equal(snapshots.length, 2); assert.equal(report.skipped, 2);
});
test("AI import marks an unfinished message partial and preserves code text", async () => {
  const value = conversation(); value.mapping.a1.message.status = "in_progress";
  value.mapping.a1.message.content = { content_type: "code", text: "print('ok')", language: "python" } as any;
  const { snapshots } = await parse(JSON.stringify([value]));
  assert.equal(snapshots[0].completeness, "partial"); assert.match(snapshots[0].messages[1].text, /```python\nprint/);
});
test("AI import supports explicit JSON transcript and plain text without guessing speaker", async () => {
  const standard = { externalConversationId: "explicit", title: "Title", messages: [{ externalMessageId: "m1", role: "user", text: "hello" }] };
  const json = await parse(JSON.stringify({ conversations: [standard] }), "transcript.json", "standard");
  assert.equal(json.snapshots[0].messages[0].role, "user");
  const plain = await parse("# Heading\n<script>unsafe()</script>", "example.md", "standard");
  assert.equal(plain.snapshots[0].messages[0].role, "unknown"); assert.equal(plain.snapshots[0].sourceUrl, "");
  assert.match(plain.snapshots[0].messages[0].text, /<script>/); // Stored as inert text, never evaluated.
});
test("AI import rejects invalid JSON, wrong source, oversized upload and huge message", async () => {
  await assert.rejects(parse("{bad}"), { code: "AI_IMPORT_INVALID_JSON" });
  await assert.rejects(parse(JSON.stringify([conversation()]), "export.json", "doubao"), { code: "AI_IMPORT_SOURCE_MISMATCH" });
  const value = conversation(); value.mapping.a1.message.content.parts = ["a".repeat(256 * 1024 + 1)];
  await assert.rejects(parse(JSON.stringify([value])), { code: "AI_IMPORT_NO_CONVERSATIONS" });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ai-import-size-"));
  try {
    const filePath = path.join(directory, "large"); fs.closeSync(fs.openSync(filePath, "w")); fs.truncateSync(filePath, AI_IMPORT_LIMITS.uploadBytes + 1);
    await assert.rejects(parseAIImport({ directory, filePath, filename: "export.zip", source, onSnapshot: async () => {} }), { code: "AI_IMPORT_UPLOAD_LIMIT" });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("AI import rejects conflicting duplicate shards and overlong message identities", async () => {
  const zip = new JSZip(); zip.file("conversations-0.json", JSON.stringify([conversation()]));
  const changed = conversation(); changed.mapping.a1.message.content.parts = ["Different reply"];
  zip.file("conversations-1.json", JSON.stringify([changed]));
  await assert.rejects(parse(await zip.generateAsync({ type: "nodebuffer" }), "export.zip"), { code: "AI_IMPORT_DUPLICATE_CONFLICT" });
  const standard = { externalConversationId: "explicit", messages: [{ externalMessageId: "m".repeat(201), text: "hi", role: "user" }] };
  await assert.rejects(parse(JSON.stringify(standard), "transcript.json", "standard"), { code: "AI_IMPORT_NO_CONVERSATIONS" });
});
test("AI import roundtrips native JSON blocks, partial states, timestamps, URL and source identity", async () => {
  const snapshot: ImportedSnapshot = { provider: source.provider, accountScope: source.accountScope, externalConversationId: "native-1", title: "Code and attachment",
    sourceUrl: "https://chatgpt.com/c/native-1", completeness: "partial", capturedAt: "2026-01-03T00:00:00Z", messages: [{
      externalMessageId: "native-message", localSequence: 4, role: "assistant", text: "const n = 1 < 2;", captureState: "partial", contentHash: "original-hash",
      blocks: [{ type: "code", language: "typescript", text: "const n = 1 < 2;" }, { type: "attachment", name: "missing.pdf", url: "https://example.com/missing.pdf" }],
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    }] };
  const { snapshots, report } = await parse(JSON.stringify({ format: "nowen-ai-conversation", schemaVersion: 1, ...snapshot }));
  assert.deepEqual(snapshots[0], snapshot); assert.deepEqual(report.warnings, []);
});
test("AI import rejects unknown native versions and platform mismatch; explicit account rebind is reported", async () => {
  const snapshot = { provider: "chatgpt", accountScope: "original-account", externalConversationId: "native-1", title: "Original", sourceUrl: "https://chatgpt.com/c/native-1", completeness: "unknown", capturedAt: "2026-01-01T00:00:00Z",
    messages: [{ externalMessageId: "native-message", localSequence: 0, role: "user", text: "Original", blocks: [{ type: "markdown", text: "Original" }], captureState: "stable" }] };
  const exported = { format: "nowen-ai-conversation", schemaVersion: 1, ...snapshot };
  const rebound = await parse(JSON.stringify(exported));
  assert.equal(rebound.snapshots[0].accountScope, source.accountScope); assert.match(rebound.report.warnings.join(""), /original-account.*my-export/);
  await assert.rejects(parse(JSON.stringify({ ...exported, schemaVersion: 2 })), { code: "AI_IMPORT_FORMAT_UNSUPPORTED" });
  await assert.rejects(parse(JSON.stringify({ ...exported, format: "unknown-native-format" })), { code: "AI_IMPORT_FORMAT_UNSUPPORTED" });
  await assert.rejects(parse(JSON.stringify(exported), "native.json", "doubao"), { code: "AI_IMPORT_SOURCE_MISMATCH" });
  await assert.rejects(parse(JSON.stringify({ ...exported, messages: [{ ...exported.messages[0], blocks: [{ type: "executable", text: "bad" }] }] })), { code: "AI_IMPORT_INVALID_TRANSCRIPT" });
});
test("AI import rejects traversal, symlinks and compression bombs before extracting content", async () => {
  for (const kind of ["traversal", "symlink", "bomb"]) {
    const zip = new JSZip(); zip.file("conversations.json", JSON.stringify([conversation()]));
    if (kind === "traversal") zip.file("../outside.txt", "bad");
    if (kind === "symlink") zip.file("link", "/tmp/target", { unixPermissions: 0o120777 });
    if (kind === "bomb") zip.file("bomb.txt", "A".repeat(3 * 1024 * 1024));
    await assert.rejects(parse(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" }), "export.zip"), { code: "AI_IMPORT_UNSAFE_ZIP" });
  }
});

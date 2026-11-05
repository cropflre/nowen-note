import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { detectConversation, extractConversation } from "../src/ai-conversations/adapters";
import { normalizePreview } from "../src/ai-conversations/normalize";
import { createCaptureController } from "../src/ai-conversations/capture";
import type { CapturePreview } from "../src/ai-conversations/types";

async function fixture(name = "chatgpt") {
  return new JSDOM(await readFile(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8"), { url: name === "chatgpt" ? "https://chatgpt.com/c/fixture-c" : "https://www.doubao.com/chat/fixture-d" });
}
const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

test("detects only supported exact conversation hosts and paths", () => {
  assert.equal(detectConversation("https://chatgpt.com/c/abc?ignored=1")?.id, "abc");
  assert.equal(detectConversation("https://chat.openai.com/c/abc")?.provider, "chatgpt");
  assert.equal(detectConversation("https://www.doubao.com/chat/123")?.provider, "doubao");
  for (const url of ["https://chatgpt.com.evil.test/c/abc", "https://chatgpt.com/share/abc", "https://chatgpt.com/", "http://chatgpt.com/c/abc", "https://claude.ai/chat/abc"]) assert.equal(detectConversation(url), null);
});

test("ChatGPT fixture preserves Markdown code, tables and lists without hidden body or controls", async () => {
  const dom = await fixture();
  const result = await normalizePreview(await extractConversation(dom.window.document, dom.window.location.href));
  assert.equal(result.snapshot.messages.length, 2);
  assert.equal(result.stableIds, true);
  assert.equal(result.snapshot.completeness, "partial");
  assert.equal(result.accountMarker, "fixture-account-a");
  const text = result.snapshot.messages[1].text;
  assert.match(text, /```typescript\nconst answer = 42;/);
  assert.match(text, /console\.log\(answer\);\n```/);
  assert.match(text, /\*\s+保留列表|-\s+保留列表/);
  assert.match(text, /\| 项目 \| 值 \|/);
  assert.doesNotMatch(JSON.stringify(result), /秘密|不能读取隐藏正文|Copy|capturedHtml/);
  dom.window.close();
});

test("Doubao fixture extracts distinct roles, code language and conservative completeness", async () => {
  const dom = await fixture("doubao");
  const result = await normalizePreview(await extractConversation(dom.window.document, dom.window.location.href));
  assert.deepEqual(result.snapshot.messages.map((m) => m.role), ["user", "assistant"]);
  assert.match(result.snapshot.messages[1].text, /```python\nprint\("你好"\)/);
  assert.equal(result.snapshot.completeness, "partial");
  assert.equal(result.accountMarker, null);
  dom.window.close();
});

test("unknown markup fails explicitly; inferred IDs are manual-only and duplicate IDs are rejected", async () => {
  const dom = await fixture();
  const doc = dom.window.document;
  doc.querySelectorAll("[data-message-id]").forEach((node) => node.removeAttribute("data-message-id"));
  const inferred = await extractConversation(doc, dom.window.location.href);
  assert.equal(inferred.stableIds, false);
  assert.match(inferred.snapshot.messages[0].externalMessageId, /^inferred:/);
  doc.querySelectorAll("[data-message-author-role]").forEach((node) => node.setAttribute("data-message-id", "duplicate"));
  await assert.rejects(() => extractConversation(doc, dom.window.location.href), /身份存在歧义/);
  doc.body.innerHTML = "<p>网站改版了</p>";
  await assert.rejects(() => extractConversation(doc, dom.window.location.href), /AI_MESSAGE_PARSE_FAILED/);
  dom.window.close();
});

test("DCC-006: denied authorization never accesses document body or constructs an observer", async () => {
  let reads = 0;
  const doc = new Proxy({} as Document, { get() { reads += 1; throw new Error("unauthorized DOM read"); } });
  const controller = createCaptureController({ doc, url: () => "https://chatgpt.com/c/a", permission: async () => ({ allowed: false }), submit: async () => assert.fail("must not submit"), fail: () => assert.fail("must not fail") });
  await controller.refresh();
  await pause();
  controller.stop();
  assert.equal(reads, 0);
});

test("streams retain one stable message identity and revoke immediately stops later DOM collection", async () => {
  const dom = await fixture();
  const doc = dom.window.document;
  const assistant = doc.querySelector('[data-message-id="c-assistant-1"]')!;
  assistant.setAttribute("data-is-streaming", "true");
  let allowed = true;
  const submitted: CapturePreview[] = [];
  const controller = createCaptureController({ doc, url: () => dom.window.location.href, debounceMs: 5,
    permission: async () => ({ allowed, accountMarker: "fixture-account-a" }), submit: async (result) => { submitted.push(result); }, fail: (error) => assert.fail(error) });
  await controller.refresh();
  await pause(80);
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].snapshot.messages.map((m) => m.externalMessageId), ["c-user-1"]);
  assistant.removeAttribute("data-is-streaming");
  await pause(80);
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[1].snapshot.messages.map((m) => m.externalMessageId), ["c-user-1", "c-assistant-1"]);
  allowed = false;
  await controller.refresh();
  assistant.append("授权撤销后不能读取");
  await pause();
  assert.equal(submitted.length, 2);
  controller.stop();
  dom.window.close();
});

test("account marker changes fail closed and page-switch generation discards stale extraction", async () => {
  const dom = await fixture();
  let error = "";
  const controller = createCaptureController({ doc: dom.window.document, url: () => dom.window.location.href, debounceMs: 5,
    permission: async () => ({ allowed: true, accountMarker: "different-account" }), submit: async () => assert.fail("must not submit mixed accounts"), fail: (message) => { error = message; } });
  await controller.refresh();
  await pause(80);
  assert.match(error, /AI_SOURCE_NOT_AUTHORIZED/);
  controller.stop();
  let resolveExtraction!: (preview: CapturePreview) => void;
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let url = dom.window.location.href;
  const preview = await extractConversation(dom.window.document, url);
  const delayed = createCaptureController({ doc: dom.window.document, url: () => url, debounceMs: 1,
    permission: async () => ({ allowed: true }), extract: async () => { started(); return new Promise((resolve) => { resolveExtraction = resolve; }); },
    submit: async () => assert.fail("must not submit previous-page extraction"), fail: (message) => assert.fail(message) });
  await delayed.refresh();
  await start;
  url = "https://chatgpt.com/c/other";
  delayed.stop();
  resolveExtraction(preview);
  await pause();
  dom.window.close();
});

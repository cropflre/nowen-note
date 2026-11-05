import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";

/** Runs the built MV3 worker/content script against locally fulfilled site fixtures. */
export async function acceptAIMemoryClipper({ chromium, root, temporary, backendBase, login, notebook, request, record }) {
  const extension = path.join(root, "packages/nowen-clipper/dist");
  let offline = false;
  const proxy = http.createServer(async (incoming, outgoing) => {
    if (offline) { outgoing.writeHead(503, { "Content-Type": "application/json" }); outgoing.end('{"error":"Synthetic offline fixture"}'); return; }
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = { ...incoming.headers, host: new URL(backendBase).host, "accept-encoding": "identity" };
      const response = await fetch(`${backendBase}${incoming.url}`, { method: incoming.method, headers,
        ...(body.length ? { body } : {}) });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(502); outgoing.end(); }
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const destination = `http://127.0.0.1:${proxy.address().port}`;
  const context = await chromium.launchPersistentContext(path.join(temporary, "chromium-extension"), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async config => {
      await chrome.storage.sync.set({ nowenClipperConfig: config });
    }, { serverUrl: destination, userId: login.user.id, username: login.user.username,
      token: login.token, refreshToken: login.refreshToken, defaultNotebook: notebook.name });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    const send = message => popup.evaluate(value => chrome.runtime.sendMessage(value), message);
    const until = async (check, label, timeout = 20_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      throw new Error(`Timed out: ${label}`);
    };
    for (const provider of ["chatgpt", "doubao"]) {
      const id = `fixture-${provider}`;
      const url = provider === "chatgpt" ? `https://chatgpt.com/c/${id}` : `https://www.doubao.com/chat/${id}`;
      let fixture = await fs.readFile(path.join(root, `packages/nowen-clipper/tests/fixtures/${provider}.html`), "utf8");
      const site = await context.newPage();
      await site.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html", body: fixture }));
      await site.goto(url);
      const tabId = await worker.evaluate(async siteUrl => (await chrome.tabs.query({})).find(tab => tab.url === siteUrl)?.id, url);
      assert.ok(Number.isInteger(tabId));
      const before = await request(`/ai-memory/conversations?externalConversationId=${id}`);
      assert.equal(before.items.length, 0);
      const unauthorized = await send({ type: "AI_STATUS", tabId });
      assert.equal(unauthorized.ok, true);
      assert.equal(unauthorized.grant, undefined);
      const preview = await send({ type: "AI_PREVIEW", tabId });
      assert.equal(preview.ok, true, preview.error);
      assert.equal(preview.preview.snapshot.messages.length, 2);
      assert.equal(preview.preview.snapshot.messages.some(message => message.text.includes("秘密")), false);
      assert.ok(preview.preview.snapshot.messages[1].text.includes("```"));
      const save = await send({ type: "AI_SAVE", tabId, previewId: preview.previewId,
        notebookId: notebook.id, sourceName: `${provider} 受控页面验收`, automatic: true });
      assert.equal(save.ok, true, save.error);
      assert.equal(save.currentPending, 0);
      assert.equal(save.grant.receipt.persisted, true);
      const conversationId = save.grant.receipt.conversationId;
      const raw = () => request(`/ai-memory/conversations/${conversationId}/messages`);
      assert.equal((await raw()).items.length, 2);
      record(`${provider} real MV3 manual preview, visible code capture and durable receipt`);
      await site.evaluate(provider => {
        const message = document.createElement("div");
        message.dataset.messageId = "stream-fixture";
        if (provider === "chatgpt") message.dataset.messageAuthorRole = "assistant";
        else message.dataset.testid = "receive_message";
        message.dataset.isStreaming = "true";
        message.textContent = "暂时的流式文本";
        document.querySelector("main").append(message);
      }, provider);
      await new Promise(resolve => setTimeout(resolve, 3700));
      assert.equal((await raw()).items.some(message => message.externalMessageId === "stream-fixture"), false);
      await site.evaluate(() => {
        const message = document.querySelector('[data-message-id="stream-fixture"]');
        message.textContent = "稳定后才保存的最终回复";
        message.removeAttribute("data-is-streaming");
      });
      await until(async () => (await raw()).items.find(message => message.externalMessageId === "stream-fixture" && message.text === "稳定后才保存的最终回复"), "stable automatic reply");
      assert.equal((await raw()).items.length, 3);
      record(`${provider} streaming reply stays transient and stable reply is archived once`);
      fixture = await site.content();
      await site.reload();
      await new Promise(resolve => setTimeout(resolve, 3700));
      assert.equal((await raw()).items.length, 3);
      record(`${provider} refresh preserves the archive without duplicate or inferred deletion`);
      offline = true;
      await site.evaluate(provider => {
        const message = document.createElement("div"); message.dataset.messageId = "offline-fixture";
        if (provider === "chatgpt") message.dataset.messageAuthorRole = "user";
        else message.dataset.testid = "send_message";
        message.textContent = "断网时留在有界本地队列"; document.querySelector("main").append(message);
      }, provider);
      await until(async () => (await send({ type: "AI_STATUS", tabId })).currentPending > 0, "durable offline queue");
      assert.equal((await raw()).items.length, 3);
      offline = false;
      assert.equal((await send({ type: "AI_MANAGE", tabId, action: "retry" })).ok, true);
      await until(async () => (await raw()).items.length === 4 && (await send({ type: "AI_STATUS", tabId })).currentPending === 0, "queued replay after reconnect");
      record(`${provider} outage keeps a pending local operation and reconnect replays it once`);
      const paused = await send({ type: "AI_MANAGE", tabId, action: "revoke" });
      assert.equal(paused.ok, true, paused.error);
      await site.evaluate(provider => {
        const message = document.createElement("div"); message.dataset.messageId = "after-revoke";
        if (provider === "chatgpt") message.dataset.messageAuthorRole = "user";
        else message.dataset.testid = "send_message";
        message.textContent = "撤销后的新消息"; document.querySelector("main").append(message);
      }, provider);
      await new Promise(resolve => setTimeout(resolve, 3700));
      assert.equal((await raw()).items.length, 4);
      record(`${provider} explicit revocation stops subsequent capture`);
      await site.close();
    }
  } finally { await context.close(); await new Promise(resolve => proxy.close(resolve)); }
}

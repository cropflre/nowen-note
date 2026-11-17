import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createSaveButton } from "../src/ai-conversations/save-button";
import type { QuickStatus } from "../src/ai-conversations/types";

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test("the page button saves on a real click, reports honestly and ignores synthetic clicks", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chatgpt.com/c/fixture-c" });
  const doc = dom.window.document;
  const real = new WeakSet<Event>();
  let saves = 0;
  let finish: (status: QuickStatus) => void = () => undefined;
  let fail: ((error: Error) => void) | undefined;
  let reply: QuickStatus = { state: "idle", automatic: false, canOpen: false };
  const button = createSaveButton(doc, {
    save: () => { saves += 1; return new Promise((resolve, reject) => { finish = resolve; fail = reject; }); },
    status: async () => reply,
    stop: async () => ({ state: "saved", automatic: false, canOpen: true }),
    open: async () => ({ state: "saved", automatic: true, canOpen: true }),
    trusted: (event) => real.has(event),
  });
  const [main, , ] = button.root.querySelectorAll("button");
  const detail = button.root.querySelector(".detail") as HTMLElement;
  const stop = button.root.querySelectorAll("button")[2];
  const realClick = (target: Element) => { const event = new dom.window.MouseEvent("click", { bubbles: true }); real.add(event); target.dispatchEvent(event); };

  button.show();
  await pause();
  assert.equal(doc.querySelectorAll("nowen-ai-save").length, 1);
  assert.equal(main.textContent, "存到 Nowen");
  button.show();
  assert.equal(doc.querySelectorAll("nowen-ai-save").length, 1, "showing twice adds no second button");

  (main as HTMLButtonElement).click();
  main.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(saves, 0, "a click the page synthesizes does not read or save anything");

  realClick(main);
  realClick(main);
  assert.equal(saves, 1, "a second click while saving is ignored");
  assert.equal(main.textContent, "正在保存…");
  assert.equal((main as HTMLButtonElement).disabled, true);
  finish({ state: "saved", automatic: true, canOpen: true });
  await pause();
  assert.equal(main.textContent, "已存 · 自动保存中");
  assert.equal((main as HTMLButtonElement).disabled, false);
  assert.equal(stop.hidden, false);
  assert.equal(detail.hidden, true);

  realClick(stop);
  await pause();
  assert.equal(main.textContent, "已存 · 点击更新");
  assert.equal(stop.hidden, true);

  realClick(main);
  fail!(new Error("AI_MEMORY_DISABLED：此 Nowen 服务器未开启 AI 对话归档"));
  await pause();
  assert.equal(main.textContent, "存到 Nowen");
  assert.equal(detail.hidden, false);
  assert.equal(detail.textContent, "此 Nowen 服务器未开启 AI 对话归档", "codes are for logs, not for people");
  detail.click();
  assert.equal(detail.hidden, true, "a message can be put away so it stops covering the chat");
  reply = { state: "error", automatic: false, canOpen: false, message: "AI_MEMORY_DISABLED：此 Nowen 服务器未开启 AI 对话归档" };
  await button.refresh();
  assert.equal(detail.hidden, true, "the same message stays put away");
  reply = { ...reply, message: "[503] 服务暂时不可用" };
  await button.refresh();
  assert.equal(detail.hidden, false, "a different message shows again");

  button.hide();
  assert.equal(doc.querySelector("nowen-ai-save"), null);
  dom.window.close();
});

test("the content runtime shows the button only on supported conversations and reads chats only through it", async () => {
  const html = await readFile(new URL("./fixtures/chatgpt.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://chatgpt.com/", runScripts: "outside-only" });
  const sent: any[] = [];
  const listeners: Array<(message: any, sender: any, respond: (value: unknown) => void) => unknown> = [];
  const roots: ShadowRoot[] = [];
  const attach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (init: ShadowRootInit) { const root = attach.call(this, init); roots.push(root); return root; };
  globalThis.chrome = { runtime: { id: "fixture-extension", sendMessage: async (message: any) => {
    sent.push(message);
    if (message.type === "AI_CAPTURE_PERMISSION") return { allowed: false };
    return { ok: true, state: "idle", automatic: false, canOpen: false };
  }, onMessage: { addListener: (listener: any) => listeners.push(listener), removeListener() {} } } } as unknown as typeof chrome;
  const { installAICaptureRuntime } = await import("../src/ai-conversations/capture");
  const cleanup = installAICaptureRuntime(dom.window.document, dom.window as unknown as Window);
  try {
    await pause();
    assert.equal(dom.window.document.querySelector("nowen-ai-save"), null, "no button on pages that are not a conversation");
    dom.reconfigure({ url: "https://chatgpt.com/c/fixture-c" });
    await pause(1100);
    assert.equal(dom.window.document.querySelectorAll("nowen-ai-save").length, 1);
    assert.deepEqual([...new Set(sent.map((message) => message.type))].sort(), ["AI_CAPTURE_PERMISSION", "AI_QUICK_STATUS"], "showing the button reads no chat content");
    (roots.at(-1)!.querySelector("button") as HTMLButtonElement).click();
    await pause(500);
    assert.equal(sent.some((message) => message.type === "AI_QUICK_SAVE"), false, "a script-made click saves nothing");
    dom.reconfigure({ url: "https://chatgpt.com/share/fixture-c" });
    await pause(1100);
    assert.equal(dom.window.document.querySelector("nowen-ai-save"), null, "leaving the conversation removes the button");
  } finally {
    cleanup();
    dom.window.Element.prototype.attachShadow = attach;
    dom.window.close();
  }
});

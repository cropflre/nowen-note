import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createSaveButton } from "../src/ai-conversations/save-button";
import { initAIConversationPanel } from "../src/ai-conversations/popup";
import type { QuickStatus } from "../src/ai-conversations/types";

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
/** chrome.storage.local plus the change event a real browser delivers to every extension context, content scripts included. */
function fakeStorage() {
  const data: Record<string, unknown> = {};
  const listeners: Listener[] = [];
  let reads = 0;
  return {
    data,
    listeners,
    get reads() { return reads; },
    local: {
      get: async (key: string) => { reads += 1; return key in data ? { [key]: data[key] } : {}; },
      set: async (items: Record<string, unknown>) => {
        Object.assign(data, items);
        const changes = Object.fromEntries(Object.entries(items).map(([key, newValue]) => [key, { newValue }]));
        for (const listener of [...listeners]) listener(changes, "local");
      },
    },
    onChanged: {
      addListener: (listener: Listener) => listeners.push(listener),
      removeListener: (listener: Listener) => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
    },
  };
}

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
    dismiss: () => undefined,
    trusted: (event) => real.has(event),
  });
  const main = button.root.querySelector(".main") as HTMLButtonElement;
  const detail = button.root.querySelector(".detail") as HTMLElement;
  const stop = button.root.querySelectorAll(".more button")[1] as HTMLButtonElement;
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
  const storage = fakeStorage();
  const attach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (init: ShadowRootInit) { const root = attach.call(this, init); roots.push(root); return root; };
  globalThis.chrome = { runtime: { id: "fixture-extension", sendMessage: async (message: any) => {
    sent.push(message);
    if (message.type === "AI_CAPTURE_PERMISSION") return { allowed: false };
    return { ok: true, state: "idle", automatic: false, canOpen: false };
  }, onMessage: { addListener: (listener: any) => listeners.push(listener), removeListener() {} } }, storage } as unknown as typeof chrome;
  const { installAICaptureRuntime } = await import("../src/ai-conversations/capture");
  const cleanup = installAICaptureRuntime(dom.window.document, dom.window as unknown as Window);
  try {
    await pause();
    assert.equal(dom.window.document.querySelector("nowen-ai-save"), null, "no button on pages that are not a conversation");
    assert.deepEqual([storage.listeners.length, storage.reads], [0, 0], "a page that is not a conversation neither watches nor reads the stored choice");
    dom.reconfigure({ url: "https://chatgpt.com/c/fixture-c" });
    await pause(1100);
    assert.equal(dom.window.document.querySelectorAll("nowen-ai-save").length, 1);
    assert.deepEqual([storage.listeners.length, storage.reads], [1, 1], "a conversation reads the stored choice once and watches for changes");
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
  assert.equal(storage.listeners.length, 0, "stopping the runtime releases the storage listener");
});

test("the ✕ closes the button, and only for a real click", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chatgpt.com/c/fixture-c" });
  const doc = dom.window.document;
  const real = new WeakSet<Event>();
  const idle: QuickStatus = { state: "idle", automatic: false, canOpen: false };
  let dismissed = 0;
  const button = createSaveButton(doc, {
    save: async () => idle, status: async () => idle, stop: async () => idle, open: async () => idle,
    dismiss: () => { dismissed += 1; },
    trusted: (event) => real.has(event),
  });
  const close = button.root.querySelector(".close") as HTMLButtonElement;
  button.show();
  await pause();
  assert.equal(close.getAttribute("aria-label"), "隐藏「存到 Nowen」按钮", "the control has a name for screen readers");
  assert.match(close.title, /重新显示/, "the tooltip says how to get the button back");

  close.click();
  assert.equal(dismissed, 0, "a click the page synthesizes does not close it for good");
  assert.equal(doc.querySelectorAll("nowen-ai-save").length, 1);

  const click = new dom.window.MouseEvent("click", { bubbles: true });
  real.add(click);
  close.dispatchEvent(click);
  assert.equal(dismissed, 1);
  assert.equal(doc.querySelector("nowen-ai-save"), null, "closing takes the button away at once");
  dom.window.close();
});

test("a closed button stays away on every chat page until the popup turns it back on", async () => {
  const html = await readFile(new URL("./fixtures/chatgpt.html", import.meta.url), "utf8");
  const popupHtml = await readFile(new URL("../src/popup/index.html", import.meta.url), "utf8");
  const storage = fakeStorage();
  const real = new WeakSet<Event>();
  const trusted = (event: Event) => real.has(event);
  globalThis.chrome = { runtime: { id: "fixture-extension", sendMessage: async (message: any) => {
    if (message.type === "AI_CAPTURE_PERMISSION") return { allowed: false };
    if (message.type === "AI_STATUS") return { ok: true, pending: 0, blocked: 0, currentPending: 0 };
    return { ok: true, state: "idle", automatic: false, canOpen: false };
  }, onMessage: { addListener() {}, removeListener() {} } }, storage } as unknown as typeof chrome;
  const { installAICaptureRuntime } = await import("../src/ai-conversations/capture");

  const windows: JSDOM[] = [];
  const cleanups: Array<() => void> = [];
  const open = () => { const dom = new JSDOM(html, { url: "https://chatgpt.com/c/fixture-c", runScripts: "outside-only" }); windows.push(dom); return dom; };
  const install = (dom: JSDOM) => { cleanups.push(installAICaptureRuntime(dom.window.document, dom.window as unknown as Window, trusted)); };
  const shown = (...pages: JSDOM[]) => pages.map((dom) => dom.window.document.querySelectorAll("nowen-ai-save").length);
  try {
    const first = open();
    let firstRoot: ShadowRoot | undefined;
    const attach = first.window.Element.prototype.attachShadow;
    first.window.Element.prototype.attachShadow = function (init: ShadowRootInit) { firstRoot = attach.call(this, init); return firstRoot; };
    const second = open();
    install(first);
    install(second);
    await pause(30);
    assert.deepEqual(shown(first, second), [1, 1], "nothing was closed yet, so both pages show the button");

    const click = new first.window.MouseEvent("click", { bubbles: true });
    real.add(click);
    firstRoot!.querySelector(".close")!.dispatchEvent(click);
    assert.deepEqual(shown(first), [0], "closing takes the button away at once");
    await pause(30);
    assert.deepEqual(shown(second), [0], "the other open chat page follows");
    assert.deepEqual(Object.values(storage.data), [true], "the choice is kept for later pages");

    await pause(1100);
    assert.deepEqual(shown(first, second), [0, 0], "the pages' own polling does not bring it back");

    // Every write of the archive state is announced to the listeners too; none of it is about this button.
    const [key] = Object.keys(storage.data);
    await storage.local.set({ archiveState: { grants: {}, queue: [] } });
    for (const listener of storage.listeners) listener({ [key]: { newValue: false } }, "sync");
    await pause(30);
    assert.deepEqual(shown(first, second), [0, 0], "other keys, and the same key in another storage area, do not bring it back");

    const later = open();
    install(later);
    assert.deepEqual(shown(later), [0], "a page opened later never flashes the button before the saved choice is read");
    await pause(30);
    assert.deepEqual(shown(later), [0], "and keeps it away afterwards");

    const popup = new JSDOM(popupHtml, { url: "chrome-extension://fixture-extension/popup/index.html" });
    windows.push(popup);
    Object.assign(globalThis, { window: popup.window, document: popup.window.document });
    initAIConversationPanel({ id: 7, url: "https://chatgpt.com/c/fixture-c" } as chrome.tabs.Tab);
    const checkbox = popup.window.document.getElementById("ai-page-button") as HTMLInputElement;
    const choose = async (checked: boolean) => {
      checkbox.checked = checked;
      checkbox.dispatchEvent(new popup.window.Event("change", { bubbles: true }));
      await pause(30);
    };
    await pause(30);
    assert.equal(checkbox.checked, false, "the popup shows that the button is hidden");
    await choose(true);
    assert.deepEqual(shown(first, second, later), [1, 1, 1], "turning it on in the popup brings it back on every open page");
    await choose(false);
    assert.deepEqual(shown(first, second, later), [0, 0, 0], "turning it off hides it everywhere again");
  } finally {
    for (const cleanup of cleanups) cleanup();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
    for (const dom of windows) dom.window.close();
  }
});

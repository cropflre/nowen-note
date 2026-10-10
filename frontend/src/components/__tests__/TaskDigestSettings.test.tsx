import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskDigestSettings from "../automation/TaskDigestSettings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  listWebhooks: vi.fn(),
  addWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  removeWebhook: vi.fn(),
  save: vi.fn(),
  preview: vi.fn(),
  test: vi.fn(),
}));

vi.mock("@/lib/taskDigestApi", () => ({ taskDigestApi: mocks }));

const events = ["task.digest.morning", "task.digest.evening", "task.due"];
const destination = {
  id: "digest-1",
  url: "https://push.example/hooks?token=SECRET_123",
  events,
  description: "每日任务简报",
  isActive: 1,
};
const other = {
  id: "general-1", url: "https://general.example/all", events: ["*"],
  description: "通用 Webhook", isActive: 1,
};
const config = {
  userId: "owner", morningEnabled: 1, eveningEnabled: 1, dueEnabled: 0,
  morningTime: "09:00", eveningTime: "21:00", timezone: "Asia/Shanghai",
};
let root: Root;
let host: HTMLDivElement;

async function ready() {
  await act(async () => { root.render(<TaskDigestSettings />); });
  await act(async () => { await Promise.resolve(); });
  expect(host.textContent).toContain("推送目的地");
}
function action(name: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);
  if (!button) throw new Error("Missing button: " + name);
  return button;
}
async function click(button: HTMLButtonElement) {
  await act(async () => { button.click(); });
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(config);
  mocks.listWebhooks.mockResolvedValue([destination, other]);
  mocks.updateWebhook.mockResolvedValue({ ...destination, url: "https://next.example/notify" });
  mocks.removeWebhook.mockResolvedValue({ success: true });
  mocks.addWebhook.mockResolvedValue({ id: "digest-2", secret: "one-time-secret" });
  vi.stubGlobal("confirm", vi.fn(() => true));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Issue #819 task digest push destination management", () => {
  it("lists dedicated bindings with masked query tokens; never exposes generic hooks for deletion", async () => {
    await ready();
    expect(host.textContent).toContain("1 个专用绑定");
    expect(host.textContent).toContain("push.example/•••?•••");
    expect(host.textContent).not.toContain("SECRET_123");
    expect(host.textContent).not.toContain("/hooks");
    expect(host.textContent).toContain("另有 1 个通用或混合事件 Webhook");
    expect(host.querySelectorAll('ul[aria-label="已绑定的任务简报推送地址"] li')).toHaveLength(1);
    expect(host.textContent).not.toContain("general.example/all");
  });

  it("edits the original webhook URL without recreating its secret or changing event subscriptions", async () => {
    await ready();
    await click(action("修改"));
    const edit = host.querySelector<HTMLInputElement>('input[aria-label="修改 Webhook 接收地址"]')!;
    expect(edit.value).toBe(destination.url);
    await fill(edit, "https://next.example/notify");
    mocks.listWebhooks.mockResolvedValue([{ ...destination, url: "https://next.example/notify" }, other]);
    await click(action("保存修改"));
    expect(mocks.updateWebhook).toHaveBeenCalledWith("digest-1", "https://next.example/notify");
    expect(mocks.removeWebhook).not.toHaveBeenCalled();
    expect(mocks.addWebhook).not.toHaveBeenCalled();
    expect(host.textContent).toContain("签名密钥和事件订阅保持不变");
    expect(host.textContent).toContain("next.example/•••");
  });

  it("rejects invalid URL and cancels unbind without touching persistent data", async () => {
    await ready();
    await click(action("修改"));
    const edit = host.querySelector<HTMLInputElement>('input[aria-label="修改 Webhook 接收地址"]')!;
    await fill(edit, "http://127.0.0.1/receiver");
    await click(action("保存修改"));
    expect(host.textContent).toContain("必须为 HTTPS");
    expect(mocks.updateWebhook).not.toHaveBeenCalled();
    await click(action("取消"));
    vi.stubGlobal("confirm", vi.fn(() => false));
    await click(action("解绑"));
    expect(mocks.removeWebhook).not.toHaveBeenCalled();
  });

  it("removes only the selected task-digest webhook after confirmation and refreshes the list", async () => {
    await ready();
    mocks.listWebhooks.mockResolvedValue([other]);
    await click(action("解绑"));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(mocks.removeWebhook).toHaveBeenCalledWith("digest-1");
    expect(host.textContent).toContain("已解绑");
    expect(host.textContent).toContain("尚未绑定任务简报的专用接收地址");
    expect(mocks.updateWebhook).not.toHaveBeenCalled();
  });

  it("binds a new destination and shows the newly generated secret only once", async () => {
    await ready();
    await fill(host.querySelector<HTMLInputElement>('input[aria-label="Webhook 接收地址"]')!, "https://new.example/webhook");
    mocks.listWebhooks.mockResolvedValue([destination, { ...destination, id: "digest-2", url: "https://new.example/webhook" }, other]);
    await click(action("绑定新地址"));
    expect(mocks.addWebhook).toHaveBeenCalledWith("https://new.example/webhook");
    expect(host.textContent).toContain("one-time-secret");
    await click(action("我已保存"));
    expect(host.textContent).not.toContain("one-time-secret");
  });
});

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createJob: vi.fn(), listJobs: vi.fn(), getJob: vi.fn(), cancelJob: vi.fn(), retryJob: vi.fn(),
  actions: { refreshNotes: vi.fn(), setActiveNote: vi.fn() },
}));
vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: { activeNote: null, notes: [], notebooks: [] } }),
  useAppActions: () => mocks.actions,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "zh-CN" }, t: (_key: string, options: { defaultValue: string }) => options.defaultValue }),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/lib/api", () => ({ api: { getNote: vi.fn() } }));
vi.mock("@/lib/remoteImageLocalizationApi", async (original) => ({
  ...await original<typeof import("@/lib/remoteImageLocalizationApi")>(), remoteImageLocalizationApi: mocks,
}));
import Panel from "../RemoteImageLocalizationPanel";

function job(status = "queued") {
  return {
    id: "job-1", status, cancelRequested: false,
    summary: { totalNotes: 105, scannedNotes: 0, processedNotes: 0, localizedUrls: 0, failedUrls: 0 },
    failures: [], noteResults: [],
  };
}
let root: Root;
let container: HTMLDivElement;
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.listJobs.mockResolvedValue({ jobs: [] });
  mocks.createJob.mockResolvedValue(job());
  mocks.getJob.mockResolvedValue(job());
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("personal image transfer", () => {
  it("starts all personal notes in one click without an open note or scan confirmation", async () => {
    await act(async () => root.render(<Panel />));
    await click("打开工具");
    expect(document.body.textContent).not.toMatch(/当前笔记|选择多篇|整个笔记本|扫描网络图片/);
    await click("开始转存全部笔记图片");
    expect(mocks.createJob).toHaveBeenCalledTimes(1);
    expect(mocks.createJob).toHaveBeenCalledWith({ allPersonal: true });
    expect(document.body.textContent).toContain("停止转存");
    expect(document.body.textContent).not.toContain("开始转存全部笔记图片");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(mocks.cancelJob).not.toHaveBeenCalled();
    await click("查看进度");
    mocks.cancelJob.mockResolvedValue({ ...job(), cancelRequested: true });
    await click("停止转存");
    expect(mocks.cancelJob).toHaveBeenCalledWith("job-1");
    expect(document.body.textContent).toContain("正在停止");
  });

  it("retries a failed background scan even before any note was scanned", async () => {
    mocks.listJobs.mockResolvedValue({ jobs: [{ ...job("failed"), error: "扫描中断" }] });
    mocks.retryJob.mockResolvedValue(job());
    await act(async () => root.render(<Panel />));
    await click("打开工具");
    expect(document.body.textContent).toContain("扫描中断");
    await click("重试失败项");
    expect(mocks.retryJob).toHaveBeenCalledWith("job-1");
  });
});

// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ info: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/noteAttachmentAccessBridge", () => ({ getAttachmentAccessSnapshot: () => 0, subscribeAttachmentAccess: () => () => {}, getAttachmentRenderSource: (source: string) => ({ attachmentId: source.startsWith("/api/attachments/") ? "photo" : null }) }));
vi.mock("@/lib/photoMedia", () => ({
  photoMediaUrl: (source: string, kind: string) => source.startsWith("/api/attachments/") ? `${source}?${kind}` : "",
  fetchPhotoMediaInfo: mocks.info,
}));
vi.mock("@/lib/downloadFile", () => ({ downloadAttachment: mocks.download }));
vi.mock("@/hooks/useAttachmentVideoRenderSource", () => ({ useAttachmentVideoRenderSource: (url: string) => ({ renderSrc: url, renderKey: url }) }));
import { MotionPhotoOverlay, SharedPhotoMotionBridge } from "../MotionPhotoOverlay";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("动态照片保持封面，点按后播放并能安全降级", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubGlobal("IntersectionObserver", undefined);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    mocks.info.mockResolvedValue({ kind: "live-photo", hasMotion: true, hasMotionOriginal: true, motionStatus: "available" });
    mocks.download.mockResolvedValue(undefined);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  async function render(source = "/api/attachments/photo") {
    await act(async () => root.render(<MotionPhotoOverlay source={source} />));
  }
  async function click(label: string) {
    const button = [...host.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
    expect(button).toBeTruthy(); await act(async () => button!.click());
  }
  it("默认不加载视频，点 LIVE 播放，结束返回封面", async () => {
    await render(); expect(host.textContent).toContain("LIVE"); expect(host.querySelector("video")).toBeNull();
    await click("播放动态照片"); expect(host.querySelector("video")?.getAttribute("src")).toContain("?motion");
    await act(async () => host.querySelector("video")!.dispatchEvent(new Event("ended")));
    expect(host.querySelector("video")).toBeNull(); expect(host.textContent).toContain("LIVE");
  });
  it("播放失败返回封面并提示，动态原件下载沿用照片权限 URL", async () => {
    await render(); await click("播放动态照片");
    await act(async () => host.querySelector("video")!.dispatchEvent(new Event("error")));
    expect(host.querySelector("video")).toBeNull(); expect(host.querySelector('[role="status"]')?.textContent).toContain("仍可查看照片");
    await click("动态原件"); expect(mocks.download).toHaveBeenCalledWith("/api/attachments/photo?motion-original", "Live Photo.mov");
  });
  it("配对原件缺失与普通外部图片都保持静态展示", async () => {
    mocks.info.mockResolvedValue({ kind: "live-photo", hasMotion: false, motionStatus: "missing-companion" });
    await render(); expect(host.textContent).toContain("缺少配对视频"); expect(host.querySelector("button")).toBeNull();
    mocks.info.mockClear(); await render("https://example.com/photo.jpg"); expect(mocks.info).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
  });
  it("晚同步的 MOV 会刷新缺失配对状态，禁止下载的分享隐藏动态原件按钮", async () => {
    mocks.info.mockResolvedValueOnce({ kind: "live-photo", hasMotion: false, motionStatus: "missing-companion" });
    await render(); expect(host.textContent).toContain("缺少配对视频");
    mocks.info.mockResolvedValue({ kind: "live-photo", hasMotion: true, hasMotionOriginal: true, canDownloadOriginal: false, motionStatus: "available" });
    await act(async () => window.dispatchEvent(new Event("nowen:sync-snapshot-applied")));
    expect(host.textContent).toContain("LIVE"); expect(host.textContent).not.toContain("缺少配对视频");
    expect(host.textContent).not.toContain("动态原件");
    await click("播放动态照片"); expect(host.querySelector("video")).not.toBeNull();
  });

  it("分享只读 HTML 复用照片播放，内容更换与卸载不会留下旧按钮", async () => {
    const html = document.createElement("div"); html.innerHTML = '<p><img src="/api/attachments/photo" alt="照片"></p>';
    document.body.appendChild(html); const ref = { current: html };
    try {
      await act(async () => root.render(<SharedPhotoMotionBridge rootRef={ref} revision="first" />));
      expect(html.querySelector("img")?.getAttribute("alt")).toBe("照片"); expect(html.textContent).toContain("LIVE");
      html.innerHTML = '<p><img src="https://example.com/plain.jpg"></p>';
      await act(async () => root.render(<SharedPhotoMotionBridge rootRef={ref} revision="second" />));
      expect(html.querySelector("button")).toBeNull(); expect(html.querySelector("img")?.parentElement?.tagName).toBe("P");
    } finally { html.remove(); }
  });
});

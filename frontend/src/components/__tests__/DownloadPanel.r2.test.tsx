import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  latest: vi.fn(),
  mirror: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: {
    getLatestRelease: mock.latest,
    getLatestReleaseMirror: mock.mirror,
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key
  }),
}));

import DownloadPanel, { preferCorrectedFpk } from "../DownloadPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const tag = "v1.5.5";
const names = [
  "Nowen-Note-1.5.5-setup.exe",
  "Nowen-Note-1.5.5-arm64.dmg",
  "Nowen-Note-1.5.5-x64.dmg",
  "Nowen-Note-1.5.5-x86_64.AppImage",
  "Nowen-Note-1.5.5-amd64.deb",
  "Nowen-Note-1.5.5.apk",
  "nowen-note-1.5.5-fpk-r1.fpk",
  "nowen-clipper-0.5.0-edge.zip",
  "nowen-clipper-0.5.0-firefox.zip",
  "nowen-clipper-0.5.0.zip",
];
const extras = [
  "Nowen-Note-1.5.5-portable.exe",
  "amd64_io.nowen.note_1.5.5.0001.upk",
  "nowen-note-1.5.5.fpk",
];
const all = [...names, ...extras].map((name, i) => ({
  name, size: 1000 + i,
  browserDownloadUrl: "https://github.com/cropflre/nowen-note/releases/download/" + tag + "/" + name,
}));
const release = {
  available: true, tag, version: "1.5.5", name: tag,
  htmlUrl: "https://github.com/cropflre/nowen-note/releases/tag/v1.5.5",
  publishedAt: "2026-11-09", prerelease: false, draft: false, assets: all,
};
const mirror = {
  available: true, tag,
  assets: names.map(name => ({
    name, size: all.find(a => a.name === name)!.size,
    downloadUrl: "https://download.nowen.cn/v1.5.5/" + name,
  })),
};

describe("Settings > Download clients R2 verified downloads", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    mock.latest.mockReset().mockResolvedValue(release);
    mock.mirror.mockReset().mockResolvedValue(mirror);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  async function renderPanel() {
    await act(async () => {
      root.render(<DownloadPanel />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  const links = () => [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].map(a => a.href);

  it("prefers corrected FPK and does not duplicate legacy package", () => {
    const preferred = preferCorrectedFpk(all);
    expect(preferred.map(a => a.name)).toContain("nowen-note-1.5.5-fpk-r1.fpk");
    expect(preferred.map(a => a.name)).not.toContain("nowen-note-1.5.5.fpk");
  });

  it("defaults to R2 for ten verified files and GitHub for UPK/portable", async () => {
    await renderPanel();
    expect(links()).toContain("https://download.nowen.cn/v1.5.5/Nowen-Note-1.5.5-setup.exe");
    expect(links()).toContain("https://github.com/cropflre/nowen-note/releases/download/v1.5.5/Nowen-Note-1.5.5-setup.exe");
    expect(links()).not.toContain("https://download.nowen.cn/v1.5.5/Nowen-Note-1.5.5-portable.exe");
    expect(links()).not.toContain("https://download.nowen.cn/v1.5.5/amd64_io.nowen.note_1.5.5.0001.upk");
    expect(links()).not.toContain("https://download.nowen.cn/v1.5.5/nowen-note-1.5.5.fpk");
    expect(host.textContent).not.toContain("Gitee 镜像");
    const r2 = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("R2 官方下载"));
    expect(r2).toBeDefined();
  });

  it("never builds unverified R2 links for stale manifest, even when R2 selected", async () => {
    mock.mirror.mockResolvedValue({ ...mirror, tag: "v1.5.6" });
    await renderPanel();
    expect(links().filter(url => url.includes("download.nowen.cn"))).toEqual([]);
    expect(links()).toContain("https://github.com/cropflre/nowen-note/releases/download/v1.5.5/Nowen-Note-1.5.5-setup.exe");
  });

  it("allows explicit GitHub selection", async () => {
    await renderPanel();
    const githubButton = [...host.querySelectorAll("button")].find(b => b.textContent === "GitHub");
    expect(githubButton).toBeDefined();
    await act(async () => githubButton!.click());
    expect(links()).not.toContain("https://download.nowen.cn/v1.5.5/Nowen-Note-1.5.5-setup.exe");
  });
});

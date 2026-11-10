import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BackupWebDavBridge from "../BackupWebDavBridge";
import zh from "@/i18n/locales/zh-CN.json";

const i18nMock = vi.hoisted(() => ({ value: null as null | { t: (key: string) => string; i18n: { language: string } } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => {
    i18nMock.value ??= {
      t: (key: string) => {
        const found = key.split(".").reduce<unknown>(
          (value, part) => (value as Record<string, unknown> | undefined)?.[part],
          zh,
        );
        return typeof found === "string" ? found : key;
      },
      i18n: { language: "zh-CN" },
    };
    return i18nMock.value;
  },
}));
vi.mock("@/lib/api", () => ({ getBaseUrl: () => "", withSudo: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/ui/confirm", () => ({ confirm: vi.fn(), prompt: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const config = {
  enabled: true,
  configured: true,
  endpoint: "http://nas.local/dav",
  username: "backup",
  passwordSet: true,
  remotePath: "nowen-note/backups",
  uploadOnAutoBackup: false,
  insecureHttp: true,
  remoteDirectory: "nowen-note/backups",
  status: { lastTestAt: null, lastTestOk: null, lastUploadAt: null, lastFilename: null, lastError: null },
};
// 文件名里的时间戳来自 toISOString()（UTC）；createdAt 才是真实时刻。
const rows = [
  { filename: "nowen-backup-full-2026-11-06T23-35-20-f269eb1e.zip", type: "full", size: 34_700_000, createdAt: "2026-11-06T23:35:20.000Z" },
  { filename: "nowen-backup-db-only-2026-11-06T23-33-11-c2d651f4.bak", type: "db-only", size: 4_800_000, createdAt: "2026-11-06T23:33:11.000Z" },
];

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(String(url).endsWith("/backups/webdav") ? config : rows),
  })));
  const slot = document.createElement("div");
  slot.setAttribute("data-nowen-backup-webdav-host", "true");
  document.body.appendChild(slot);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const mount = async () => {
  await act(async () => { root.render(<BackupWebDavBridge />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const options = () => Array.from(document.querySelectorAll<HTMLOptionElement>("select option"));

describe("WebDAV 手动上传下拉的备份时间", () => {
  it("显示 createdAt 的本地时间，而不是文件名里的 UTC 时间戳", async () => {
    await mount();
    const [full, dbOnly] = options();

    expect(full.textContent).toContain(new Date(rows[0].createdAt).toLocaleString("zh-CN"));
    expect(dbOnly.textContent).toContain(new Date(rows[1].createdAt).toLocaleString("zh-CN"));
    expect(full.textContent).not.toContain("23-35-20");
    expect(full.textContent).not.toContain("nowen-backup-");
  });

  it("同时给出备份类型和大小，且上传仍以真实文件名为值", async () => {
    await mount();
    const [full, dbOnly] = options();

    expect(full.textContent).toContain(zh.dataManager.overview.full);
    expect(full.textContent).toContain("33.1 MB");
    expect(dbOnly.textContent).toContain(zh.dataManager.overview.databaseOnly);
    expect(full.value).toBe(rows[0].filename);
    expect(dbOnly.value).toBe(rows[1].filename);
  });
});

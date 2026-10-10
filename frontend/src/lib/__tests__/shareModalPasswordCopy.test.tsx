// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Share } from "@/types";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), getMe: vi.fn(), create: vi.fn(), update: vi.fn(), copy: vi.fn(),
  success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: {
  getSharesByNote: mocks.list, getMe: mocks.getMe,
  createShare: mocks.create, updateShare: mocks.update,
} }));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copy }));
vi.mock("@/lib/toast", () => ({ toast: {
  success: mocks.success, warning: mocks.warning,
  info: mocks.info, error: mocks.error,
} }));
vi.mock("@/hooks/useSiteSettings", () => ({ useSiteSettings: () => ({
  siteConfig: { publicWebOrigin: "https://notes.example.com", publicWebOriginSource: "settings" },
  updatePublicWebOrigin: vi.fn(),
}) }));
vi.mock("@/lib/publicWebOrigin", () => ({
  resolvePublicWebOrigin: () => ({
    origin:"https://notes.example.com", source:"settings", requiresAnonymousCheck:false,
    risk:"none", isLikelyProtectedGateway:false,
  }),
  buildPublicWebUrl: (path: string) => "https://notes.example.com" + path,
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: { div:"div" },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language:"zh" } }),
}));

import ShareModal from "@/components/ShareModal";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let rows: Share[];
const baseShare: Share = {
  id: "share-1", noteId: "note-a", ownerId:"user-a", shareToken:"secret-link-token",
  shareType:"link", permission:"view", hasPassword:true, credentialVersion:1,
  expiresAt:null, maxViews:null, viewCount:0, isActive:1, createdAt:"now", updatedAt:"now",
};
async function render() {
  root = createRoot(host);
  await act(async () => root.render(
    <ShareModal noteId="note-a" noteTitle="测试笔记" onClose={() => undefined} />,
  ));
}
function buttonContaining(fragment: string): HTMLButtonElement {
  const btn = [...host.querySelectorAll("button")]
    .find((item) => item.textContent?.includes(fragment));
  if (!btn) throw new Error("Cannot find button: " + fragment);
  return btn;
}
async function click(btn: HTMLButtonElement) {
  await act(async () => btn.dispatchEvent(new MouseEvent("click", { bubbles:true })));
}
beforeEach(() => {
  rows = [];
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockImplementation(async () => [...rows]);
  mocks.getMe.mockResolvedValue({ role:"user" });
  mocks.copy.mockResolvedValue(true);
  mocks.create.mockImplementation(async (body: { password?:string }) => {
    const row = { ...baseShare, hasPassword:Boolean(body.password) };
    rows = [row];
    return row;
  });
  mocks.update.mockImplementation(async (_id: string, body: { password?: string }) => {
    const row = { ...baseShare, credentialVersion: 2, hasPassword:Boolean(body.password) };
    rows = [row];
    return row;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  if (root) act(() => root.unmount());
  host.remove();
});
describe("share password copy UI", () => {
  it("keeps old passwords unrecoverable but retains copy-link and guides reset", async () => {
    rows = [baseShare];
    await render();
    expect(buttonContaining("shareUi.copy")).toBeTruthy();
    expect(buttonContaining("shareUi.resetPasswordToCopy")).toBeTruthy();
    await click(buttonContaining("shareUi.resetPasswordToCopy"));
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith("shareUi.passwordMustReset");
    expect(host.textContent).toContain("shareUi.editShareSettings");
    await click(buttonContaining("shareUi.copy"));
    expect(mocks.copy).toHaveBeenCalledWith("https://notes.example.com/share/secret-link-token");
  });

  it("offers one-click link and password only after successful creation; loses it on reopen", async () => {
    await render();
    const pw = host.querySelector('input[type="password"]') as HTMLInputElement;
    expect(pw).toBeTruthy();
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      nativeSetter.call(pw, "  abcd1234  ");
      pw.dispatchEvent(new Event("input", { bubbles:true }));
    });
    await click(buttonContaining("shareUi.createLink"));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ password:"abcd1234" }));
    await click(buttonContaining("shareUi.copyWithPassword"));
    expect(mocks.copy).toHaveBeenLastCalledWith(
      "shareUi.copyNoteLabel测试笔记\n" +
      "shareUi.copyLinkLabelhttps://notes.example.com/share/secret-link-token\n" +
      "shareUi.copyPasswordLabelabcd1234",
    );
    await act(async () => root.unmount());
    await render();
    expect(buttonContaining("shareUi.resetPasswordToCopy")).toBeTruthy();
    expect(host.textContent).not.toContain("shareUi.copyWithPassword");
  });
});

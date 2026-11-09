import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Share } from "@/types";
import { zhCNCoverageTranslations } from "@/i18n/coverageTranslations";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), getMe: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
  updateOrigin: vi.fn(), copy: vi.fn(), scrollTo: vi.fn(),
  success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn(),
}));
const originState = vi.hoisted(() => ({ requiresAnonymousCheck: true }));

vi.mock("@/lib/api", () => ({ api: {
  getSharesByNote: mocks.list, getMe: mocks.getMe,
  createShare: mocks.create, updateShare: mocks.update, deleteShare: mocks.remove,
} }));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copy }));
vi.mock("@/lib/toast", () => ({ toast: {
  success: mocks.success, warning: mocks.warning, info: mocks.info, error: mocks.error,
} }));
vi.mock("@/hooks/useSiteSettings", () => ({ useSiteSettings: () => ({
  siteConfig: { publicWebOrigin: "", publicWebOriginSource: "current" },
  updatePublicWebOrigin: mocks.updateOrigin,
}) }));
vi.mock("@/lib/publicWebOrigin", () => ({
  resolvePublicWebOrigin: () => ({
    origin: "https://notes.example.com",
    source: originState.requiresAnonymousCheck ? "current" : "settings",
    requiresAnonymousCheck: originState.requiresAnonymousCheck,
    risk: originState.requiresAnonymousCheck ? "domain" : "none",
    isLikelyProtectedGateway: false,
  }),
  buildPublicWebUrl: (path: string) => "https://notes.example.com" + path,
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: { div: "div" },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const found = key.split(".").reduce<unknown>(
        (value, part) => (value as Record<string, unknown> | undefined)?.[part],
        zhCNCoverageTranslations,
      );
      const text = typeof found === "string" ? found : key;
      return text.replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => String(vars?.[name] ?? ""));
    },
    i18n: { language: "zh-CN" },
  }),
}));

import ShareModal from "@/components/ShareModal";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ui = zhCNCoverageTranslations.shareUi;
const baseShare: Share = {
  id: "share-1", noteId: "note-a", ownerId: "user-a", shareToken: "secret-link-token",
  shareType: "link", permission: "view", hasPassword: true, credentialVersion: 1,
  expiresAt: null, maxViews: null, viewCount: 0, isActive: 1, createdAt: "now", updatedAt: "now",
};
let root: Root;
let host: HTMLDivElement;
let rows: Share[];

async function render() {
  root = createRoot(host);
  await act(async () => root.render(
    <ShareModal noteId="note-a" noteTitle="Welcome" onClose={() => undefined} />,
  ));
}
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
const buttonWithText = (text: string) => {
  const found = buttons().find((button) => button.textContent?.trim() === text);
  if (!found) throw new Error("Cannot find button: " + text);
  return found;
};
const region = (toggle: HTMLElement) => document.getElementById(toggle.getAttribute("aria-controls") ?? "") as HTMLElement;
const modal = () => host.querySelector("h2")!.closest("header")!.parentElement as HTMLElement;
async function click(element: HTMLElement) {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  rows = [];
  originState.requiresAnonymousCheck = true;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockImplementation(async () => [...rows]);
  mocks.getMe.mockResolvedValue({ role: "user" });
  mocks.create.mockImplementation(async () => {
    rows = [baseShare];
    return baseShare;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: mocks.scrollTo });
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  if (root) act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

describe("ShareModal below the sm breakpoint", () => {
  it("collapses the public-origin panel into a one-line summary that keeps the warning", async () => {
    mocks.getMe.mockResolvedValue({ role: "admin" });
    await render();

    const toggle = buttonWithText(ui.riskSummary);
    expect(toggle.className).toContain("sm:hidden");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // Everything that used to take the space (full message, domain input, save button, hint)
    // now lives in the region the toggle controls, which is only hidden below sm.
    const panel = region(toggle);
    expect(panel.className).toContain("max-sm:hidden");
    expect(panel.textContent).toContain(ui.domainRisk);
    expect(panel.querySelector(`input[aria-label="${ui.originInput}"]`)).toBeTruthy();
    expect(panel.textContent).toContain(ui.saveOrigin);
    expect(panel.textContent).toContain(ui.originResetHint);

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.className).not.toContain("max-sm:hidden");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel.className).toContain("max-sm:hidden");
  });

  it("still saves the public origin from inside the collapsible panel", async () => {
    mocks.getMe.mockResolvedValue({ role: "admin" });
    mocks.updateOrigin.mockResolvedValue(undefined);
    await render();

    const panel = region(buttonWithText(ui.riskSummary));
    await type(panel.querySelector<HTMLInputElement>(`input[aria-label="${ui.originInput}"]`)!, "https://share.example.com");
    await click(buttonWithText(ui.saveOrigin));

    expect(panel.contains(buttonWithText(ui.saveOrigin))).toBe(true);
    expect(mocks.updateOrigin).toHaveBeenCalledWith("https://share.example.com");
    expect(mocks.success).toHaveBeenCalledWith(ui.originSaved);
  });

  it("uses the dedicated-origin sentence as the summary without repeating it in the details", async () => {
    originState.requiresAnonymousCheck = false;
    await render();

    const toggle = buttonWithText(ui.dedicatedOrigin);
    const [sentence] = region(toggle).querySelectorAll("p");
    expect(sentence.textContent).toBe(ui.dedicatedOrigin);
    expect(sentence.className).toContain("max-sm:hidden");
  });

  it("keeps permission and the create button in view and folds the optional fields", async () => {
    await render();

    const toggle = buttonWithText(ui.moreOptions);
    const options = region(toggle);
    expect(toggle.className).toContain("sm:hidden");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(options.className).toContain("max-sm:hidden");

    const permission = host.querySelector("select")!;
    const create = buttonWithText(ui.createLink);
    expect(options.contains(permission)).toBe(false);
    expect(options.contains(create)).toBe(false);
    expect(options.querySelector('input[type="password"]')).toBeTruthy();
    expect(options.querySelector('input[type="datetime-local"]')).toBeTruthy();
    expect(options.querySelector('input[type="number"]')).toBeTruthy();

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(options.className).not.toContain("max-sm:hidden");
  });

  it("creates a link from the folded form and folds the options again afterwards", async () => {
    await render();
    await click(buttonWithText(ui.moreOptions));
    await type(host.querySelector<HTMLInputElement>('input[type="password"]')!, "abcd1234");
    await type(host.querySelector<HTMLInputElement>('input[type="number"]')!, "5");
    await click(buttonWithText(ui.createLink));

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ noteId: "note-a", password: "abcd1234", maxViews: 5 }));
    const toggle = buttonWithText(ui.moreOptions);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(region(toggle).className).toContain("max-sm:hidden");
  });

  it("opens the optional fields while editing, scrolls back to the form and restores the fold on cancel", async () => {
    rows = [{ ...baseShare, maxViews: 20 }];
    await render();
    const editButton = [...host.querySelectorAll<HTMLButtonElement>(`article button[aria-label="${ui.edit}"]`)][0];
    await click(editButton);

    // The whole dialog scrolls on narrow screens, so editing must bring the form back into view.
    expect(mocks.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(host.textContent).toContain(ui.editShareSettings);
    expect(buttons().some((button) => button.textContent?.trim() === ui.moreOptions)).toBe(false);
    const password = host.querySelector('input[type="password"]')!;
    expect(password.closest("[id]")!.className).not.toContain("max-sm:hidden");

    await click(buttonWithText(ui.cancel));
    const toggle = buttonWithText(ui.moreOptions);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(region(toggle).className).toContain("max-sm:hidden");
  });

  it("turns every share action into a labelled icon button without losing the text label from sm up", async () => {
    rows = [baseShare, { ...baseShare, id: "share-2", shareToken: "second-token", hasPassword: false, isActive: 0 }];
    await render();

    const [withPassword, disabled] = [...host.querySelectorAll("article")];
    const actions = (card: Element) => [...card.querySelectorAll<HTMLButtonElement>("button")];
    expect(actions(withPassword).map((button) => button.getAttribute("aria-label"))).toEqual([
      ui.copy, ui.resetPasswordToCopy, ui.openLink, ui.edit, ui.reset, ui.replaceLink, ui.disable, ui.delete,
    ]);
    expect(actions(disabled).map((button) => button.getAttribute("aria-label"))).toEqual([
      ui.copy, ui.openLink, ui.edit, ui.reset, ui.replaceLink, ui.enable, ui.delete,
    ]);

    for (const button of [...actions(withPassword), ...actions(disabled)]) {
      expect(button.getAttribute("title"), button.getAttribute("aria-label") ?? "").toBeTruthy();
      expect(button.className).toContain("max-sm:w-9");
      expect(button.className).toContain("max-sm:px-0");
      // Visible text is only hidden below sm; the wrapper span keeps it in the DOM for sm and up.
      const label = button.querySelector("span");
      if (label) expect(label.className).toContain("max-sm:hidden");
    }
    expect(withPassword.textContent).toContain(ui.edit);
    expect(withPassword.textContent).toContain(ui.replaceLink);
    // Hint titles of the password button are preserved.
    expect(actions(withPassword)[1].getAttribute("title")).toBe(ui.passwordMustReset);
    // The destructive action is pushed to the far end of the icon row below sm.
    expect(actions(withPassword)[7].className).toContain("max-sm:ml-auto");
  });

  it("scrolls as one sheet below sm with a sticky header and keeps the desktop layout classes", async () => {
    await render();
    const sheet = modal();
    const header = sheet.querySelector("header")!;
    const grid = sheet.querySelector<HTMLElement>('[class*="lg:grid-cols-[300px_1fr]"]')!;

    expect(sheet.className).toContain("max-sm:overflow-y-auto");
    expect(header.className).toContain("max-sm:sticky");
    expect(grid.className).toContain("max-sm:flex-none");
    // sm and up keep the original container behaviour.
    expect(sheet.className).toContain("overflow-hidden");
    expect(sheet.className).toContain("max-h-[92vh]");
    expect(grid.className).toContain("flex-1");
    expect(header.className).toContain("px-5");
    expect(header.className).toContain("py-4");
  });
});

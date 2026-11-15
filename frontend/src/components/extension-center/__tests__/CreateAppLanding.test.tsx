import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioSpec } from "@/lib/personalApps";

const mocks = vi.hoisted(() => ({ pluginApi: { personalAppAIStatus: vi.fn(), previewPersonalAppAI: vi.fn() } }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: mocks.pluginApi }));
vi.mock("react-i18next", async () => {
  // Real English copy, so the test reads what users read and catches missing keys.
  const { enExtensionCenterTranslations } = await import("@/i18n/extensionCenterTranslations");
  const t = (key: string, options?: Record<string, unknown>) => {
    const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enExtensionCenterTranslations);
    return typeof value === "string" ? value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? "")) : key;
  };
  return { initReactI18next: { type: "3rdParty", init: () => undefined }, useTranslation: () => ({ i18n: { language: "en" }, t }) };
});
import { CreateAppLanding } from "../CreateAppLanding";

const draft: StudioSpec = {
  schemaVersion: 1, name: "Project board", description: "Owners and status", layout: "board", items: [],
  fields: [{ id: "title", label: "Item", type: "text" }, { id: "owner", label: "Owner", type: "text" }, { id: "done", label: "Done", type: "checkbox" }],
};
// A preview request that only ends when it is aborted, like a slow model.
const pendingPreview = () => mocks.pluginApi.previewPersonalAppAI.mockImplementation((_instruction: string, _spec: unknown, signal: AbortSignal) =>
  new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))));

let root: Root, host: HTMLDivElement;
const onPick = vi.fn();
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;
const textarea = () => host.querySelector("textarea") as HTMLTextAreaElement | null;
const type = async (element: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
};
const render = async () => { await act(async () => root.render(<CreateAppLanding onPick={onPick} />)); await flush(); };

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.pluginApi.personalAppAIStatus.mockResolvedValue({ available: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("create app entry", () => {
  it("offers templates and a settings link instead of an AI prompt when no model is configured", async () => {
    mocks.pluginApi.personalAppAIStatus.mockResolvedValue({ available: false, code: "STUDIO_AI_NOT_CONFIGURED" });
    await render();
    expect(textarea()).toBeNull();
    expect(host.querySelector('[role="note"]')!.textContent).toContain("AI is not set up yet");
    const opened = vi.fn();
    window.addEventListener("nowen:open-settings", opened);
    await act(async () => button("Open settings")!.click());
    window.removeEventListener("nowen:open-settings", opened);
    expect(opened).toHaveBeenCalledTimes(1);
    for (const title of ["Project progress", "Reading log", "Habit tracker", "Meeting notes", "Travel checklist", "Daily to-dos", "Personal records"]) expect(button(title), title).toBeDefined();
    await act(async () => button("Reading log")!.click());
    const picked = onPick.mock.calls[0][0] as StudioSpec;
    expect(picked).toMatchObject({ name: "My reading log", layout: "list", items: [] });
    expect(picked.fields.map((field) => field.label)).toEqual(["Title", "Author", "Progress", "Notes", "Finished"]);
    expect(mocks.pluginApi.previewPersonalAppAI).not.toHaveBeenCalled();
  });

  it("explains that AI was turned off", async () => {
    mocks.pluginApi.personalAppAIStatus.mockResolvedValue({ available: false, code: "STUDIO_AI_UNAVAILABLE" });
    await render();
    expect(textarea()).toBeNull();
    expect(host.querySelector('[role="note"]')!.textContent).toContain("AI features are turned off");
  });

  it("suggests a template the description already matches", async () => {
    await render();
    await type(textarea()!, "A reading log for my books");
    const note = [...host.querySelectorAll('[role="note"]')].find((element) => element.textContent?.includes("A template may already fit"))!;
    const chip = [...note.querySelectorAll("button")].find((item) => item.textContent === "Reading log")!;
    await act(async () => chip.click());
    expect((onPick.mock.calls[0][0] as StudioSpec).name).toBe("My reading log");
  });

  it("cancels a generation, keeps the description and shows no late result", async () => {
    pendingPreview();
    await render();
    await type(textarea()!, "A project board with owners");
    await act(async () => button("Generate preview")!.click());
    const signal = mocks.pluginApi.previewPersonalAppAI.mock.calls[0][2] as AbortSignal;
    await act(async () => button("Cancel")!.click());
    await flush();
    expect(signal.aborted).toBe(true);
    expect(textarea()!.value).toBe("A project board with owners");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Cancelled. Your description is kept.");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="region"]')).toBeNull();
    expect(button("Cancel")).toBeUndefined();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("previews what will be created, which permissions and which data it uses, before applying the draft", async () => {
    mocks.pluginApi.previewPersonalAppAI.mockResolvedValue({ spec: draft });
    await render();
    await type(textarea()!, "A project board with owners and status");
    await act(async () => button("Generate preview")!.click());
    await flush();
    const region = host.querySelector('[role="region"]')!;
    expect(region.textContent).toContain("One personal app · Cards layout · 3 fields");
    expect(region.textContent).toContain("No plugin permissions; no generated code runs");
    expect(region.textContent).toContain("Your notes, tasks and attachments are not read");
    expect(onPick).not.toHaveBeenCalled();
    await act(async () => button("Use this draft")!.click());
    expect(onPick).toHaveBeenCalledWith(draft);
  });

  it("drops a pending request and checks AI again when the account changes", async () => {
    pendingPreview();
    await render();
    await type(textarea()!, "Meeting notes");
    await act(async () => button("Generate preview")!.click());
    const signal = mocks.pluginApi.previewPersonalAppAI.mock.calls[0][2] as AbortSignal;
    await act(async () => { window.dispatchEvent(new Event("nowen:token-changed")); });
    await flush();
    expect(signal.aborted).toBe(true);
    expect(mocks.pluginApi.personalAppAIStatus).toHaveBeenCalledTimes(2);
    expect(textarea()!.value).toBe("");
  });
});

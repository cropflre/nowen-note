import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => (options ? `${key}|${Object.values(options).join("|")}` : key) }),
}));
vi.mock("@/lib/toast", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
import { EditorActionsMenu } from "../EditorActionsMenu";
import { EditorActionsHost } from "../EditorActionsHost";
import { registerEditorActions } from "@/lib/editorActions/registry";

const [wrap, polish] = registerEditorActions([{ pluginId: "acme.text", pluginName: "Acme Text", editorActions: [
  { id: "wrap", command: "acme.text.wrap", label: "Wrap", placements: ["editor.toolbar.actions"], appliesTo: ["markdown"], selectionMode: "text", resultMode: "replace-selection" },
  { id: "polish", prompt: "polish", label: "Polish", placements: ["editor.toolbar.actions"], appliesTo: ["markdown"], selectionMode: "text", resultMode: "open-preview" },
] as never }], "web");

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ""; });

const menu = () => document.querySelector('[role="menu"]');
const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const click = async (element: Element, detail = 1) => { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail })); }); };
const key = async (element: Element, value: string) => { await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })); }); };

describe("editor actions menu", () => {
  it("lists entries when opened, explains disabled ones and runs the chosen action", async () => {
    const onRun = vi.fn();
    const getEntries = vi.fn(() => [{ action: wrap, disabledReason: "NEEDS_SELECTION" as const }, { action: polish }]);
    await act(async () => root.render(<EditorActionsMenu placement="editor.toolbar.actions" getEntries={getEntries} onRun={onRun} />));
    expect(getEntries).not.toHaveBeenCalled();
    const trigger = host.querySelector('button[aria-haspopup="menu"]')!;
    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const [disabled, enabled] = items();
    expect(disabled.disabled).toBe(true);
    expect(disabled.textContent).toContain("editorActions.needsSelection");
    expect(enabled.textContent).toContain("Polish");
    expect(enabled.textContent).toContain("editorActions.aiBadge");
    expect(enabled.textContent).toContain("editorActions.fromPlugin|Acme Text");
    await click(enabled);
    expect(onRun).toHaveBeenCalledWith(polish);
    expect(menu()).toBeNull();
  });

  it("supports keyboard use and returns focus to the trigger on Escape", async () => {
    await act(async () => root.render(<EditorActionsMenu placement="editor.toolbar.actions" getEntries={() => [{ action: wrap }, { action: polish }]} onRun={vi.fn()} />));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    await click(trigger, 0);
    expect(document.activeElement).toBe(items()[0]);
    await key(menu()!, "ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    await key(menu()!, "ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
    await key(window as unknown as Element, "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("editor actions host", () => {
  it("previews results as plain text and resolves the chosen button", async () => {
    const resolve = vi.fn();
    const unsafe = '<img src=x onerror="window.__pwned=1">';
    await act(async () => root.render(<EditorActionsHost state={{ phase: "preview", action: polish, original: "old", result: unsafe, ai: true, choices: ["replace", "insert"], resolve }} />));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.textContent).toContain(unsafe);
    expect(dialog.textContent).toContain("editorActions.previewAiNotice");
    expect(document.activeElement?.textContent).toBe("editorActions.replace");
    const button = (label: string) => [...dialog.querySelectorAll("button")].find((item) => item.textContent === label)!;
    await click(button("editorActions.insert"));
    expect(resolve).toHaveBeenLastCalledWith("insert");
    await key(dialog, "Escape");
    expect(resolve).toHaveBeenLastCalledWith("cancel");
  });

  it("shows progress with cancel, and conflicts with retry", async () => {
    const cancel = vi.fn(), retry = vi.fn(), dismiss = vi.fn();
    await act(async () => root.render(<EditorActionsHost state={{ phase: "running", action: wrap, cancel }} />));
    expect(document.querySelector('[role="status"]')!.textContent).toContain("editorActions.running|Wrap");
    await click([...document.querySelectorAll("button")].find((item) => item.textContent === "editorActions.cancel")!);
    expect(cancel).toHaveBeenCalled();
    await act(async () => root.render(<EditorActionsHost state={{ phase: "conflict", action: wrap, result: "new", retry, dismiss }} />));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("editorActions.conflictBody");
    await click([...dialog.querySelectorAll("button")].find((item) => item.textContent === "editorActions.retry")!);
    expect(retry).toHaveBeenCalled();
  });
});

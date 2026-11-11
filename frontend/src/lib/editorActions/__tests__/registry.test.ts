import { describe, expect, it, vi } from "vitest";
import { editorActionsFor, needsPreview, registerEditorActions } from "../registry";

const base = { id: "wrap", command: "acme.text.wrap", label: "Wrap", placements: ["editor.selection", "editor.toolbar.actions"], appliesTo: ["tiptap", "markdown"], selectionMode: "text", resultMode: "replace-selection" };

describe("editor action registry", () => {
  it("namespaces valid actions and drops malformed, duplicate or foreign-platform entries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const actions = registerEditorActions([
      { pluginId: "acme.text", pluginName: "Acme Text", editorActions: [
        base,
        { ...base },
        { ...base, id: "both", prompt: "p" },
        { ...base, id: "bad-placement", placements: ["editor.contextMenu"] },
        { ...base, id: "bad-mode", resultMode: "eval" },
        { ...base, id: "Bad-Id" },
        { ...base, id: "mobile", uiPlatform: ["android"] },
        { ...base, id: "ai", command: undefined, prompt: "polish", label: "x".repeat(80) },
      ] as never },
      { pluginId: "NOT VALID", editorActions: [base] as never },
      { pluginId: "other.plugin", editorActions: "nope" as never },
    ], "web");
    expect(actions.map((item) => item.runtimeId)).toEqual(["acme.text/wrap", "acme.text/ai"]);
    expect(actions[0]).toMatchObject({ pluginName: "Acme Text", ai: false, keywords: [] });
    expect(actions[1]).toMatchObject({ ai: true, prompt: "polish" });
    expect(actions[1].label).toHaveLength(60);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("acme.text/wrap"));
    warn.mockRestore();
  });

  it("hides actions on read-only notes and disables selection actions without a selection", () => {
    const [action, insert] = registerEditorActions([{ pluginId: "acme.text", editorActions: [base, { ...base, id: "tpl", placements: ["editor.slash", "editor.toolbar.actions"], selectionMode: "none", resultMode: "insert", appliesTo: ["markdown"] }] as never }], "desktop");
    const context = { kind: "markdown" as const, editable: true, guest: false, trashed: false, hasSelection: false };
    expect(editorActionsFor([action, insert], "editor.toolbar.actions", context)).toEqual([{ action, disabledReason: "NEEDS_SELECTION" }, { action: insert }]);
    expect(editorActionsFor([action, insert], "editor.toolbar.actions", { ...context, hasSelection: true })).toEqual([{ action }, { action: insert }]);
    expect(editorActionsFor([action, insert], "editor.slash", { ...context, kind: "tiptap" })).toEqual([]);
    for (const blocked of [{ editable: false }, { guest: true }, { trashed: true }]) {
      expect(editorActionsFor([action, insert], "editor.toolbar.actions", { ...context, ...blocked })).toEqual([]);
    }
    expect([needsPreview(action), needsPreview({ resultMode: "open-preview" }), needsPreview({ resultMode: "insert", requiresConfirmation: true })]).toEqual([false, true, true]);
  });
});

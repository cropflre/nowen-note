import { describe, expect, it, vi } from "vitest";
import { readAiProvenance } from "@/lib/aiContentProvenance";
import { registerEditorActions, type RegisteredEditorAction } from "../registry";
import { runEditorAction, type EditorActionRunnerDeps, type EditorActionUiState } from "../runner";
import type { EditorActionAdapter, EditorActionSnapshot } from "../types";

function action(overrides: Record<string, unknown>): RegisteredEditorAction {
  return registerEditorActions([{ pluginId: "acme.text", pluginName: "Acme", editorActions: [{
    id: "act", command: "acme.text.act", label: "Act", placements: ["editor.selection"], appliesTo: ["tiptap", "markdown"],
    selectionMode: "text", resultMode: "replace-selection", ...overrides,
  }] as never }], "web")[0];
}

function fakeAdapter(options: { text?: string; original?: string; hasSelection?: boolean; composing?: boolean; outcome?: "applied" | "conflict" } = {}) {
  const applied: Array<{ markdown: string; mode: string }> = [];
  const release = vi.fn();
  const snapshot: EditorActionSnapshot = {
    kind: "markdown", noteId: "note-1", text: options.text ?? "hello", original: options.original ?? options.text ?? "hello", hasSelection: options.hasSelection ?? true,
    apply: (markdown, mode) => { applied.push({ markdown, mode }); return options.outcome ?? "applied"; },
    release,
  };
  const adapter: EditorActionAdapter = { kind: "markdown", isComposing: () => Boolean(options.composing), hasSelection: () => snapshot.hasSelection, capture: vi.fn(() => snapshot), focus: vi.fn() };
  return { adapter, applied, release };
}

function deps(run: EditorActionRunnerDeps["run"], onUi: (state: EditorActionUiState) => void = () => undefined) {
  return {
    run: vi.fn(run),
    notify: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
    copy: vi.fn(async () => undefined),
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
    onUi: vi.fn(onUi),
  };
}

describe("editor action runner", () => {
  it("sends only the captured selection and applies a direct replacement", async () => {
    const { adapter, applied, release } = fakeAdapter({ text: "hello" });
    const d = deps(async () => ({ success: true, text: "HELLO" }));
    expect(await runEditorAction(adapter, action({}), d)).toBe("applied");
    expect(d.run).toHaveBeenCalledWith("acme.text", "act", { noteId: "note-1", editor: "markdown", text: "hello" }, expect.any(AbortSignal));
    expect(applied).toEqual([{ markdown: "HELLO", mode: "replace" }]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(adapter.focus).toHaveBeenCalled();
  });

  it("never sends text for actions that do not read the selection", async () => {
    const { adapter, applied } = fakeAdapter({ text: "secret", hasSelection: false });
    const d = deps(async () => ({ success: true, text: "## Template" }));
    expect(await runEditorAction(adapter, action({ selectionMode: "none", resultMode: "insert", placements: ["editor.slash"] }), d)).toBe("applied");
    expect(d.run.mock.calls[0][2]).toEqual({ noteId: "note-1", editor: "markdown" });
    expect(applied[0].mode).toBe("insert");
  });

  it("keeps internal block markers on replace and marks AI output with provenance", async () => {
    const keep = "blk_11111111-2222-4333-8444-555555555555", forged = "blk_99999999-8888-4777-8666-555555555555";
    const { adapter, applied } = fakeAdapter({ text: "Original", original: `Original ^${keep}` });
    const d = deps(async () => ({ success: true, text: `Improved ^${forged}`, aiGenerated: true }));
    expect(await runEditorAction(adapter, action({}), d)).toBe("applied");
    expect(applied[0].markdown).toContain(`^${keep}`);
    expect(applied[0].markdown).not.toContain(forged);
    expect(readAiProvenance(applied[0].markdown)).not.toBeNull();
  });

  it("shows notice-only results without touching the document", async () => {
    const { adapter, applied } = fakeAdapter();
    const d = deps(async () => ({ success: true, message: "12 words" }));
    expect(await runEditorAction(adapter, action({ resultMode: "none" }), d)).toBe("done");
    expect(d.notify.success).toHaveBeenCalledWith("12 words");
    expect(applied).toEqual([]);
  });

  it("previews before writing and honours replace, insert, copy and cancel", async () => {
    for (const [choice, expected] of [["replace", "applied"], ["insert", "applied"], ["copy", "copied"], ["cancel", "cancelled"]] as const) {
      const { adapter, applied } = fakeAdapter();
      let preview: Extract<EditorActionUiState, { phase: "preview" }> | undefined;
      const d = deps(async () => ({ success: true, text: "Result" }), (state) => { if (state.phase === "preview") { preview = state; state.resolve(choice); } });
      expect(await runEditorAction(adapter, action({ resultMode: "open-preview" }), d)).toBe(expected);
      expect(preview).toMatchObject({ original: "hello", result: "Result", choices: ["replace", "insert"] });
      expect(applied.map((item) => item.mode)).toEqual(choice === "replace" || choice === "insert" ? [choice] : []);
      if (choice === "copy") expect(d.copy).toHaveBeenCalledWith("Result");
    }
  });

  it("reports a conflict instead of writing over newer text, and can run again", async () => {
    const { adapter } = fakeAdapter({ outcome: "conflict" });
    let conflict: Extract<EditorActionUiState, { phase: "conflict" }> | undefined;
    const d = deps(async () => ({ success: true, text: "Result" }), (state) => { if (state.phase === "conflict") conflict = state; });
    expect(await runEditorAction(adapter, action({}), d)).toBe("conflict");
    expect(conflict?.result).toBe("Result");
    conflict!.retry();
    await vi.waitFor(() => expect(d.run).toHaveBeenCalledTimes(2));
  });

  it("maps server errors, honours cancellation and refuses to start during IME composition or a parallel run", async () => {
    const failing = fakeAdapter();
    const denied = deps(async () => { throw Object.assign(new Error("x"), { code: "PLUGIN_EDITOR_NOTE_PROTECTED" }); });
    expect(await runEditorAction(failing.adapter, action({}), denied)).toBe("failed");
    expect(denied.notify.error).toHaveBeenCalledWith("editorActions.error.PLUGIN_EDITOR_NOTE_PROTECTED");

    const cancelled = fakeAdapter();
    const pending = deps((_p, _a, _b, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
      (state) => { if (state.phase === "running") queueMicrotask(state.cancel); });
    expect(await runEditorAction(cancelled.adapter, action({}), pending)).toBe("cancelled");
    expect(pending.notify.error).not.toHaveBeenCalled();
    expect(cancelled.applied).toEqual([]);

    const composing = fakeAdapter({ composing: true });
    expect(await runEditorAction(composing.adapter, action({}), deps(async () => ({ success: true, text: "x" })))).toBe("cancelled");
    expect(composing.adapter.capture).not.toHaveBeenCalled();

    const busy = fakeAdapter();
    let release!: () => void;
    const slow = deps(() => new Promise((resolve) => { release = () => resolve({ success: true, text: "x" }); }));
    const first = runEditorAction(busy.adapter, action({}), slow);
    expect(await runEditorAction(busy.adapter, action({}), slow)).toBe("cancelled");
    expect(slow.notify.info).toHaveBeenCalledWith("editorActions.busy");
    release();
    expect(await first).toBe("applied");
  });

  it("requires a selection for selection actions", async () => {
    const { adapter, release } = fakeAdapter({ hasSelection: false });
    const d = deps(async () => ({ success: true, text: "x" }));
    expect(await runEditorAction(adapter, action({}), d)).toBe("failed");
    expect(d.run).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });
});

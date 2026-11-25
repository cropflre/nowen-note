import { createAiProvenance, markAiMarkdown } from "@/lib/aiContentProvenance";
import { projectMarkdownForUser, restoreInternalMarkdownMarkers } from "@/lib/markdownUserContent";
import type { PluginEditorActionRunResult, PluginEditorKind } from "@/lib/pluginApi";
import { needsPreview, type RegisteredEditorAction } from "./registry";
import type { EditorActionAdapter } from "./types";

export type EditorActionChoice = "replace" | "insert" | "copy" | "cancel";

export type EditorActionUiState =
  | { phase: "idle" }
  | { phase: "running"; action: RegisteredEditorAction; cancel: () => void }
  | { phase: "preview"; action: RegisteredEditorAction; original: string; result: string; ai: boolean; choices: Array<"replace" | "insert">; resolve: (choice: EditorActionChoice) => void }
  | { phase: "conflict"; action: RegisteredEditorAction; result: string; retry: () => void; dismiss: () => void };

export interface EditorActionRunnerDeps {
  run: (pluginId: string, actionId: string, body: { noteId: string; editor: PluginEditorKind; text?: string }, signal: AbortSignal) => Promise<PluginEditorActionRunResult>;
  notify: { info(message: string): void; success(message: string): void; error(message: string): void };
  copy: (text: string) => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
  onUi: (state: EditorActionUiState) => void;
}

export type EditorActionOutcome = "applied" | "done" | "copied" | "cancelled" | "conflict" | "failed";

const running = new WeakSet<EditorActionAdapter>();
const KNOWN_ERRORS = new Set([
  "PLUGIN_EDITOR_ACTIONS_DISABLED", "PLUGIN_EDITOR_ACTION_NOT_FOUND", "PLUGIN_EDITOR_ACTION_UNSUPPORTED", "PLUGIN_EDITOR_NOTE_FORBIDDEN",
  "PLUGIN_EDITOR_NOTE_PROTECTED", "PLUGIN_EDITOR_ACTION_INVALID_RESULT", "PLUGIN_EDITOR_AI_NOT_CONFIGURED", "PLUGIN_EDITOR_ACTION_BUSY",
  "PLUGIN_EDITOR_AI_FAILED", "PLUGIN_PERMISSION_DENIED", "PLUGIN_TIMEOUT", "PLUGIN_INPUT_TOO_LARGE",
]);

export function editorActionErrorMessage(error: unknown, t: EditorActionRunnerDeps["t"]): string {
  const coded = error as { code?: string; message?: string } | null;
  if (coded?.code && KNOWN_ERRORS.has(coded.code)) return t(`editorActions.error.${coded.code}`);
  return t("editorActions.error.generic", { message: coded?.message || String(error) });
}

/**
 * One run of an editor action. Only the captured selection leaves the client; the result is applied
 * through the adapter, which refuses to write when the note or the captured text changed meanwhile.
 */
export async function runEditorAction(adapter: EditorActionAdapter, action: RegisteredEditorAction, deps: EditorActionRunnerDeps): Promise<EditorActionOutcome> {
  // Never act in the middle of an IME composition: the committed text is not final yet.
  if (adapter.isComposing()) return "cancelled";
  if (running.has(adapter)) { deps.notify.info(deps.t("editorActions.busy")); return "cancelled"; }
  const snapshot = adapter.capture();
  if ("error" in snapshot) { deps.notify.error(deps.t(`editorActions.capture.${snapshot.error}`)); return "failed"; }
  if (action.selectionMode === "text" && !snapshot.hasSelection) {
    snapshot.release();
    deps.notify.error(deps.t("editorActions.capture.NEEDS_SELECTION"));
    return "failed";
  }
  running.add(adapter);
  const controller = new AbortController();
  try {
    deps.onUi({ phase: "running", action, cancel: () => controller.abort() });
    let response: PluginEditorActionRunResult;
    try {
      response = await deps.run(action.pluginId, action.id, {
        noteId: snapshot.noteId, editor: adapter.kind, ...(action.selectionMode === "none" ? {} : { text: snapshot.text }),
      }, controller.signal);
    } catch (error) {
      deps.onUi({ phase: "idle" });
      if (controller.signal.aborted) return "cancelled";
      deps.notify.error(editorActionErrorMessage(error, deps.t));
      return "failed";
    }
    if (controller.signal.aborted) { deps.onUi({ phase: "idle" }); return "cancelled"; }
    if (action.resultMode === "none" || typeof response.text !== "string") {
      deps.onUi({ phase: "idle" });
      deps.notify.success(response.message || deps.t("editorActions.done", { label: action.label }));
      return "done";
    }

    const result = response.text, visible = projectMarkdownForUser(result), ai = response.aiGenerated === true;
    let mode: "replace" | "insert" = action.resultMode === "insert" || !snapshot.hasSelection ? "insert" : "replace";
    if (needsPreview(action)) {
      const choices: Array<"replace" | "insert"> = action.resultMode === "replace-selection" ? ["replace"]
        : action.resultMode === "insert" || !snapshot.hasSelection ? ["insert"] : ["replace", "insert"];
      const choice = await new Promise<EditorActionChoice>((resolve) => deps.onUi({ phase: "preview", action, original: snapshot.text, result: visible, ai, choices, resolve }));
      deps.onUi({ phase: "idle" });
      if (choice === "cancel") return "cancelled";
      if (choice === "copy") {
        await deps.copy(visible).then(() => deps.notify.success(deps.t("editorActions.copied")), () => deps.notify.error(deps.t("editorActions.copyFailed")));
        return "copied";
      }
      mode = choice;
    }
    // Replacements keep the block identities of the original text; plugins cannot inject internal markers.
    let markdown = mode === "replace" ? restoreInternalMarkdownMarkers(snapshot.original, result) : visible;
    if (ai) markdown = markAiMarkdown(markdown, createAiProvenance(), deps.t("ai.generatedLabel"));
    if (snapshot.apply(markdown, mode) === "conflict") {
      deps.onUi({
        phase: "conflict", action, result: visible,
        retry: () => { deps.onUi({ phase: "idle" }); void runEditorAction(adapter, action, deps); },
        dismiss: () => deps.onUi({ phase: "idle" }),
      });
      return "conflict";
    }
    deps.onUi({ phase: "idle" });
    adapter.focus();
    return "applied";
  } finally {
    running.delete(adapter);
    snapshot.release();
  }
}

import type { PluginEditorKind } from "@/lib/pluginApi";

export type EditorActionCaptureError = "NOT_READY" | "ENCRYPTED_REGION" | "TOO_LARGE";

/**
 * Host-only capture of the selection or insertion point at click time. Its range follows later edits;
 * `apply` refuses to write when the note, editor or captured text no longer matches.
 */
export interface EditorActionSnapshot {
  readonly kind: PluginEditorKind;
  readonly noteId: string;
  /** User-visible Markdown (internal block markers removed): the only text that leaves the client. */
  readonly text: string;
  /** Markdown as stored, including internal markers, used to keep block identities on replace. */
  readonly original: string;
  readonly hasSelection: boolean;
  /** Writes one undoable transaction; "conflict" means nothing was written. */
  apply(markdown: string, mode: "insert" | "replace"): "applied" | "conflict";
  release(): void;
}

export interface EditorActionAdapter {
  readonly kind: PluginEditorKind;
  isComposing(): boolean;
  hasSelection(): boolean;
  capture(): EditorActionSnapshot | { error: EditorActionCaptureError };
  focus(): void;
}

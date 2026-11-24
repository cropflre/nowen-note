import { useMemo, useRef, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import type { MdSlashItem } from "@/components/MarkdownSlashMenu";
import { createMarkdownEditorActionAdapter } from "@/lib/editorActions/markdownAdapter";
import { useEditorActionBinding, type EditorActionBindingOptions } from "./editorActionBinding";

/** Markdown binding: the same actions as rich text, applied as CodeMirror transactions. */
export function useMarkdownEditorActions(viewRef: RefObject<EditorView | null>, options: EditorActionBindingOptions) {
  const noteId = useRef(options.noteId); noteId.current = options.noteId;
  const adapter = useMemo(() => createMarkdownEditorActionAdapter(() => viewRef.current, () => noteId.current), [viewRef]);
  const binding = useEditorActionBinding(adapter, options);
  const slashItems = useMemo<MdSlashItem[]>(() => binding.slashEntries.map(({ run, ...item }) => ({ ...item, run: () => run() })), [binding.slashEntries]);
  return { slashItems, menu: binding.menu, host: binding.host };
}

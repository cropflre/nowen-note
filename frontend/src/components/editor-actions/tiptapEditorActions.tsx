import { useMemo, useRef } from "react";
import type { Editor } from "@tiptap/react";
import type { SlashCommandItem } from "@/components/SlashCommands";
import { createTiptapEditorActionAdapter } from "@/lib/editorActions/tiptapAdapter";
import { useEditorActionBinding, type EditorActionBindingOptions } from "./editorActionBinding";

/** Rich-text binding: plugin slash items, toolbar/selection menus and the preview host. */
export function useTiptapEditorActions(editor: Editor | null, options: EditorActionBindingOptions) {
  const noteId = useRef(options.noteId); noteId.current = options.noteId;
  const adapter = useMemo(() => (editor ? createTiptapEditorActionAdapter(editor, () => noteId.current) : null), [editor]);
  const binding = useEditorActionBinding(adapter, options);
  const slashItems = useMemo<SlashCommandItem[]>(() => binding.slashEntries.map(({ run, ...item }) => ({ ...item, action: run })), [binding.slashEntries]);
  return { slashItems, menu: binding.menu, host: binding.host };
}

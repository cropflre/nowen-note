import { isolateHistory } from "@codemirror/commands";
import { Compartment, MapMode, StateEffect, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownEncryptedBlocks } from "@/lib/encryptedNotes/blockDocument";
import { projectMarkdownForUser } from "@/lib/markdownUserContent";
import { EDITOR_ACTION_MAX_INPUT_BYTES, utf8Bytes } from "./registry";
import type { EditorActionAdapter, EditorActionSnapshot } from "./types";

function touchesEncryptedBlock(content: string, from: number, to: number): boolean {
  let blocks: Array<{ from: number; to: number }>;
  // An unterminated encrypted fence is treated as protected rather than as plain text.
  try { blocks = markdownEncryptedBlocks(content); } catch { return true; }
  return blocks.some((block) => (from < to ? from < block.to && to > block.from : from > block.from && from < block.to));
}

// One compartment per view holds the listeners of all pending snapshots, so repeated runs do not grow the config.
const followers = new WeakMap<EditorView, { compartment: Compartment; listeners: Set<Extension> }>();

function attachFollower(view: EditorView, listener: Extension): (() => void) | null {
  let entry = followers.get(view);
  if (!entry) { entry = { compartment: new Compartment(), listeners: new Set() }; followers.set(view, entry); }
  const { compartment, listeners } = entry;
  listeners.add(listener);
  try {
    // Re-append when the compartment is not part of the current state (first use, or a replaced state).
    const content = [...listeners];
    view.dispatch({ effects: compartment.get(view.state) === undefined ? StateEffect.appendConfig.of(compartment.of(content)) : compartment.reconfigure(content) });
  } catch { listeners.delete(listener); return null; }
  return () => {
    if (!listeners.delete(listener)) return;
    try { if (view.dom.isConnected && compartment.get(view.state) !== undefined) view.dispatch({ effects: compartment.reconfigure([...listeners]) }); } catch { /* view already destroyed */ }
  };
}

function trimRange(text: string, from: number, to: number): { from: number; to: number } {
  const lead = text.length - text.trimStart().length, trail = text.length - text.trimEnd().length;
  return lead + trail >= text.length ? { from, to: from } : { from: from + lead, to: to - trail };
}

export function createMarkdownEditorActionAdapter(getView: () => EditorView | null, getNoteId: () => string): EditorActionAdapter {
  return {
    kind: "markdown",
    isComposing: () => Boolean(getView()?.composing),
    hasSelection: () => {
      const view = getView();
      if (!view) return false;
      const { from, to } = view.state.selection.main;
      return from < to && view.state.sliceDoc(from, to).trim().length > 0;
    },
    focus: () => getView()?.focus(),
    capture() {
      const view = getView();
      if (!view || !view.dom.isConnected) return { error: "NOT_READY" };
      const state = view.state;
      const main = state.selection.main;
      const { from, to } = main.empty ? { from: main.from, to: main.to } : trimRange(state.sliceDoc(main.from, main.to), main.from, main.to);
      if (touchesEncryptedBlock(state.doc.toString(), from, to)) return { error: "ENCRYPTED_REGION" };
      const original = state.sliceDoc(from, to);
      const text = projectMarkdownForUser(original);
      if (utf8Bytes(text) > EDITOR_ACTION_MAX_INPUT_BYTES) return { error: "TOO_LARGE" };
      const noteId = getNoteId();
      const range = { from, to, alive: true };
      // Map the captured range through every later change (typing, collaboration, undo).
      const follow = EditorView.updateListener.of((update) => {
        if (!update.docChanged || !range.alive) return;
        if (range.from === range.to) {
          const pos = update.changes.mapPos(range.from, -1, MapMode.TrackDel);
          if (pos === null) range.alive = false; else range.from = range.to = pos;
          return;
        }
        const start = update.changes.mapPos(range.from, 1), end = update.changes.mapPos(range.to, -1);
        range.from = start; range.to = Math.max(start, end);
      });
      const detach = attachFollower(view, follow);
      if (!detach) return { error: "NOT_READY" };
      let released = false;
      const snapshot: EditorActionSnapshot = {
        kind: "markdown",
        noteId,
        text,
        original,
        hasSelection: from < to,
        apply(markdown, mode) {
          if (released || getView() !== view || !view.dom.isConnected || getNoteId() !== noteId || !range.alive) return "conflict";
          const current = view.state;
          if (current.readOnly || !current.facet(EditorView.editable) || range.to > current.doc.length) return "conflict";
          if (mode === "replace" && current.sliceDoc(range.from, range.to) !== original) return "conflict";
          let at = mode === "replace" ? { from: range.from, to: range.to } : { from: range.to, to: range.to };
          let insert = markdown;
          if (mode === "insert" && markdown.trim().includes("\n")) {
            // Block results start a new block after the current line instead of splitting it.
            const line = current.doc.lineAt(at.to);
            if (line.text.trim()) { at = { from: line.to, to: line.to }; insert = `\n\n${markdown}`; }
          }
          if (touchesEncryptedBlock(current.doc.toString(), at.from, at.to)) return "conflict";
          view.dispatch({
            changes: { from: at.from, to: at.to, insert },
            selection: { anchor: at.from + insert.length },
            userEvent: "input.plugin",
            annotations: isolateHistory.of("full"),
            scrollIntoView: true,
          });
          return "applied";
        },
        release() {
          if (released) return;
          released = true; range.alive = false;
          detach();
        },
      };
      return snapshot;
    },
  };
}

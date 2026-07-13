import { Extension, type Editor } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export interface SlashPluginState {
  active: boolean;
  /** ProseMirror document position of the slash character. */
  from: number;
  query: string;
}

export type SlashActivateHandler = (
  query: string,
  position: { top: number; left: number; from: number },
  sourceId?: string,
) => void;
export type SlashDeactivateHandler = (sourceId?: string) => void;
export type SlashQueryChangeHandler = (query: string, sourceId?: string) => void;

const slashPluginKey = new PluginKey<SlashPluginState>("slashCommands");
const editorIds = new WeakMap<object, string>();
let editorSequence = 0;

function inactiveState(): SlashPluginState {
  return { active: false, from: 0, query: "" };
}

export function getSlashEditorId(editor: Editor): string {
  const cached = editorIds.get(editor);
  if (cached) return cached;
  editorSequence += 1;
  const id = `slash-editor-${editorSequence}`;
  editorIds.set(editor, id);
  return id;
}

function normalizeMeta(meta: unknown): SlashPluginState | null {
  if (!meta || typeof meta !== "object") return null;
  const candidate = meta as Partial<SlashPluginState>;
  if (typeof candidate.active !== "boolean") return null;
  if (!candidate.active) return inactiveState();
  return {
    active: true,
    from: typeof candidate.from === "number" && Number.isFinite(candidate.from) ? candidate.from : 0,
    query: typeof candidate.query === "string" ? candidate.query : "",
  };
}

function charAt(state: EditorState, pos: number): string {
  if (pos < 0 || pos >= state.doc.content.size) return "";
  return state.doc.textBetween(pos, Math.min(pos + 1, state.doc.content.size), undefined, "\ufffc");
}

/** A slash may start a command at the beginning of a text block or after whitespace. */
export function isSlashTriggerContext(state: EditorState, from: number): boolean {
  if (from < 0 || from > state.doc.content.size) return false;
  try {
    const $from = state.doc.resolve(from);
    if (!$from.parent.isTextblock) return false;
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
    return textBefore.trim() === "" || /\s$/u.test(textBefore);
  } catch {
    return false;
  }
}

function readActiveQuery(state: EditorState, slashFrom: number): string | null {
  if (!state.selection.empty) return null;
  const cursor = state.selection.from;
  if (slashFrom < 0 || cursor < slashFrom + 1 || cursor > state.doc.content.size) return null;

  try {
    const $slash = state.doc.resolve(slashFrom);
    const $cursor = state.doc.resolve(cursor);
    if ($slash.parent !== $cursor.parent) return null;
    if (charAt(state, slashFrom) !== "/") return null;

    const query = state.doc.textBetween(slashFrom + 1, cursor, undefined, "\ufffc");
    // A second slash, whitespace, or a line break ends this suggestion session.
    if (/[\s/]/u.test(query)) return null;
    return query;
  } catch {
    return null;
  }
}

function slashWasNewlyInserted(tr: Transaction, oldState: EditorState, slashFrom: number): boolean {
  if (!tr.docChanged) return false;
  try {
    const oldFrom = tr.mapping.invert().map(slashFrom, -1);
    return charAt(oldState, oldFrom) !== "/";
  } catch {
    return true;
  }
}

function stateAfterTransaction(
  tr: Transaction,
  previous: SlashPluginState,
  oldState: EditorState,
  newState: EditorState,
): SlashPluginState {
  const meta = normalizeMeta(tr.getMeta(slashPluginKey));
  if (meta) return meta;

  if (previous.active) {
    const mappedFrom = tr.mapping.map(previous.from, -1);
    const query = readActiveQuery(newState, mappedFrom);
    return query == null
      ? inactiveState()
      : { active: true, from: mappedFrom, query };
  }

  // Fallback for Chromium/Opera/IME paths that commit text without invoking
  // ProseMirror's handleTextInput hook. Only activate when this transaction
  // actually introduced a new slash directly before the cursor.
  if (tr.docChanged && newState.selection.empty) {
    const slashFrom = newState.selection.from - 1;
    if (
      slashFrom >= 0 &&
      charAt(newState, slashFrom) === "/" &&
      isSlashTriggerContext(newState, slashFrom) &&
      slashWasNewlyInserted(tr, oldState, slashFrom)
    ) {
      return { active: true, from: slashFrom, query: "" };
    }
  }

  return previous;
}

function getMenuPosition(view: EditorView): { top: number; left: number } {
  let bottom = 12;
  let left = 12;
  try {
    const coords = view.coordsAtPos(view.state.selection.from);
    bottom = coords.bottom;
    left = coords.left;
  } catch {
    const rect = view.dom.getBoundingClientRect();
    bottom = rect.top + 24;
    left = rect.left + 12;
  }

  const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
  const viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth;
  return {
    top: Math.max(8, Math.min(bottom + 4, viewportHeight - 340)),
    left: Math.max(8, Math.min(left, viewportWidth - 300)),
  };
}

export function getSlashPluginState(editor: Editor): SlashPluginState {
  return slashPluginKey.getState(editor.state) ?? inactiveState();
}

export function deactivateSlashCommands(editor: Editor | null): void {
  if (!editor || (editor as Editor & { isDestroyed?: boolean }).isDestroyed) return;
  const current = slashPluginKey.getState(editor.state);
  if (!current?.active) return;
  editor.view.dispatch(editor.state.tr.setMeta(slashPluginKey, inactiveState()));
}

/**
 * Slash command extension driven by actual text insertion and transaction state.
 *
 * The old implementation listened for keydown and activated from a 10 ms timer.
 * Opera and IME composition can reorder or omit those keyboard events, leaving
 * the plugin active after the first command. This implementation inserts `/`
 * through handleTextInput when possible and derives all later state from the
 * authoritative ProseMirror document/selection.
 */
export function createSlashExtension(
  onActivate: SlashActivateHandler,
  onDeactivate: SlashDeactivateHandler,
  onQueryChange: SlashQueryChangeHandler,
) {
  return Extension.create({
    name: "slashCommands",

    addProseMirrorPlugins() {
      const editor = this.editor;
      const sourceId = getSlashEditorId(editor);

      return [
        new Plugin<SlashPluginState>({
          key: slashPluginKey,
          state: {
            init: inactiveState,
            apply: stateAfterTransaction,
          },
          props: {
            handleTextInput(view, from, to, text) {
              const current = slashPluginKey.getState(view.state);
              // Do not interrupt an in-progress IME composition. Let the DOM
              // commit finish; stateAfterTransaction will detect the new slash.
              if (
                view.composing ||
                text !== "/" ||
                current?.active ||
                !isSlashTriggerContext(view.state, from)
              ) {
                return false;
              }

              // Insert and activate in one transaction. There is no timer, so
              // a close/select transaction cannot race a delayed activation.
              view.dispatch(
                view.state.tr
                  .insertText(text, from, to)
                  .setMeta(slashPluginKey, { active: true, from, query: "" } satisfies SlashPluginState),
              );
              return true;
            },
            handleKeyDown(view, event) {
              if (event.key !== "Escape") return false;
              const current = slashPluginKey.getState(view.state);
              if (!current?.active) return false;
              view.dispatch(view.state.tr.setMeta(slashPluginKey, inactiveState()));
              return true;
            },
          },
          view() {
            return {
              update(view, previousEditorState) {
                const previous = slashPluginKey.getState(previousEditorState) ?? inactiveState();
                const current = slashPluginKey.getState(view.state) ?? inactiveState();

                if (!previous.active && current.active) {
                  onActivate(current.query, { ...getMenuPosition(view), from: current.from }, sourceId);
                  return;
                }
                if (previous.active && !current.active) {
                  onDeactivate(sourceId);
                  return;
                }
                if (current.active && previous.query !== current.query) {
                  onQueryChange(current.query, sourceId);
                }
              },
              destroy() {
                if (slashPluginKey.getState(editor.state)?.active) {
                  onDeactivate(sourceId);
                }
              },
            };
          },
        }),
      ];
    },
  });
}

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
  position: { top: number; left: number; from: number; trigger?: { top: number; bottom: number; left: number; right: number } },
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

function readActiveQuery(
  state: EditorState,
  slashFrom: number,
  allowCompositionSelection = false,
): string | null {
  if (!state.selection.empty && !allowCompositionSelection) return null;
  // 输入法组合态可能用非空选区标记正在拼写的文本，此时查询范围应取选区末端。
  const cursor = allowCompositionSelection ? state.selection.to : state.selection.from;
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
    const isCompositionTransaction = tr.getMeta("composition") != null;
    const query = readActiveQuery(newState, mappedFrom, isCompositionTransaction);
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

function getMenuPosition(view: EditorView): { top: number; left: number; trigger: BlockMenuTrigger } {
  let top = 12, left = 12, bottom = 12, right = 12;
  try {
    const coords = view.coordsAtPos(view.state.selection.from);
    top = coords.top; bottom = coords.bottom; left = coords.left; right = coords.right;
  } catch {
    const rect = view.dom.getBoundingClientRect();
    top = rect.top; bottom = rect.bottom; left = rect.left; right = rect.left + 12;
  }
  const trigger = { top, bottom, left, right };
  return { ...getSmartBlockMenuPosition(trigger, BLOCK_MENU_ESTIMATED_SIZE), trigger };
}

/* ------------------------------------------------------------------ */
/*  智能菜单定位（导出供 TiptapEditor 拖拽柄与 / 触发共用）            */
/* ------------------------------------------------------------------ */

export interface BlockMenuTrigger {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
export interface BlockMenuSize {
  width: number;
  height: number;
}
/** 菜单的最大预估尺寸（用于定位时留够空间；实际尺寸由 CSS max-h 控制） */
export const BLOCK_MENU_ESTIMATED_SIZE: BlockMenuSize = { width: 320, height: 360 };

/**
 * 菜单定位：
 * - 水平：紧贴触发源右侧（offset=0），溢出视口时翻到左侧
 * - 垂直：优先在触发源下方显示；下方空间不够则翻到上方；都不够则贴触发源顶部
 * - 保证菜单不超出视口边界
 */
export function getSmartBlockMenuPosition(
  trigger: BlockMenuTrigger,
  menuSize: BlockMenuSize,
  viewport?: { width: number; height: number },
  offset: number = 0,
): { top: number; left: number } {
  const margin = 6;
  const vw = viewport?.width ?? (typeof window === "undefined" ? 1200 : window.innerWidth);
  const vh = viewport?.height ?? (typeof window === "undefined" ? 800 : window.innerHeight);

  // 水平：紧贴触发源右侧，不够则翻到左侧
  let left = trigger.right + offset;
  if (left + menuSize.width > vw - margin) {
    left = trigger.left - offset - menuSize.width;
  }
  left = Math.max(margin, Math.min(left, vw - menuSize.width - margin));

  // 垂直：优先在触发源下方；下方不够则翻上方；都不够则贴顶
  let top = trigger.bottom + 4; // 触发源下方留 4px 间距
  if (top + menuSize.height > vh - margin) {
    // 下方放不下 → 尝试放到触发源上方
    const topAbove = trigger.top - 4 - menuSize.height;
    if (topAbove >= margin) {
      top = topAbove;
    } else {
      // 上下都放不下 → 贴顶部
      top = margin;
    }
  }

  return { top, left };
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
                  const pos = getMenuPosition(view);
                  onActivate(current.query, { top: pos.top, left: pos.left, from: current.from, trigger: pos.trigger }, sourceId);
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

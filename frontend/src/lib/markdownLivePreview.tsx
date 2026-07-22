import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { syntaxTree } from "@codemirror/language";
import {
  EditorState,
  RangeSetBuilder,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import {
  applyMarkdownTaskCheckboxChange,
  getMarkdownTaskCheckboxChange,
} from "@/lib/markdownTasks";

const BLOCK_NODE_RE = /^(?:ATXHeading[1-6]|SetextHeading[12]|Paragraph|Blockquote|BulletList|OrderedList|FencedCode|CodeBlock|HorizontalRule|HTMLBlock|Table)$/;
const STANDALONE_IAL_RE = /^\s*\{:\s*[\s\S]*\}\s*$/;
const roots = new WeakMap<HTMLElement, Root>();

export interface MarkdownLivePreviewBlock {
  from: number;
  to: number;
  markdown: string;
}

function getEditorState(source: EditorView | EditorState): EditorState {
  return source instanceof EditorView ? source.state : source;
}

function expandToWholeLines(state: EditorState, from: number, to: number): { from: number; to: number } {
  const startLine = state.doc.lineAt(Math.max(0, Math.min(from, state.doc.length)));
  const inclusiveEnd = Math.max(from, to - 1);
  const endLine = state.doc.lineAt(Math.max(0, Math.min(inclusiveEnd, state.doc.length)));
  return { from: startLine.from, to: endLine.to };
}

function lineAfter(state: EditorState, position: number) {
  if (position >= state.doc.length) return null;
  const current = state.doc.lineAt(position);
  return current.number < state.doc.lines ? state.doc.line(current.number + 1) : null;
}

function expandSemanticTail(
  state: EditorState,
  range: { from: number; to: number },
): { from: number; to: number } {
  let to = range.to;
  const firstLine = state.doc.lineAt(range.from).text;
  const quoteBlock = /^\s*>/.test(firstLine);

  while (to < state.doc.length) {
    const next = lineAfter(state, to);
    if (!next) break;
    const text = next.text;

    // SiYuan block IAL rows belong to the preceding semantic block. Parsing them
    // as a separate live-preview paragraph is one of the reasons imported
    // callouts/tables differed from the complete-document preview.
    if (STANDALONE_IAL_RE.test(text)) {
      to = next.to;
      continue;
    }

    // CodeMirror may expose nested/continued blockquote lines as siblings. Keep
    // the whole quote together so a GFM alert marker and its body are parsed by
    // one ReactMarkdown instance.
    if (quoteBlock && /^\s*>/.test(text)) {
      to = next.to;
      continue;
    }

    break;
  }

  return { from: range.from, to };
}

function isSameSemanticContainer(left: string, right: string, gap: string): boolean {
  if (/^\s*>/.test(left) && /^\s*>/.test(right)) return true;
  if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(left) && /^\s*(?:[-+*]|\d+[.)])\s+/.test(right)) {
    return /^\s*$/.test(gap);
  }
  if (/^\s*\|/.test(left) && /^\s*\|/.test(right)) return /^\s*$/.test(gap);
  return false;
}

function mergeSemanticRanges(
  state: EditorState,
  ranges: Array<{ from: number; to: number }>,
): Array<{ from: number; to: number }> {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: Array<{ from: number; to: number }> = [];

  for (const current of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...current });
      continue;
    }
    if (current.from <= previous.to) {
      previous.to = Math.max(previous.to, current.to);
      continue;
    }

    const left = state.doc.lineAt(Math.max(previous.from, previous.to - 1)).text;
    const right = state.doc.lineAt(current.from).text;
    const gap = state.doc.sliceString(previous.to, current.from);
    if (isSameSemanticContainer(left, right, gap)) {
      previous.to = current.to;
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

/**
 * Collect top-level semantic blocks that do not intersect the current selection.
 *
 * Live preview and full preview both render through MarkdownPreview. The important
 * invariant is therefore the input boundary: quote/callout continuations and
 * SiYuan IAL rows must reach the renderer as one block instead of several isolated
 * Markdown fragments.
 */
export function collectMarkdownLivePreviewBlocks(
  source: EditorView | EditorState,
): MarkdownLivePreviewBlock[] {
  const state = getEditorState(source);
  const selection = state.selection.main;
  const cursor = syntaxTree(state).cursor();
  const candidates: Array<{ from: number; to: number }> = [];
  const seen = new Set<string>();
  if (!cursor.firstChild()) return [];

  do {
    const node = cursor.node;
    if (!BLOCK_NODE_RE.test(node.name) || node.from >= node.to) continue;
    const range = expandSemanticTail(state, expandToWholeLines(state, node.from, node.to));
    const key = `${range.from}:${range.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(range);
  } while (cursor.nextSibling());

  return mergeSemanticRanges(state, candidates)
    .filter((range) => !(selection.from <= range.to && selection.to >= range.from))
    .map((range) => ({
      ...range,
      markdown: state.doc.sliceString(range.from, range.to),
    }));
}

class MarkdownLivePreviewWidget extends WidgetType {
  constructor(
    readonly markdown: string,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: MarkdownLivePreviewWidget): boolean {
    return this.markdown === other.markdown && this.from === other.from && this.to === other.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-live-preview-block";
    host.dataset.mdFrom = String(this.from);
    host.dataset.mdTo = String(this.to);

    host.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, button, a, video, audio, iframe")) return;
      event.preventDefault();
      view.dispatch({
        selection: { anchor: this.from },
        effects: EditorView.scrollIntoView(this.from, { y: "center" }),
      });
      view.focus();
    });

    const root = createRoot(host);
    roots.set(host, root);
    root.render(
      <MarkdownPreview
        markdown={this.markdown}
        compact
        className="cm-live-preview-render !h-auto !overflow-visible !p-0"
        onTaskCheckboxChange={(taskIndex, checked) => {
          const change = getMarkdownTaskCheckboxChange(this.markdown, taskIndex, checked);
          if (!change) return;
          const nextBlock = applyMarkdownTaskCheckboxChange(this.markdown, change);
          view.dispatch({
            changes: { from: this.from, to: this.to, insert: nextBlock },
          });
        }}
      />,
    );
    return host;
  }

  destroy(dom: HTMLElement): void {
    const root = roots.get(dom);
    roots.delete(dom);
    queueMicrotask(() => root?.unmount());
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  // Large documents stay responsive because CodeMirror's syntax tree is incremental;
  // this hard ceiling prevents thousands of React roots on pathological imports.
  if (state.doc.length > 350_000) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  for (const block of collectMarkdownLivePreviewBlocks(state)) {
    builder.add(
      block.from,
      block.to,
      Decoration.replace({
        widget: new MarkdownLivePreviewWidget(block.markdown, block.from, block.to),
        block: true,
      }),
    );
  }
  return builder.finish();
}

const livePreviewDecorations = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, transaction) {
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    return transaction.docChanged || selectionChanged ? buildDecorations(transaction.state) : value;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});

const livePreviewTheme = EditorView.theme({
  ".cm-live-preview-block": {
    boxSizing: "border-box",
    cursor: "text",
    padding: "2px 12px",
    width: "100%",
  },
  ".cm-live-preview-block:hover": {
    backgroundColor: "color-mix(in srgb, var(--color-app-hover, #f1f5f9) 55%, transparent)",
    borderRadius: "8px",
  },
  ".cm-live-preview-block .nowen-md-preview": {
    maxWidth: "none",
    margin: "0",
  },
  ".cm-live-preview-block .cm-live-preview-render > :first-child": { marginTop: "0" },
  ".cm-live-preview-block .cm-live-preview-render > :last-child": { marginBottom: "0" },
});

export const markdownLivePreviewExtension: Extension = [livePreviewDecorations, livePreviewTheme];

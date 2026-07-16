import type { Editor } from "@tiptap/react";
import {
  DOMParser as ProseMirrorDOMParser,
  Fragment,
  Node as ProseMirrorNode,
  Schema,
} from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { canJoin } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { isEditorDocumentMutable } from "@/lib/codeBlockPermissions";

export function createPlainTextParagraphContainer(text: string): HTMLDivElement {
  const root = document.createElement("div");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  for (const line of lines) {
    const paragraph = document.createElement("p");
    if (line.length > 0) {
      paragraph.textContent = line;
    } else {
      paragraph.appendChild(document.createElement("br"));
    }
    root.appendChild(paragraph);
  }

  return root;
}

export function insertPlainTextPreservingParagraphs(view: EditorView, text: string): boolean {
  if (!text) return true;

  if (!/[\r\n]/.test(text)) {
    view.dispatch(view.state.tr.insertText(text));
    return true;
  }

  const parser = ProseMirrorDOMParser.fromSchema(view.state.schema);
  const slice = parser.parseSlice(createPlainTextParagraphContainer(text));
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
  return true;
}

export function createPlainTextParagraphNodes(schema: Schema, text: string): ProseMirrorNode[] {
  const paragraphType = schema.nodes.paragraph;
  if (!paragraphType) return [];

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.map((line) =>
    line.length > 0
      ? paragraphType.create(null, schema.text(line))
      : paragraphType.create(),
  );
}

export function replaceCodeBlockWithPlainText(
  editor: Editor,
  pos: number,
  node: ProseMirrorNode,
): boolean {
  // `editable: false` only blocks DOM input. Programmatic NodeView transactions
  // still reach EditorView.dispatch, so the command itself must enforce read-only.
  if (!isEditorDocumentMutable(editor)) return false;

  const view = editor.view;
  const paragraphs = createPlainTextParagraphNodes(view.state.schema, node.textContent);
  if (paragraphs.length === 0) return false;

  const fragment = Fragment.fromArray(paragraphs);
  const tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, fragment);
  const lastParagraph = paragraphs[paragraphs.length - 1];
  const caretPos = Math.max(pos, pos + fragment.size - lastParagraph.nodeSize + lastParagraph.content.size + 1);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caretPos, tr.doc.content.size)), -1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export function insertCodeBlockNewline(view: EditorView): boolean {
  const { state } = view;
  const { selection } = state;
  if (selection.$from.parent.type.name !== "codeBlock") return false;
  if (selection.$to.parent.type.name !== "codeBlock") return false;

  const tr = state.tr.insertText("\n", selection.from, selection.to);
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export function isAllowedRemoteImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function attrsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

export function findAdjacentListJoinPositions(doc: any): number[] {
  const positions: number[] = [];

  const scanChildren = (parent: any, contentStart: number) => {
    if (!parent?.content || parent.childCount === 0) return;

    let offset = contentStart;
    let previous: any = null;
    for (let index = 0; index < parent.childCount; index += 1) {
      const child = parent.child(index);
      const isJoinableList =
        child.type.name === "orderedList" || child.type.name === "bulletList";

      if (
        previous &&
        isJoinableList &&
        previous.type.name === child.type.name &&
        attrsEqual(previous.attrs, child.attrs) &&
        canJoin(doc, offset)
      ) {
        positions.push(offset);
      }

      scanChildren(child, offset + 1);
      previous = child;
      offset += child.nodeSize;
    }
  };

  scanChildren(doc, 0);

  return positions;
}

export function normalizeAdjacentLists(editor: Editor): boolean {
  if (!editor || editor.isDestroyed) return false;

  const positions = findAdjacentListJoinPositions(editor.state.doc);
  if (positions.length === 0) return false;

  let tr = editor.state.tr;
  for (const pos of positions.sort((a, b) => b - a)) {
    tr = tr.join(pos);
  }
  editor.view.dispatch(tr);
  return true;
}

export function toggleOrderedListSmart(editor: Editor): boolean {
  const ok = editor.chain().focus().toggleOrderedList().run();
  if (ok) normalizeAdjacentLists(editor);
  return ok;
}

export function toggleBulletListSmart(editor: Editor): boolean {
  const ok = editor.chain().focus().toggleBulletList().run();
  if (ok) normalizeAdjacentLists(editor);
  return ok;
}

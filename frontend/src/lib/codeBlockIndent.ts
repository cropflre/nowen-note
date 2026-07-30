import { Extension } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { Fragment, Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { ResolvedPos } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Selection, Transaction } from "@tiptap/pm/state";
import { liftTarget } from "@tiptap/pm/transform";
import { isEditorDocumentMutable } from "@/lib/codeBlockPermissions";

export const INDENT_MIN = 0;
export const INDENT_MAX = 8;

export const INDENTABLE_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
] as const;

const INDENTABLE_TYPE_SET = new Set<string>(INDENTABLE_TYPES);
const LIST_TYPE_SET = new Set(["bulletList", "orderedList", "taskList"]);
const LIST_ITEM_TYPE_SET = new Set(["listItem", "taskItem"]);

type IndentState = Pick<EditorState, "doc" | "selection">;

export type IndentTarget = {
  node: ProseMirrorNode;
  pos: number;
};

export function normalizeIndentValue(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return INDENT_MIN;
  return Math.max(INDENT_MIN, Math.min(INDENT_MAX, Math.trunc(numeric)));
}

function findNearestAncestor(
  $pos: ResolvedPos,
  typeNames: ReadonlySet<string>,
): IndentTarget | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (!typeNames.has(node.type.name)) continue;
    return { node, pos: $pos.before(depth) };
  }
  return null;
}

/**
 * Resolve a single code block when the selection is wholly inside it.
 * This deliberately wins over list ancestors so a code block nested in a
 * list item never causes the whole list item/list to be indented by accident.
 */
export function resolveSelectedCodeBlock(state: IndentState): IndentTarget | null {
  const { doc, selection } = state;
  if (selection instanceof NodeSelection && selection.node.type.name === "codeBlock") {
    return { node: selection.node, pos: selection.from };
  }

  const fromTarget = findNearestAncestor(selection.$from, new Set(["codeBlock"]));
  if (!fromTarget) return null;

  if (selection.empty) return fromTarget;
  const toProbe = doc.resolve(Math.max(selection.from, selection.to - 1));
  const toTarget = findNearestAncestor(toProbe, new Set(["codeBlock"]));
  return toTarget?.pos === fromTarget.pos ? fromTarget : null;
}

/**
 * Return stable, non-overlapping indent targets.
 *
 * - Empty selections resolve to the nearest indentable ancestor.
 * - A selection inside one code block resolves only that code block.
 * - Multi-block selections keep the outermost selected blocks and never
 *   process a list plus one of its descendants twice.
 */
export function resolveIndentTargets(state: IndentState): IndentTarget[] {
  const selectedCodeBlock = resolveSelectedCodeBlock(state);
  if (selectedCodeBlock) return [selectedCodeBlock];

  const { doc, selection } = state;
  if (selection.empty) {
    const target = findNearestAncestor(selection.$from, INDENTABLE_TYPE_SET);
    return target ? [target] : [];
  }

  if (selection instanceof NodeSelection && INDENTABLE_TYPE_SET.has(selection.node.type.name)) {
    return [{ node: selection.node, pos: selection.from }];
  }

  const targets: IndentTarget[] = [];
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (!INDENTABLE_TYPE_SET.has(node.type.name)) return true;
    targets.push({ node, pos });
    // The selected outer block owns this range. Do not also indent nested
    // code blocks, paragraphs, or lists.
    return false;
  });

  return targets.filter((target, index) =>
    targets.findIndex((candidate) => candidate.pos === target.pos) === index,
  );
}

function attrsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

function selectionFallsInsideNode(
  selection: Selection,
  nodePos: number,
  node: ProseMirrorNode,
): boolean {
  const contentFrom = nodePos + 1;
  const contentTo = contentFrom + node.content.size;
  return selection.from >= contentFrom && selection.to <= contentTo;
}

function restoreSelectionInMovedCodeBlock(
  tr: Transaction,
  selection: Selection,
  oldPos: number,
  newPos: number,
  node: ProseMirrorNode,
): void {
  if (selection instanceof NodeSelection && selection.from === oldPos) {
    tr.setSelection(NodeSelection.create(tr.doc, newPos));
    return;
  }

  if (selection instanceof TextSelection && selectionFallsInsideNode(selection, oldPos, node)) {
    const maxOffset = node.content.size;
    const fromOffset = Math.max(0, Math.min(maxOffset, selection.from - oldPos - 1));
    const toOffset = Math.max(fromOffset, Math.min(maxOffset, selection.to - oldPos - 1));
    tr.setSelection(TextSelection.create(
      tr.doc,
      newPos + 1 + fromOffset,
      newPos + 1 + toOffset,
    ));
    return;
  }

  try {
    tr.setSelection(selection.map(tr.doc, tr.mapping));
  } catch {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(newPos + 1, tr.doc.content.size))));
  }
}

/**
 * Move a standalone code block into the last item of an immediately preceding
 * list. If another list of the same kind follows the code block, merge it into
 * the first list so ordered numbering continues naturally.
 */
export function nestCodeBlockInPreviousList(
  tr: Transaction,
  target: IndentTarget,
): boolean {
  const currentNode = tr.doc.nodeAt(target.pos);
  if (!currentNode || currentNode.type.name !== "codeBlock") return false;

  const $before = tr.doc.resolve(target.pos);
  const parent = $before.parent;
  const index = $before.index();
  if (index <= 0 || index >= parent.childCount) return false;

  const previousList = parent.child(index - 1);
  if (!LIST_TYPE_SET.has(previousList.type.name) || previousList.childCount === 0) return false;

  const lastItemIndex = previousList.childCount - 1;
  const lastItem = previousList.child(lastItemIndex);
  if (!LIST_ITEM_TYPE_SET.has(lastItem.type.name)) return false;

  const appendedItemContent = lastItem.content.append(Fragment.from(currentNode));
  if (!lastItem.type.validContent(appendedItemContent)) return false;
  const appendedItem = lastItem.copy(appendedItemContent);
  let mergedListContent = previousList.content.replaceChild(lastItemIndex, appendedItem);

  const following = index + 1 < parent.childCount ? parent.child(index + 1) : null;
  const mergeFollowing = Boolean(
    following
    && following.type === previousList.type
    && LIST_TYPE_SET.has(following.type.name),
  );
  if (mergeFollowing && following) {
    mergedListContent = mergedListContent.append(following.content);
  }
  if (!previousList.type.validContent(mergedListContent)) return false;

  const previousListPos = target.pos - previousList.nodeSize;
  const replaceTo = target.pos
    + currentNode.nodeSize
    + (mergeFollowing && following ? following.nodeSize : 0);
  const previousSelection = tr.selection;
  const previousItemsSize = previousList.content.size - lastItem.nodeSize;
  const newCodeBlockPos = previousListPos
    + 1
    + previousItemsSize
    + 1
    + lastItem.content.size;

  tr.replaceWith(previousListPos, replaceTo, previousList.copy(mergedListContent));
  restoreSelectionInMovedCodeBlock(
    tr,
    previousSelection,
    target.pos,
    newCodeBlockPos,
    currentNode,
  );
  return true;
}

function isCodeBlockInsideListItem(doc: ProseMirrorNode, pos: number): boolean {
  const probe = doc.resolve(Math.min(pos + 1, doc.content.size));
  let sawListItem = false;
  for (let depth = probe.depth; depth > 0; depth -= 1) {
    const typeName = probe.node(depth).type.name;
    if (LIST_ITEM_TYPE_SET.has(typeName)) {
      sawListItem = true;
      continue;
    }
    if (sawListItem && LIST_TYPE_SET.has(typeName)) return true;
  }
  return false;
}

/**
 * Lift a code block out of a list item. ProseMirror's lift step splits the list
 * around the block when needed, preserving the surrounding numbered items.
 */
export function liftCodeBlockFromList(
  tr: Transaction,
  target: IndentTarget,
): boolean {
  const currentNode = tr.doc.nodeAt(target.pos);
  if (!currentNode || currentNode.type.name !== "codeBlock") return false;
  if (!isCodeBlockInsideListItem(tr.doc, target.pos)) return false;

  const previousSelection = tr.selection;
  const $from = tr.doc.resolve(target.pos);
  const $to = tr.doc.resolve(target.pos + currentNode.nodeSize);
  const range = $from.blockRange($to);
  if (!range) return false;
  const depth = liftTarget(range);
  if (depth == null) return false;

  tr.lift(range, depth);
  try {
    tr.setSelection(previousSelection.map(tr.doc, tr.mapping));
  } catch {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(target.pos + 1, tr.doc.content.size))));
  }
  return true;
}

function applyVisualIndent(
  tr: Transaction,
  targets: IndentTarget[],
  delta: number,
): boolean {
  let changed = false;
  for (const target of targets) {
    const node = tr.doc.nodeAt(target.pos);
    if (!node || !INDENTABLE_TYPE_SET.has(node.type.name)) continue;
    const current = normalizeIndentValue(node.attrs.indent);
    const next = normalizeIndentValue(current + delta);
    if (next === current) continue;
    tr.setNodeMarkup(target.pos, undefined, { ...node.attrs, indent: next });
    changed = true;
  }
  return changed;
}

export const IndentExtension = Extension.create({
  name: "indent",

  addGlobalAttributes() {
    return [
      {
        types: [...INDENTABLE_TYPES],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => normalizeIndentValue(element.getAttribute("data-indent")),
            renderHTML: (attributes) => {
              const indent = normalizeIndentValue(attributes.indent);
              return indent > 0 ? { "data-indent": indent } : {};
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      changeIndent: (delta: number) => ({ editor, state, tr, dispatch }: {
        editor: Editor;
        state: EditorState;
        tr: Transaction;
        dispatch?: (transaction: Transaction) => void;
      }) => {
        if (!Number.isFinite(delta) || delta === 0) return false;
        if (!isEditorDocumentMutable(editor)) return false;

        const targets = resolveIndentTargets({ doc: tr.doc, selection: tr.selection });
        if (targets.length === 0) return false;

        let changed = false;
        if (targets.length === 1 && targets[0].node.type.name === "codeBlock") {
          const currentNode = tr.doc.nodeAt(targets[0].pos);
          const currentIndent = normalizeIndentValue(currentNode?.attrs.indent);
          if (delta > 0) {
            changed = nestCodeBlockInPreviousList(tr, targets[0]);
          } else if (delta < 0 && currentIndent === 0) {
            changed = liftCodeBlockFromList(tr, targets[0]);
          }
        }

        if (!changed) changed = applyVisualIndent(tr, targets, delta);
        if (changed && dispatch) dispatch(tr.scrollIntoView());
        return changed;
      },
    } as any;
  },
});

export function isCodeBlockSelectionActive(state: IndentState): boolean {
  return resolveSelectedCodeBlock(state) !== null;
}

export function shouldMergeListAfterCodeBlock(
  previous: ProseMirrorNode,
  following: ProseMirrorNode,
): boolean {
  return previous.type === following.type
    && LIST_TYPE_SET.has(previous.type.name)
    && (attrsEqual(previous.attrs, following.attrs) || previous.type.name === "orderedList");
}

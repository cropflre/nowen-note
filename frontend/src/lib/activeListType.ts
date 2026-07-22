export type ActiveListType = "bulletList" | "orderedList" | "taskList" | null;

interface EditorSelectionPath {
  depth: number;
  node: (depth: number) => { type: { name: string } };
}

interface EditorLike {
  state: {
    selection: {
      $from: EditorSelectionPath;
    };
  };
}

/** 返回光标最近的列表祖先，避免混合嵌套时多个列表状态同时命中。 */
export function getActiveListType(editor: EditorLike | null): ActiveListType {
  if (!editor) return null;
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === "bulletList" || name === "orderedList" || name === "taskList") {
      return name;
    }
  }
  return null;
}

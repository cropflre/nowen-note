export const KNOWLEDGE_TREE_CLEAR_SEARCH_EVENT = "nowen:knowledge-tree-clear-search";
export const KNOWLEDGE_TREE_REVEAL_NOTE_EVENT = "nowen:knowledge-tree-reveal-note";

export type KnowledgeTreeRevealNoteDetail = {
  noteId: string;
  revealTree?: boolean;
  notebookId?: string;
};

/** 显式定位已打开的文档；目录内单击只定位中间列表，保留目录筛选。 */
export function revealKnowledgeTreeNote(noteId: string, revealTree = true, notebookId?: string): void {
  window.dispatchEvent(new CustomEvent<KnowledgeTreeRevealNoteDetail>(
    KNOWLEDGE_TREE_REVEAL_NOTE_EVENT,
    { detail: { noteId, revealTree, notebookId } },
  ));
}

export type KnowledgeTreeClearSearchDetail = {
  parentId?: string | null;
  nodeId?: string;
  clearOnly?: boolean;
};

/** 文档创建成功后展开目标目录；传入新节点 ID 时，在刷新后定位并选中。 */
export function revealCreatedKnowledgeTreeNote(parentId?: string | null, nodeId?: string): void {
  window.dispatchEvent(new CustomEvent<KnowledgeTreeClearSearchDetail>(
    KNOWLEDGE_TREE_CLEAR_SEARCH_EVENT,
    { detail: { parentId, nodeId } },
  ));
}

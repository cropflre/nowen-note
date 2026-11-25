import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import type { NoteListItem, Notebook } from "@/types";

export interface NoteParentDisplayMeta {
  /** 直接上级名称（优先父文档或父文件夹标题，其次笔记本名称） */
  label: string;
  /** 完整层级路径（用于悬停提示或搜索匹配） */
  path: string;
  /** 直接上级是否为文档节点（true = 父文档，false = 文件夹/笔记本） */
  parentIsDocument: boolean;
  /** 直接上级的知识树节点 ID（便于判断是否与当前目录重合） */
  parentNodeId: string | null;
}

function buildNotebookPathMap(notebooks: Notebook[]): Map<string, { name: string; path: string }> {
  const byId = new Map(notebooks.map((nb) => [nb.id, nb]));
  const result = new Map<string, { name: string; path: string }>();

  for (const nb of notebooks) {
    const segments: string[] = [];
    const visited = new Set<string>();
    let cursor: string | null | undefined = nb.id;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const item = byId.get(cursor);
      if (!item) break;
      segments.unshift(item.name);
      cursor = item.parentId ?? null;
    }
    result.set(nb.id, {
      name: nb.name,
      path: segments.length > 0 ? segments.join(" / ") : nb.name,
    });
  }

  return result;
}

/**
 * 为每篇笔记推导其「直接上级」展示信息：
 * - 优先使用已过滤加锁子孙的可见知识树节点，支持「文档下建子文档」和「文件夹下建文档」两种模式；
 * - 若知识树未加载或不含该笔记，则平滑回退到 note.notebookId 对应的笔记本名称。
 */
export function buildNoteParentMetaMap({
  notes,
  visibleTreeNodes,
  notebooks,
  unknownNotebookLabel,
}: {
  notes: Pick<NoteListItem, "id" | "notebookId">[];
  visibleTreeNodes: KnowledgeTreeNode[];
  notebooks: Notebook[];
  unknownNotebookLabel: string;
}): Map<string, NoteParentDisplayMeta> {
  const result = new Map<string, NoteParentDisplayMeta>();
  const notebookPaths = buildNotebookPathMap(notebooks);

  const treeById = new Map<string, KnowledgeTreeNode>();
  const noteNodeByResourceId = new Map<string, KnowledgeTreeNode>();
  for (const node of visibleTreeNodes) {
    if (node.isDeleted === 1) continue;
    treeById.set(node.id, node);
    if (node.resourceType === "note" && node.resourceId) {
      noteNodeByResourceId.set(node.resourceId, node);
    }
  }

  for (const note of notes) {
    const treeNode = noteNodeByResourceId.get(note.id);
    if (treeNode && treeNode.parentId) {
      const parent = treeById.get(treeNode.parentId);
      if (parent) {
        const ancestors: string[] = [];
        const visited = new Set<string>([treeNode.id]);
        let cursor: string | null = treeNode.parentId;
        while (cursor && !visited.has(cursor)) {
          visited.add(cursor);
          const ancestor = treeById.get(cursor);
          if (!ancestor) break;
          ancestors.unshift(ancestor.title);
          cursor = ancestor.parentId;
        }
        result.set(note.id, {
          label: parent.title,
          path: ancestors.join(" / ") || parent.title,
          parentIsDocument: parent.nodeType !== "folder",
          parentNodeId: parent.id,
        });
        continue;
      }
    }

    const nb = notebookPaths.get(note.notebookId);
    result.set(note.id, {
      label: nb?.name || unknownNotebookLabel,
      path: nb?.path || unknownNotebookLabel,
      parentIsDocument: false,
      parentNodeId: null,
    });
  }

  return result;
}

/**
 * 在知识树中按「父目录 / 父文档名称」匹配子文档：
 * 例如父目录或父文档叫「驰铭-13012510_CM-2083W」，子文档标题是「261030-007」。
 * 当搜索「2510」时，即使子文档正文和标题里没有 2510，也能把归属其下的可见子文档一并带出。
 *
 * 安全约束：调用方必须传入经过 `hideLockedFolderDescendants` 过滤的可见节点列表，
 * 绝不暴露已加密锁定目录中的任何子文档。
 */
export function findNotesMatchingParentPath({
  visibleTreeNodes,
  query,
  existingNoteIds,
}: {
  visibleTreeNodes: KnowledgeTreeNode[];
  query: string;
  existingNoteIds: Set<string>;
}): NoteListItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];

  const byId = new Map<string, KnowledgeTreeNode>();
  for (const node of visibleTreeNodes) {
    if (node.isDeleted === 1) continue;
    byId.set(node.id, node);
  }

  const matched: NoteListItem[] = [];
  const addedIds = new Set<string>();

  for (const node of visibleTreeNodes) {
    if (node.isDeleted === 1) continue;
    if (node.resourceType !== "note" || !node.resourceId) continue;
    if (node.noteType === "sheet" || node.noteType === "excel") continue;
    if (existingNoteIds.has(node.resourceId) || addedIds.has(node.resourceId)) continue;

    // 向上遍历祖先（支持父文档与父文件夹）
    const ancestorTitles: string[] = [];
    const visited = new Set<string>([node.id]);
    let cursor = node.parentId;
    let ancestorMatched = false;
    let nearestNotebookResourceId = "";

    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const ancestor = byId.get(cursor);
      if (!ancestor) break;
      ancestorTitles.unshift(ancestor.title);
      if (!nearestNotebookResourceId && ancestor.resourceType === "notebook") {
        nearestNotebookResourceId = ancestor.resourceId;
      }
      if (ancestor.title.toLocaleLowerCase().includes(normalized)) {
        ancestorMatched = true;
      }
      cursor = ancestor.parentId;
    }

    if (!ancestorMatched) continue;
    addedIds.add(node.resourceId);

    const parentPath = ancestorTitles.join(" / ");
    matched.push({
      id: node.resourceId,
      userId: "",
      notebookId: nearestNotebookResourceId,
      workspaceId: null,
      title: node.title,
      contentText: parentPath,
      isPinned: node.isPinned ?? 0,
      isFavorite: node.isFavorite ?? 0,
      isArchived: 0,
      isTrashed: 0,
      isLocked: node.isLocked ?? 0,
      version: 0,
      createdAt: node.updatedAt || "",
      updatedAt: node.updatedAt || "",
    });
  }

  matched.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return matched;
}

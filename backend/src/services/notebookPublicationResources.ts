import type Database from "better-sqlite3";

import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";

export type PublicKnowledgeResourceType = "notebook" | "note" | "mindmap" | "sheet";

export interface PublicKnowledgeResourceSummary {
  nodeId: string;
  parentNodeId: string | null;
  resourceType: PublicKnowledgeResourceType;
  resourceId: string;
  notebookId: string | null;
  title: string;
  contentText: string;
  contentFormat: string | null;
  updatedAt: string;
  sortOrder: number;
  depth: number;
}

export interface PublicKnowledgeResourceContent extends PublicKnowledgeResourceSummary {
  content?: string;
  data?: string;
  version?: number;
}

type ResourceRow = {
  nodeId: string;
  parentNodeId: string | null;
  nodeType: string;
  rawResourceType: "notebook" | "note" | "mindmap" | "file";
  resourceId: string;
  sortOrder: number;
  depth: number;
  notebookName: string | null;
  noteTitle: string | null;
  noteContentText: string | null;
  noteContentFormat: string | null;
  noteType: string | null;
  noteUpdatedAt: string | null;
  noteLocked: number | null;
  noteTrashed: number | null;
  mindmapTitle: string | null;
  mindmapData: string | null;
  mindmapUpdatedAt: string | null;
  notebookUpdatedAt: string | null;
  nodeUpdatedAt: string;
  sheetData: string | null;
};

function mindMapText(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { root?: unknown };
    const root = parsed && typeof parsed === "object" && "root" in parsed ? parsed.root : parsed;
    const stack: unknown[] = root ? [root] : [];
    const values: string[] = [];
    let visited = 0;
    while (stack.length > 0 && visited < 20_000) {
      const current = stack.pop();
      visited += 1;
      if (!current || typeof current !== "object" || Array.isArray(current)) continue;
      const node = current as { text?: unknown; children?: unknown };
      if (typeof node.text === "string" && node.text.trim()) values.push(node.text.trim());
      if (Array.isArray(node.children)) {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          stack.push(node.children[index]);
        }
      }
    }
    return values.join("\n");
  } catch {
    return "";
  }
}

function sheetText(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as {
      columns?: Array<{ title?: unknown }>;
      cells?: Record<string, unknown>;
    };
    const values: string[] = [];
    if (Array.isArray(parsed.columns)) {
      for (const column of parsed.columns.slice(0, 200)) {
        if (typeof column?.title === "string" && column.title.trim()) values.push(column.title.trim());
      }
    }
    if (parsed.cells && typeof parsed.cells === "object" && !Array.isArray(parsed.cells)) {
      let seen = 0;
      for (const value of Object.values(parsed.cells)) {
        if (seen >= 50_000) break;
        if (value !== null && value !== undefined && String(value).trim()) values.push(String(value).trim());
        seen += 1;
      }
    }
    return values.join("\n");
  } catch {
    return "";
  }
}

function classify(row: ResourceRow): PublicKnowledgeResourceType {
  if (row.rawResourceType === "notebook") return "notebook";
  if (row.rawResourceType === "mindmap") return "mindmap";
  if (row.rawResourceType === "note" && row.noteType === "sheet") return "sheet";
  return "note";
}

function titleOf(row: ResourceRow): string {
  if (row.rawResourceType === "notebook") return row.notebookName || "未命名文件夹";
  if (row.rawResourceType === "mindmap") return row.mindmapTitle || "无标题导图";
  return row.noteTitle || "无标题笔记";
}

function updatedAtOf(row: ResourceRow): string {
  return row.noteUpdatedAt || row.mindmapUpdatedAt || row.notebookUpdatedAt || row.nodeUpdatedAt;
}

function listRows(db: Database.Database, rootNotebookId: string): ResourceRow[] {
  ensureKnowledgeTreeTables(db);
  return db.prepare(`
    WITH RECURSIVE subtree(nodeId, depth) AS (
      SELECT id, 0
      FROM knowledge_tree_nodes
      WHERE resourceType = 'notebook' AND resourceId = ? AND isDeleted = 0

      UNION ALL

      SELECT child.id, subtree.depth + 1
      FROM knowledge_tree_nodes child
      JOIN subtree ON child.parentId = subtree.nodeId
      WHERE child.isDeleted = 0
    )
    SELECT
      node.id AS nodeId,
      node.parentId AS parentNodeId,
      node.nodeType,
      node.resourceType AS rawResourceType,
      node.resourceId,
      node.sortOrder,
      subtree.depth,
      nb.name AS notebookName,
      note.title AS noteTitle,
      note.contentText AS noteContentText,
      note.contentFormat AS noteContentFormat,
      note.note_type AS noteType,
      note.updatedAt AS noteUpdatedAt,
      note.isLocked AS noteLocked,
      note.isTrashed AS noteTrashed,
      mm.title AS mindmapTitle,
      mm.data AS mindmapData,
      mm.updatedAt AS mindmapUpdatedAt,
      nb.updatedAt AS notebookUpdatedAt,
      node.updatedAt AS nodeUpdatedAt,
      sheet.data AS sheetData
    FROM subtree
    JOIN knowledge_tree_nodes node ON node.id = subtree.nodeId
    LEFT JOIN notebooks nb
      ON node.resourceType = 'notebook' AND nb.id = node.resourceId
    LEFT JOIN notes note
      ON node.resourceType = 'note' AND note.id = node.resourceId
    LEFT JOIN mindmaps mm
      ON node.resourceType = 'mindmap' AND mm.id = node.resourceId
    LEFT JOIN sheets sheet
      ON node.resourceType = 'note' AND note.note_type = 'sheet' AND sheet.noteId = node.resourceId
    WHERE node.resourceType IN ('notebook', 'note', 'mindmap')
      AND (node.resourceType <> 'notebook' OR nb.id IS NOT NULL AND nb.isDeleted = 0)
      AND (node.resourceType <> 'note' OR note.id IS NOT NULL AND note.isTrashed = 0 AND note.isLocked = 0)
      AND (node.resourceType <> 'mindmap' OR mm.id IS NOT NULL)
    ORDER BY subtree.depth ASC, node.sortOrder ASC, lower(COALESCE(note.title, mm.title, nb.name, node.resourceId)), node.id
  `).all(rootNotebookId) as ResourceRow[];
}

export function listPublishedKnowledgeResources(
  db: Database.Database,
  rootNotebookId: string,
): PublicKnowledgeResourceSummary[] {
  const rows = listRows(db, rootNotebookId);
  const byNodeId = new Map(rows.map((row) => [row.nodeId, row]));

  const nearestNotebook = (row: ResourceRow): string | null => {
    let current: ResourceRow | undefined = row;
    const visited = new Set<string>();
    while (current && !visited.has(current.nodeId)) {
      visited.add(current.nodeId);
      if (current.rawResourceType === "notebook") return current.resourceId;
      current = current.parentNodeId ? byNodeId.get(current.parentNodeId) : undefined;
    }
    return null;
  };

  return rows.map((row) => {
    const resourceType = classify(row);
    const contentText = resourceType === "mindmap"
      ? mindMapText(row.mindmapData)
      : resourceType === "sheet"
        ? sheetText(row.sheetData)
        : row.noteContentText || "";

    return {
      nodeId: row.nodeId,
      parentNodeId: row.parentNodeId,
      resourceType,
      resourceId: row.resourceId,
      notebookId: nearestNotebook(row),
      title: titleOf(row),
      contentText,
      contentFormat: resourceType === "mindmap"
        ? "mindmap"
        : resourceType === "sheet"
          ? "sheet"
          : row.noteContentFormat,
      updatedAt: updatedAtOf(row),
      sortOrder: row.sortOrder,
      depth: row.depth,
    };
  });
}

export function getPublishedKnowledgeResource(
  db: Database.Database,
  rootNotebookId: string,
  nodeId: string,
): PublicKnowledgeResourceContent | null {
  const summary = listPublishedKnowledgeResources(db, rootNotebookId)
    .find((resource) => resource.nodeId === nodeId);
  if (!summary || summary.resourceType === "notebook") return null;

  if (summary.resourceType === "mindmap") {
    const row = db.prepare("SELECT data FROM mindmaps WHERE id = ?").get(summary.resourceId) as { data: string } | undefined;
    return row ? { ...summary, data: row.data } : null;
  }
  if (summary.resourceType === "sheet") {
    const row = db.prepare("SELECT data FROM sheets WHERE noteId = ?").get(summary.resourceId) as { data: string } | undefined;
    return row ? { ...summary, data: row.data } : null;
  }

  const row = db.prepare(`
    SELECT content, version
    FROM notes
    WHERE id = ? AND isTrashed = 0 AND isLocked = 0
  `).get(summary.resourceId) as { content: string; version: number } | undefined;
  return row ? { ...summary, content: row.content, version: row.version } : null;
}

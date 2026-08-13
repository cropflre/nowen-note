import { getDb } from "../db/schema.js";
import { projectMarkdownNoteForUser } from "../lib/markdownUserContent.js";

export type KnowledgeFileScope = {
  scope: "personal" | "workspace";
  workspaceId: string | null;
};

export type KnowledgeFileListDbRow = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
  noteId: string;
  folderId: string | null;
  hash: string | null;
  noteTitle: string | null;
  notebookId: string | null;
  isTrashed: number | null;
  notebookName: string | null;
  notebookIcon: string | null;
  folderName: string | null;
};

export type KnowledgeFileListQuery = {
  scope: KnowledgeFileScope;
  userId: string;
  category: string;
  filter: string;
  mime: string;
  notebookId: string;
  noteId: string;
  folderId: string;
  q: string;
  myUploadsRef: string;
  unreferencedIds: string[];
  sort: string;
};

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function resolveOrderBy(sort: string): string {
  switch (sort.toLowerCase()) {
    case "name_asc":
      return "a.filename COLLATE NOCASE ASC";
    case "name_desc":
      return "a.filename COLLATE NOCASE DESC";
    case "size_asc":
      return "a.size ASC";
    case "size_desc":
      return "a.size DESC";
    case "created_asc":
      return "a.createdAt ASC";
    case "created_desc":
    default:
      return "a.createdAt DESC";
  }
}

export const knowledgeCapabilityGuardRepository = {
  listMarkdownExportRows(workspaceId: string): any[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT n.id, n.title, n.content, n.contentText, n.createdAt, n.updatedAt,
             n.notebookId AS notebookId,
             nb.name AS notebookName,
             n.contentFormat
      FROM notes n
      LEFT JOIN notebooks nb ON nb.id = n.notebookId
      WHERE n.workspaceId = ? AND n.isTrashed = 0
      ORDER BY nb.name, n.title
    `).all(workspaceId) as any[];
    return rows.map((row) => projectMarkdownNoteForUser(db, row));
  },

  listNoteScopes(noteIds: string[]): Array<{ id: string; workspaceId: string | null }> {
    if (noteIds.length === 0) return [];
    return getDb().prepare(`
      SELECT id, workspaceId
      FROM notes
      WHERE id IN (${placeholders(noteIds.length)}) AND isTrashed = 0
    `).all(...noteIds) as Array<{ id: string; workspaceId: string | null }>;
  },

  listWorkspaceTagLinks(workspaceId: string): Array<{ tagId: string; noteId: string }> {
    return getDb().prepare(`
      SELECT nt.tagId, nt.noteId
      FROM note_tags nt
      JOIN notes n ON n.id = nt.noteId
      WHERE n.workspaceId = ? AND n.isTrashed = 0
    `).all(workspaceId) as Array<{ tagId: string; noteId: string }>;
  },

  getAttachmentNoteId(attachmentId: string): string | null {
    const row = getDb().prepare("SELECT noteId FROM attachments WHERE id = ?")
      .get(attachmentId) as { noteId: string } | undefined;
    return row?.noteId || null;
  },

  listAttachmentStatsRows(
    workspaceId: string | null,
    userId: string,
  ): Array<{ id: string; noteId: string; mimeType: string; size: number }> {
    const db = getDb();
    return (workspaceId
      ? db.prepare(`
          SELECT a.id, a.noteId, a.mimeType, a.size
          FROM attachments a
          JOIN notes n ON n.id = a.noteId
          WHERE a.workspaceId = ?
        `).all(workspaceId)
      : db.prepare(`
          SELECT a.id, a.noteId, a.mimeType, a.size
          FROM attachments a
          JOIN notes n ON n.id = a.noteId
          WHERE a.workspaceId IS NULL AND a.userId = ?
        `).all(userId)) as Array<{ id: string; noteId: string; mimeType: string; size: number }>;
  },

  listNoteContents(scope: KnowledgeFileScope, userId: string): Array<{ content: string }> {
    const db = getDb();
    return (scope.scope === "workspace"
      ? db.prepare(`
          SELECT content
          FROM notes
          WHERE workspaceId = ? AND content IS NOT NULL AND content <> ''
        `).all(scope.workspaceId!)
      : db.prepare(`
          SELECT content
          FROM notes
          WHERE userId = ? AND workspaceId IS NULL
            AND content IS NOT NULL AND content <> ''
        `).all(userId)) as Array<{ content: string }>;
  },

  listAttachmentCandidates(
    scope: KnowledgeFileScope,
    userId: string,
  ): Array<{ id: string; createdAt: string }> {
    const db = getDb();
    return (scope.scope === "workspace"
      ? db.prepare(`
          SELECT a.id, a.createdAt
          FROM attachments a
          INNER JOIN notes n ON n.id = a.noteId
          WHERE a.workspaceId = ?
        `).all(scope.workspaceId!)
      : db.prepare(`
          SELECT a.id, a.createdAt
          FROM attachments a
          INNER JOIN notes n ON n.id = a.noteId
          WHERE a.userId = ? AND a.workspaceId IS NULL
        `).all(userId)) as Array<{ id: string; createdAt: string }>;
  },

  listFileRows(input: KnowledgeFileListQuery): KnowledgeFileListDbRow[] {
    const whereParts: string[] = [];
    const params: Array<string | number> = [];

    if (input.scope.scope === "workspace") {
      whereParts.push("a.workspaceId = ?");
      params.push(input.scope.workspaceId!);
    } else {
      whereParts.push("a.userId = ?", "a.workspaceId IS NULL");
      params.push(input.userId);
    }

    if (input.category === "image") whereParts.push("a.mimeType LIKE 'image/%'");
    if (input.category === "file") {
      whereParts.push("(a.mimeType IS NULL OR a.mimeType NOT LIKE 'image/%')");
    }
    if (input.mime) {
      whereParts.push("a.mimeType = ?");
      params.push(input.mime);
    }
    if (input.notebookId) {
      whereParts.push("n.notebookId = ?");
      params.push(input.notebookId);
    }
    if (input.q) {
      whereParts.push("a.filename LIKE ? COLLATE NOCASE");
      params.push(`%${input.q}%`);
    }
    if (input.noteId) {
      whereParts.push(
        "(a.noteId = ? OR EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id AND ar.noteId = ?))",
      );
      params.push(input.noteId, input.noteId);
    }
    if (input.folderId === "__unarchived") {
      whereParts.push("a.folderId IS NULL");
    } else if (input.folderId) {
      whereParts.push("a.folderId = ?");
      params.push(input.folderId);
    }
    if (input.filter === "unreferenced") {
      if (input.unreferencedIds.length === 0) {
        whereParts.push("1 = 0");
      } else {
        whereParts.push(`a.id IN (${placeholders(input.unreferencedIds.length)})`);
        params.push(...input.unreferencedIds);
      }
    }
    if (input.filter === "myuploads") {
      whereParts.push("a.uploadSource = ?");
      params.push("file_manager");
      if (input.myUploadsRef === "referenced") {
        whereParts.push(
          "EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id)",
        );
      } else if (input.myUploadsRef === "unreferenced") {
        whereParts.push(
          "NOT EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id)",
        );
      }
    }

    return getDb().prepare(`
      SELECT a.id, a.filename, a.mimeType, a.size, a.path, a.createdAt, a.hash,
             a.noteId, a.folderId,
             n.title AS noteTitle, n.notebookId, n.isTrashed,
             nb.name AS notebookName, nb.icon AS notebookIcon,
             af.name AS folderName
      FROM attachments a
      LEFT JOIN notes n ON n.id = a.noteId
      LEFT JOIN notebooks nb ON nb.id = n.notebookId
      LEFT JOIN attachment_folders af ON af.id = a.folderId
      WHERE ${whereParts.join(" AND ")}
      ORDER BY ${resolveOrderBy(input.sort)}
    `).all(...params) as KnowledgeFileListDbRow[];
  },

  findKnowledgeNoteNodeId(noteId: string): string | null {
    const row = getDb().prepare(`
      SELECT id
      FROM knowledge_tree_nodes
      WHERE resourceType = 'note' AND resourceId = ?
      ORDER BY isDeleted ASC, updatedAt DESC
      LIMIT 1
    `).get(noteId) as { id: string } | undefined;
    return row?.id || null;
  },

  listWorkspaceNotebooks(
    workspaceId: string,
  ): Array<{ id: string; parentId: string | null; updatedAt: string }> {
    return getDb().prepare(`
      SELECT id, parentId, updatedAt
      FROM notebooks
      WHERE workspaceId = ? AND isDeleted = 0
      ORDER BY id ASC
    `).all(workspaceId) as Array<{ id: string; parentId: string | null; updatedAt: string }>;
  },

  listWorkspaceNotes(
    workspaceId: string,
  ): Array<{ id: string; notebookId: string; updatedAt: string }> {
    return getDb().prepare(`
      SELECT id, notebookId, updatedAt
      FROM notes
      WHERE workspaceId = ? AND isTrashed = 0
      ORDER BY id ASC
    `).all(workspaceId) as Array<{ id: string; notebookId: string; updatedAt: string }>;
  },

  listWorkspaceAttachmentRows(
    workspaceId: string,
  ): Array<{ noteId: string; size: number }> {
    return getDb().prepare(`
      SELECT noteId, size
      FROM attachments
      WHERE workspaceId = ?
    `).all(workspaceId) as Array<{ noteId: string; size: number }>;
  },

  listWorkspaceAllTagLinks(workspaceId: string): Array<{ tagId: string; noteId: string }> {
    return getDb().prepare(`
      SELECT nt.tagId, nt.noteId
      FROM note_tags nt
      JOIN notes n ON n.id = nt.noteId
      WHERE n.workspaceId = ?
    `).all(workspaceId) as Array<{ tagId: string; noteId: string }>;
  },
};

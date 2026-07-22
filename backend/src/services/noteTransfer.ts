import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "../db/schema.js";
import {
  getUserWorkspaceRole,
  hasPermission,
  hasRole,
  resolveNotePermission,
  resolveNotebookPermission,
} from "../middleware/acl.js";
import { logAudit } from "./audit.js";
import {
  checkAttachmentObjectExists,
  deleteAttachmentObject,
  getUploadMonthPath,
  readAttachmentObject,
  writeAttachmentObject,
} from "./attachment-storage.js";
import { syncAttachmentReferencesForNote } from "./attachment-reference.js";
import { syncNoteLinksForNote } from "./note-links.js";
import {
  broadcastNoteDeleted,
  broadcastToUser,
  broadcastWorkspaceUpdated,
} from "./realtime.js";
import {
  rewriteAttachmentUrls,
  rewriteInternalNoteLinks,
} from "./workspaceNotebookTransfer.js";

export type NoteTransferMode = "copy" | "move";

export interface NoteTransferRequest {
  actorUserId: string;
  sourceNoteIds: string[];
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  mode: NoteTransferMode;
  includeAttachments?: boolean;
  includeTags?: boolean;
  expectedVersions?: Record<string, number>;
  actorConnectionId?: string;
}

export interface NoteTransferPreview {
  canExecute: boolean;
  mode: NoteTransferMode;
  sourceWorkspaceId: string | null;
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  noteCount: number;
  attachmentCount: number;
  attachmentBytes: number;
  missingAttachmentCount: number;
  tagCount: number;
  internalNoteLinkCount: number;
  externalNoteLinkCount: number;
  sourceVersions: Record<string, number>;
  blockers: Array<{ code: string; message: string; noteId?: string }>;
  warnings: string[];
  omitted: string[];
  notes: Array<{
    id: string;
    title: string;
    version: number;
    isLocked: boolean;
    attachmentCount: number;
  }>;
}

export interface NoteTransferResult {
  mode: NoteTransferMode;
  sourceWorkspaceId: string | null;
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  copiedNoteCount: number;
  copiedAttachmentCount: number;
  copiedTagCount: number;
  skippedAttachmentCount: number;
  movedSourceNoteCount: number;
  internalNoteLinkCount: number;
  externalNoteLinkCount: number;
  warnings: string[];
  omitted: string[];
  items: Array<{ sourceNoteId: string; targetNoteId: string; title: string }>;
}

type NoteRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  notebookId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string | null;
  isPinned: number;
  isFavorite: number;
  isLocked: number;
  isArchived: number;
  isTrashed: number;
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type NotebookRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  isDeleted: number;
};

type AttachmentRow = {
  id: string;
  noteId: string;
  userId: string;
  workspaceId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  hash: string | null;
  uploadSource: string | null;
  folderId: string | null;
};

type TagRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  color: string | null;
};

type TransferAnalysis = {
  notes: NoteRow[];
  targetNotebook: NotebookRow;
  sourceWorkspaceId: string | null;
  targetWorkspaceId: string | null;
  attachments: AttachmentRow[];
  tags: TagRow[];
  preview: NoteTransferPreview;
};

type StagedAttachment = {
  source: AttachmentRow;
  targetId: string;
  targetNoteId: string;
  targetPath: string;
};

const OMITTED_FEATURES = [
  "分享链接与公开发布配置",
  "评论与协作会话",
  "版本历史与恢复记录",
  "任务、提醒及其它业务资源",
  "笔记级 ACL 与成员权限覆写",
];

const UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const NOTE_REFERENCE_RE = new RegExp(
  `(?:note:\\/\\/|note:|\\/api\\/notes\\/|\\/notes\\/)(${UUID_RE})`,
  "gi",
);

export class NoteTransferError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "NoteTransferError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => String(id || "").trim()).filter(Boolean)));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function loadNotes(db: Database.Database, ids: string[]): NoteRow[] {
  if (ids.length === 0) return [];
  const rows = db.prepare(`
    SELECT id, userId, workspaceId, notebookId, title, content, contentText,
           contentFormat, isPinned, isFavorite, isLocked, isArchived, isTrashed,
           version, sortOrder, createdAt, updatedAt
    FROM notes
    WHERE id IN (${placeholders(ids.length)})
  `).all(...ids) as NoteRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is NoteRow => !!row);
}

function loadAttachments(db: Database.Database, noteIds: string[]): AttachmentRow[] {
  if (noteIds.length === 0) return [];
  return db.prepare(`
    SELECT id, noteId, userId, workspaceId, filename, mimeType, size, path,
           hash, uploadSource, folderId
    FROM attachments
    WHERE noteId IN (${placeholders(noteIds.length)})
    ORDER BY createdAt ASC, id ASC
  `).all(...noteIds) as AttachmentRow[];
}

function loadTags(db: Database.Database, noteIds: string[]): TagRow[] {
  if (noteIds.length === 0) return [];
  return db.prepare(`
    SELECT DISTINCT t.id, t.userId, t.workspaceId, t.name, t.color
    FROM tags t
    JOIN note_tags nt ON nt.tagId = t.id
    WHERE nt.noteId IN (${placeholders(noteIds.length)})
    ORDER BY t.name COLLATE NOCASE ASC
  `).all(...noteIds) as TagRow[];
}

function addBlocker(
  blockers: NoteTransferPreview["blockers"],
  code: string,
  message: string,
  noteId?: string,
): void {
  blockers.push({ code, message, ...(noteId ? { noteId } : {}) });
}

function validateDirection(sourceWorkspaceId: string | null, targetWorkspaceId: string | null): void {
  if (sourceWorkspaceId === targetWorkspaceId) {
    throw new NoteTransferError(
      "SAME_WORKSPACE_TRANSFER_FORBIDDEN",
      "跨空间转移仅用于个人空间与团队空间之间；同一空间请使用普通移动功能",
    );
  }
  if (sourceWorkspaceId !== null && targetWorkspaceId !== null) {
    throw new NoteTransferError(
      "TEAM_TO_TEAM_TRANSFER_UNSUPPORTED",
      "当前仅支持个人空间与团队空间之间复制或移动",
    );
  }
}

function countInternalNoteLinks(content: string, noteIdMap: Map<string, string>): number {
  if (!content) return 0;
  let count = 0;
  const re = new RegExp(NOTE_REFERENCE_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (noteIdMap.has(match[1].toLowerCase())) count += 1;
  }
  return count;
}

function analyzeStatic(input: NoteTransferRequest, db = getDb()): TransferAnalysis {
  const ids = normalizeIds(input.sourceNoteIds);
  if (ids.length === 0) throw new NoteTransferError("SOURCE_NOTES_REQUIRED", "请至少选择一篇笔记");
  if (ids.length > 100) throw new NoteTransferError("TRANSFER_BATCH_TOO_LARGE", "单次最多转移 100 篇笔记");
  if (!input.actorUserId) throw new NoteTransferError("UNAUTHENTICATED", "未登录", 401);
  if (!input.targetNotebookId) throw new NoteTransferError("TARGET_NOTEBOOK_REQUIRED", "请选择目标笔记本");
  if (input.mode !== "copy" && input.mode !== "move") {
    throw new NoteTransferError("INVALID_TRANSFER_MODE", "mode 必须是 copy 或 move");
  }
  if (input.mode === "move" && input.includeAttachments === false) {
    throw new NoteTransferError(
      "MOVE_REQUIRES_ATTACHMENTS",
      "安全移动必须复制附件；如需保留源附件，请改用复制模式",
    );
  }

  const notes = loadNotes(db, ids);
  if (notes.length !== ids.length) {
    const found = new Set(notes.map((row) => row.id));
    throw new NoteTransferError("SOURCE_NOTE_NOT_FOUND", "部分源笔记不存在", 404, {
      missing: ids.filter((id) => !found.has(id)),
    });
  }

  const workspaceSet = new Set(notes.map((note) => note.workspaceId));
  if (workspaceSet.size !== 1) {
    throw new NoteTransferError("MIXED_SOURCE_WORKSPACES", "批量转移的笔记必须来自同一个空间");
  }
  const sourceWorkspaceId = notes[0].workspaceId;
  const targetWorkspaceId = input.targetWorkspaceId || null;
  validateDirection(sourceWorkspaceId, targetWorkspaceId);

  const targetNotebook = db.prepare(
    "SELECT id, userId, workspaceId, isDeleted FROM notebooks WHERE id = ?",
  ).get(input.targetNotebookId) as NotebookRow | undefined;
  if (!targetNotebook || targetNotebook.isDeleted) {
    throw new NoteTransferError("TARGET_NOTEBOOK_NOT_FOUND", "目标笔记本不存在或已删除", 404);
  }
  if (targetNotebook.workspaceId !== targetWorkspaceId) {
    throw new NoteTransferError("TARGET_NOTEBOOK_WORKSPACE_MISMATCH", "目标笔记本不属于所选目标空间");
  }

  const blockers: NoteTransferPreview["blockers"] = [];
  const warnings: string[] = [];

  if (targetWorkspaceId === null) {
    if (targetNotebook.userId !== input.actorUserId) {
      addBlocker(blockers, "TARGET_PERSONAL_FORBIDDEN", "只能转入自己的个人空间");
    }
  } else {
    if (!hasRole(getUserWorkspaceRole(targetWorkspaceId, input.actorUserId), "editor")) {
      addBlocker(blockers, "TARGET_WORKSPACE_FORBIDDEN", "目标团队空间需要编辑者或更高权限");
    }
    const targetPermission = resolveNotebookPermission(targetNotebook.id, input.actorUserId).permission;
    if (!hasPermission(targetPermission, "write")) {
      addBlocker(blockers, "TARGET_NOTEBOOK_FORBIDDEN", "无权写入目标笔记本");
    }
  }

  for (const note of notes) {
    if (note.isTrashed) {
      addBlocker(blockers, "SOURCE_NOTE_TRASHED", "回收站中的笔记不能跨空间转移", note.id);
      continue;
    }
    const permission = resolveNotePermission(note.id, input.actorUserId).permission;
    if (!hasPermission(permission, "manage")) {
      addBlocker(blockers, "SOURCE_NOTE_FORBIDDEN", "需要源笔记的管理权限", note.id);
    }
    if (sourceWorkspaceId === null && note.userId !== input.actorUserId) {
      addBlocker(blockers, "SOURCE_PERSONAL_FORBIDDEN", "只能转移自己个人空间中的笔记", note.id);
    }
    if (input.mode === "move" && note.isLocked) {
      addBlocker(blockers, "SOURCE_NOTE_LOCKED", "锁定笔记不能移动，请先解锁", note.id);
    }
    const expectedVersion = input.expectedVersions?.[note.id];
    if (typeof expectedVersion === "number" && expectedVersion !== note.version) {
      addBlocker(blockers, "SOURCE_VERSION_CONFLICT", "源笔记已更新，请重新预检", note.id);
    }
  }

  if (sourceWorkspaceId !== null) {
    const sourceRole = getUserWorkspaceRole(sourceWorkspaceId, input.actorUserId);
    if (!hasRole(sourceRole, "admin")) {
      const allManage = notes.every((note) =>
        hasPermission(resolveNotePermission(note.id, input.actorUserId).permission, "manage"),
      );
      if (!allManage) {
        addBlocker(
          blockers,
          "SOURCE_TEAM_MANAGE_REQUIRED",
          "团队空间转出需要空间所有者/管理员或源目录管理权限",
        );
      }
    }
  }

  const attachments = loadAttachments(db, ids);
  if (input.includeAttachments === false && attachments.length > 0) {
    warnings.push(`未选择复制附件，${attachments.length} 个附件引用可能在目标空间不可用`);
  }
  const tags = input.includeTags === false ? [] : loadTags(db, ids);
  const noteIdMap = new Map(ids.map((id) => [id.toLowerCase(), crypto.randomUUID()]));
  let internalNoteLinkCount = 0;
  let externalNoteLinkCount = 0;
  for (const note of notes) {
    internalNoteLinkCount += countInternalNoteLinks(note.content || "", noteIdMap);
    externalNoteLinkCount += rewriteInternalNoteLinks(note.content || "", noteIdMap).externalNoteLinkCount;
  }
  if (externalNoteLinkCount > 0) {
    warnings.push(`检测到 ${externalNoteLinkCount} 个指向本批次外笔记的链接，目标中将保留原链接`);
  }
  warnings.push("分享、评论、历史版本、ACL、任务和提醒不会随笔记转移");

  const attachmentCounts = new Map<string, number>();
  for (const attachment of attachments) {
    attachmentCounts.set(attachment.noteId, (attachmentCounts.get(attachment.noteId) || 0) + 1);
  }

  return {
    notes,
    targetNotebook,
    sourceWorkspaceId,
    targetWorkspaceId,
    attachments,
    tags,
    preview: {
      canExecute: blockers.length === 0,
      mode: input.mode,
      sourceWorkspaceId,
      targetWorkspaceId,
      targetNotebookId: targetNotebook.id,
      noteCount: notes.length,
      attachmentCount: input.includeAttachments === false ? 0 : attachments.length,
      attachmentBytes: input.includeAttachments === false
        ? 0
        : attachments.reduce((sum, row) => sum + Math.max(0, Number(row.size) || 0), 0),
      missingAttachmentCount: 0,
      tagCount: tags.length,
      internalNoteLinkCount,
      externalNoteLinkCount,
      sourceVersions: Object.fromEntries(notes.map((note) => [note.id, note.version])),
      blockers,
      warnings,
      omitted: OMITTED_FEATURES,
      notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        version: note.version,
        isLocked: !!note.isLocked,
        attachmentCount: attachmentCounts.get(note.id) || 0,
      })),
    },
  };
}

async function analyzeTransfer(input: NoteTransferRequest, db = getDb()): Promise<TransferAnalysis> {
  const analysis = analyzeStatic(input, db);
  if (input.includeAttachments === false || analysis.attachments.length === 0) return analysis;

  const checks = await Promise.all(
    analysis.attachments.map(async (attachment) => ({
      attachment,
      result: await checkAttachmentObjectExists(attachment.path),
    })),
  );
  const missing = checks.filter(({ result }) => !result.exists);
  analysis.preview.missingAttachmentCount = missing.length;

  if (missing.length > 0) {
    if (input.mode === "move") {
      addBlocker(
        analysis.preview.blockers,
        "ATTACHMENT_FILE_MISSING",
        `有 ${missing.length} 个附件文件缺失或不可读取；为避免数据丢失，移动已阻止`,
      );
    } else {
      analysis.preview.warnings.unshift(
        `有 ${missing.length} 个附件文件缺失或不可读取，复制时将跳过并在结果中报告`,
      );
    }
  }
  analysis.preview.canExecute = analysis.preview.blockers.length === 0;
  return analysis;
}

function blockerStatus(code: string): number {
  if (
    code === "SOURCE_VERSION_CONFLICT" ||
    code === "SOURCE_NOTE_LOCKED" ||
    code === "ATTACHMENT_FILE_MISSING" ||
    code === "SOURCE_ATTACHMENTS_CHANGED"
  ) return 409;
  if (code.endsWith("FORBIDDEN") || code.endsWith("REQUIRED")) return 403;
  return 400;
}

function assertExecutable(analysis: TransferAnalysis): void {
  if (analysis.preview.blockers.length === 0) return;
  const first = analysis.preview.blockers[0];
  throw new NoteTransferError(first.code, first.message, blockerStatus(first.code), {
    blockers: analysis.preview.blockers,
  });
}

function nextSortOrder(db: Database.Database, notebookId: string): number {
  const row = db.prepare(
    "SELECT COALESCE(MAX(sortOrder), -1) AS maxOrder FROM notes WHERE notebookId = ?",
  ).get(notebookId) as { maxOrder: number };
  return Number(row?.maxOrder ?? -1) + 1;
}

function targetAttachmentPath(source: AttachmentRow, targetId: string): string {
  const rawExtension = source.path.split("?")[0].match(/\.[a-zA-Z0-9]{1,12}$/)?.[0]
    || source.filename.match(/\.[a-zA-Z0-9]{1,12}$/)?.[0]
    || ".bin";
  const extension = rawExtension.replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
  return `${getUploadMonthPath()}/${targetId}${extension}`;
}

function attachmentSignature(rows: AttachmentRow[]): string {
  return rows
    .map((row) => `${row.id}:${row.noteId}:${row.path}:${row.size}:${row.hash || ""}`)
    .sort()
    .join("\n");
}

function targetTagFor(
  db: Database.Database,
  source: TagRow,
  actorUserId: string,
  targetWorkspaceId: string | null,
): { id: string; created: boolean } {
  const exact = targetWorkspaceId === null
    ? db.prepare("SELECT id FROM tags WHERE userId = ? AND workspaceId IS NULL AND name = ? COLLATE NOCASE").get(actorUserId, source.name)
    : db.prepare("SELECT id FROM tags WHERE userId = ? AND workspaceId = ? AND name = ? COLLATE NOCASE").get(actorUserId, targetWorkspaceId, source.name);
  if (exact && typeof (exact as any).id === "string") return { id: (exact as any).id, created: false };

  // SQLite 旧结构仍有 UNIQUE(userId, name)，同名标签只能在该用户范围内复用。
  const legacy = db.prepare("SELECT id FROM tags WHERE userId = ? AND name = ? COLLATE NOCASE").get(actorUserId, source.name) as { id: string } | undefined;
  if (legacy) return { id: legacy.id, created: false };

  const id = crypto.randomUUID();
  db.prepare("INSERT INTO tags (id, userId, workspaceId, name, color) VALUES (?, ?, ?, ?, ?)")
    .run(id, actorUserId, targetWorkspaceId, source.name, source.color || "#58a6ff");
  return { id, created: true };
}

function noteTagIds(db: Database.Database, noteId: string): string[] {
  return (db.prepare("SELECT tagId FROM note_tags WHERE noteId = ?").all(noteId) as Array<{ tagId: string }>)
    .map((row) => row.tagId);
}

async function cleanupStagedAttachments(staged: StagedAttachment[]): Promise<void> {
  await Promise.allSettled(staged.map((item) => deleteAttachmentObject(item.targetPath)));
}

function safeBroadcast(action: () => void): void {
  try { action(); } catch (error) {
    console.warn("[note-transfer] realtime broadcast failed", error);
  }
}

export async function previewNoteTransfer(input: NoteTransferRequest): Promise<NoteTransferPreview> {
  return (await analyzeTransfer(input)).preview;
}

export async function executeNoteTransfer(input: NoteTransferRequest): Promise<NoteTransferResult> {
  const db = getDb();
  const initial = await analyzeTransfer(input, db);
  assertExecutable(initial);

  const expectedVersions = input.expectedVersions || initial.preview.sourceVersions;
  const guardedInput: NoteTransferRequest = { ...input, expectedVersions };
  const noteIdMap = new Map<string, string>();
  for (const note of initial.notes) noteIdMap.set(note.id.toLowerCase(), crypto.randomUUID());

  const staged: StagedAttachment[] = [];
  let skippedAttachmentCount = 0;

  try {
    if (input.includeAttachments !== false) {
      for (const source of initial.attachments) {
        const buffer = await readAttachmentObject(source.path);
        if (!buffer) {
          if (input.mode === "move") {
            throw new NoteTransferError(
              "ATTACHMENT_FILE_MISSING",
              `附件文件缺失或不可读取：${source.filename}`,
              409,
              { attachmentId: source.id },
            );
          }
          skippedAttachmentCount += 1;
          continue;
        }

        const targetId = crypto.randomUUID();
        const targetPath = targetAttachmentPath(source, targetId);
        await writeAttachmentObject(targetPath, buffer, source.mimeType);
        const verified = await checkAttachmentObjectExists(targetPath);
        if (!verified.exists) {
          throw new NoteTransferError(
            "TARGET_ATTACHMENT_VERIFY_FAILED",
            `目标附件写入后校验失败：${source.filename}`,
            500,
            { attachmentId: source.id, targetPath },
          );
        }
        staged.push({
          source,
          targetId,
          targetNoteId: noteIdMap.get(source.noteId.toLowerCase())!,
          targetPath,
        });
      }
    }

    const revalidated = analyzeStatic(guardedInput, db);
    assertExecutable(revalidated);
    if (attachmentSignature(revalidated.attachments) !== attachmentSignature(initial.attachments)) {
      throw new NoteTransferError(
        "SOURCE_ATTACHMENTS_CHANGED",
        "源笔记的附件在转移期间发生变化，请重新预检",
        409,
      );
    }

    const result = db.transaction(() => {
      let copiedTagCount = 0;
      let sortOrder = nextSortOrder(db, revalidated.targetNotebook.id);
      const attachmentIdMap = new Map<string, string>();
      for (const item of staged) attachmentIdMap.set(item.source.id.toLowerCase(), item.targetId);

      for (const note of revalidated.notes) {
        const newId = noteIdMap.get(note.id.toLowerCase())!;
        db.prepare(`
          INSERT INTO notes (
            id, userId, workspaceId, notebookId, title, content, contentText, contentFormat,
            isPinned, isFavorite, isLocked, isArchived, isTrashed, trashedAt,
            version, sortOrder, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, 1, ?, ?, datetime('now'))
        `).run(
          newId,
          input.actorUserId,
          revalidated.targetWorkspaceId,
          revalidated.targetNotebook.id,
          note.title,
          note.content || "{}",
          note.contentText || "",
          note.contentFormat || "tiptap",
          note.isPinned ? 1 : 0,
          sortOrder++,
          note.createdAt,
        );
      }

      for (const item of staged) {
        db.prepare(`
          INSERT INTO attachments (
            id, noteId, userId, workspaceId, filename, mimeType, size, path,
            hash, uploadSource, folderId
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          item.targetId,
          item.targetNoteId,
          input.actorUserId,
          revalidated.targetWorkspaceId,
          item.source.filename,
          item.source.mimeType,
          item.source.size,
          item.targetPath,
          item.source.hash,
          "note-transfer",
        );
      }

      for (const note of revalidated.notes) {
        const newId = noteIdMap.get(note.id.toLowerCase())!;
        const linked = rewriteInternalNoteLinks(note.content || "", noteIdMap);
        const rewrittenContent = rewriteAttachmentUrls(linked.content, attachmentIdMap);
        db.prepare("UPDATE notes SET content = ? WHERE id = ?").run(rewrittenContent, newId);

        if (input.includeTags !== false) {
          for (const sourceTagId of noteTagIds(db, note.id)) {
            const sourceTag = revalidated.tags.find((tag) => tag.id === sourceTagId);
            if (!sourceTag) continue;
            const target = targetTagFor(db, sourceTag, input.actorUserId, revalidated.targetWorkspaceId);
            db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)").run(newId, target.id);
            if (target.created) copiedTagCount += 1;
          }
        }

        syncAttachmentReferencesForNote(newId, rewrittenContent);
        syncNoteLinksForNote(newId, rewrittenContent);
      }

      const targetNoteIds = Array.from(noteIdMap.values());
      if (loadNotes(db, targetNoteIds).length !== revalidated.notes.length) {
        throw new NoteTransferError("TARGET_VERIFY_FAILED", "目标笔记校验失败，操作已回滚", 500);
      }
      const actualAttachmentCount = targetNoteIds.length === 0
        ? 0
        : (db.prepare(`
            SELECT COUNT(*) AS count FROM attachments
            WHERE noteId IN (${placeholders(targetNoteIds.length)})
          `).get(...targetNoteIds) as { count: number }).count;
      if (actualAttachmentCount !== staged.length) {
        throw new NoteTransferError("TARGET_ATTACHMENT_VERIFY_FAILED", "目标附件元数据校验失败，操作已回滚", 500);
      }

      if (input.mode === "move") {
        for (const note of revalidated.notes) {
          const expected = expectedVersions[note.id];
          const update = db.prepare(`
            UPDATE notes
            SET isTrashed = 1,
                trashedAt = datetime('now'),
                updatedAt = datetime('now'),
                version = version + 1
            WHERE id = ? AND version = ? AND isLocked = 0 AND isTrashed = 0
          `).run(note.id, expected);
          if (update.changes !== 1) {
            throw new NoteTransferError(
              "SOURCE_VERSION_CONFLICT",
              "源笔记已更新、锁定或删除，请重新预检",
              409,
              { noteId: note.id },
            );
          }
        }
      }

      const items = revalidated.notes.map((note) => ({
        sourceNoteId: note.id,
        targetNoteId: noteIdMap.get(note.id.toLowerCase())!,
        title: note.title,
      }));

      logAudit(input.actorUserId, "note_transfer", `note.transfer_${input.mode}`, {
        sourceWorkspaceId: revalidated.sourceWorkspaceId,
        targetWorkspaceId: revalidated.targetWorkspaceId,
        targetNotebookId: revalidated.targetNotebook.id,
        sourceNoteIds: revalidated.notes.map((note) => note.id),
        targetNoteIds: items.map((item) => item.targetNoteId),
        copiedAttachmentCount: staged.length,
        copiedTagCount,
        skippedAttachmentCount,
        internalNoteLinkCount: revalidated.preview.internalNoteLinkCount,
        externalNoteLinkCount: revalidated.preview.externalNoteLinkCount,
      });

      return {
        mode: input.mode,
        sourceWorkspaceId: revalidated.sourceWorkspaceId,
        targetWorkspaceId: revalidated.targetWorkspaceId,
        targetNotebookId: revalidated.targetNotebook.id,
        copiedNoteCount: items.length,
        copiedAttachmentCount: staged.length,
        copiedTagCount,
        skippedAttachmentCount,
        movedSourceNoteCount: input.mode === "move" ? items.length : 0,
        internalNoteLinkCount: revalidated.preview.internalNoteLinkCount,
        externalNoteLinkCount: revalidated.preview.externalNoteLinkCount,
        warnings: [
          ...revalidated.preview.warnings,
          ...(skippedAttachmentCount > 0
            ? [`${skippedAttachmentCount} 个缺失附件已跳过，目标笔记中的对应旧引用被保留`]
            : []),
        ],
        omitted: OMITTED_FEATURES,
        items,
      } satisfies NoteTransferResult;
    })();

    for (const item of result.items) {
      safeBroadcast(() => broadcastToUser(input.actorUserId, {
        type: "workspace:updated",
        workspaceId: result.targetWorkspaceId || "personal",
        kind: "note:created",
        noteId: item.targetNoteId,
        sourceNoteId: item.sourceNoteId,
      } as any));
      if (input.mode === "move") {
        safeBroadcast(() => broadcastNoteDeleted(
          item.sourceNoteId,
          { actorUserId: input.actorUserId, trashed: true },
          input.actorConnectionId,
        ));
      }
    }
    if (result.targetWorkspaceId) {
      safeBroadcast(() => broadcastWorkspaceUpdated(result.targetWorkspaceId!, {
        kind: "note:created",
        noteIds: result.items.map((item) => item.targetNoteId),
        transferMode: result.mode,
      }));
    }
    if (result.sourceWorkspaceId && input.mode === "move") {
      safeBroadcast(() => broadcastWorkspaceUpdated(result.sourceWorkspaceId!, {
        kind: "note:deleted",
        noteIds: result.items.map((item) => item.sourceNoteId),
        trashed: true,
      }));
    }
    return result;
  } catch (error) {
    await cleanupStagedAttachments(staged);
    throw error;
  }
}

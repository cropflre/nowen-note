import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { hasPermission, resolveNotePermission } from "../middleware/acl";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import { rebuildBlockAuthorityStore } from "../lib/blockAuthorityStore";
import { replaceRemoteImages } from "../lib/remote-image-localization";
import { syncNoteBlocks } from "../lib/noteBlocks";
import { syncNoteLinks } from "../lib/noteLinks";
import { noteVersionsRepository } from "../repositories";
import { deleteAttachmentObject } from "./attachment-storage";
import { logAudit } from "./audit";
import {
  saveDownloadedRemoteImageForNote,
  type DownloadedRemoteImage,
  type ImportedRemoteImage,
} from "./remote-image-import";
import { broadcastNoteUpdated, broadcastToUser, broadcastYjsUpdate } from "./realtime";
import type { NoteRow } from "./remote-image-localization-core";
import { nowIso, readNote } from "./remote-image-localization-core";
import { rebuildYjsSubdocumentsIfEnabled } from "./yjs-subdocuments";
import { yFlush, yReplaceContentAsUpdate } from "./yjs";

export interface CreatedAttachment {
  id: string;
  path: string;
  createdPhysicalObject: boolean;
}

class WholeNoteMutationConflict extends Error {}

export function currentWriteState(userId: string, noteId: string, version: number, content: string): {
  note: NoteRow;
  workspaceId: string | null;
} | null {
  try { yFlush(noteId); } catch {}
  const note = readNote(noteId);
  if (!note || note.version !== version || note.content !== content || note.isLocked || note.isTrashed) return null;
  const permission = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission.permission, "write")) return null;
  return { note, workspaceId: permission.workspaceId || null };
}

function commitWholeNoteContent(args: {
  userId: string;
  noteId: string;
  expectedVersion: number;
  expectedContent: string;
  nextContent: string;
  contentFormat: string;
  replacedCount: number;
}): { final: NoteRow; warnings: string[] } | null {
  if (!currentWriteState(args.userId, args.noteId, args.expectedVersion, args.expectedContent)) return null;
  const db = getDb();
  let committedContent = args.nextContent;
  let committedText = "";
  const finalVersion = args.expectedVersion + 1;

  const tx = db.transaction(() => {
    const current = readNote(args.noteId);
    const permission = resolveNotePermission(args.noteId, args.userId);
    if (
      !current
      || current.version !== args.expectedVersion
      || current.content !== args.expectedContent
      || current.isLocked
      || current.isTrashed
      || !hasPermission(permission.permission, "write")
    ) {
      throw new WholeNoteMutationConflict("note changed before commit");
    }

    const synced = syncNoteBlocks(db, current.id, args.nextContent, args.contentFormat);
    committedContent = synced.content;
    committedText = synced.contentText;

    noteVersionsRepository.create({
      id: uuid(),
      noteId: current.id,
      userId: args.userId,
      title: current.title,
      content: current.content,
      contentText: current.contentText,
      contentFormat: current.contentFormat,
      version: current.version,
      changeType: "edit",
      changeSummary: "本地化网络图片",
    });

    const updated = db.prepare(`
      UPDATE notes
         SET content = ?, contentText = ?, version = version + 1, updatedAt = datetime('now')
       WHERE id = ? AND version = ? AND content = ?
    `).run(committedContent, committedText, current.id, args.expectedVersion, args.expectedContent);
    if (Number(updated.changes || 0) !== 1) throw new WholeNoteMutationConflict("optimistic update failed");

    syncAttachmentReferences(db, current.id, committedContent);
    syncNoteLinks(db, args.userId, current.id, committedContent);
    if (["tiptap-json", "markdown"].includes(args.contentFormat)) {
      rebuildBlockAuthorityStore(db, current.id, committedContent, args.contentFormat, {
        noteVersion: finalVersion,
        operationType: "whole-save",
      });
      rebuildYjsSubdocumentsIfEnabled(db, current.id, committedContent, args.contentFormat);
    }
  });

  try {
    tx();
  } catch (error) {
    if (error instanceof WholeNoteMutationConflict) return null;
    throw error;
  }

  const warnings: string[] = [];
  if (args.contentFormat === "markdown") {
    try {
      const yjs = yReplaceContentAsUpdate(args.noteId, committedContent, args.userId || null);
      if (yjs) broadcastYjsUpdate(args.noteId, yjs.updateBase64);
    } catch (error) {
      warnings.push(`Yjs 同步失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const final = readNote(args.noteId);
  if (!final) throw new Error("本地化写回后无法读取笔记");
  try {
    broadcastNoteUpdated(final.id, {
      version: final.version,
      updatedAt: final.updatedAt || nowIso(),
      title: final.title,
      contentText: final.contentText,
      actorUserId: args.userId,
    });
    broadcastToUser(args.userId, {
      type: "note:list-updated" as any,
      note: {
        id: final.id,
        title: final.title,
        contentText: final.contentText,
        updatedAt: final.updatedAt || nowIso(),
        version: final.version,
        isPinned: final.isPinned,
        isTrashed: final.isTrashed,
        notebookId: final.notebookId,
        workspaceId: final.workspaceId,
      },
      actorUserId: args.userId,
      actorConnectionId: null,
    } as any);
  } catch (error) {
    warnings.push(`实时通知失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    logAudit(
      args.userId,
      "note",
      "update",
      { noteId: final.id, localizedRemoteImages: args.replacedCount },
      { targetType: "note", targetId: final.id },
    );
  } catch {
    // Audit is post-commit best effort.
  }
  return { final, warnings };
}

export function applyLocalizedContent(args: {
  userId: string;
  noteId: string;
  scannedVersion: number;
  scannedContent: string;
  contentFormat: string;
  replacements: ReadonlyMap<string, string>;
}): { updated: boolean; conflict: boolean; replacedCount: number; finalVersion?: number; warnings: string[] } {
  const state = currentWriteState(args.userId, args.noteId, args.scannedVersion, args.scannedContent);
  if (!state) return { updated: false, conflict: true, replacedCount: 0, warnings: [] };
  const replacement = replaceRemoteImages(state.note.content || "", args.contentFormat, args.replacements);
  if (replacement.parseError) throw new Error(replacement.parseError);
  if (!replacement.changed) {
    return { updated: false, conflict: false, replacedCount: 0, finalVersion: state.note.version, warnings: [] };
  }
  const committed = commitWholeNoteContent({
    userId: args.userId,
    noteId: args.noteId,
    expectedVersion: args.scannedVersion,
    expectedContent: args.scannedContent,
    nextContent: replacement.content,
    contentFormat: args.contentFormat,
    replacedCount: replacement.replacedCount,
  });
  if (!committed) return { updated: false, conflict: true, replacedCount: 0, warnings: [] };
  return {
    updated: true,
    conflict: false,
    replacedCount: replacement.replacedCount,
    finalVersion: committed.final.version,
    warnings: committed.warnings,
  };
}

export async function saveLocalizedAttachment(args: {
  jobId: string;
  userId: string;
  noteId: string;
  workspaceId: string | null;
  sourceUrl: string;
  downloaded: DownloadedRemoteImage;
}): Promise<{ imported: ImportedRemoteImage; created: CreatedAttachment | null }> {
  const db = getDb();
  const hash = crypto.createHash("sha256").update(args.downloaded.buffer).digest("hex");
  const existingScopeRows = db.prepare(
    args.workspaceId
      ? "SELECT id, noteId, path FROM attachments WHERE userId = ? AND workspaceId = ? AND hash = ?"
      : "SELECT id, noteId, path FROM attachments WHERE userId = ? AND workspaceId IS NULL AND hash = ?",
  ).all(...(args.workspaceId ? [args.userId, args.workspaceId, hash] : [args.userId, hash])) as Array<{
    id: string;
    noteId: string;
    path: string;
  }>;
  const uploadSource = `historical-localization:${args.jobId}`.slice(0, 64);
  const imported = await saveDownloadedRemoteImageForNote({
    downloaded: args.downloaded,
    sourceUrl: args.sourceUrl,
    noteId: args.noteId,
    userId: args.userId,
    workspaceId: args.workspaceId,
    uploadSource,
  });
  const row = db.prepare("SELECT path, uploadSource FROM attachments WHERE id = ?")
    .get(imported.id) as { path: string; uploadSource: string | null } | undefined;
  return {
    imported,
    created: row?.uploadSource === uploadSource
      ? { id: imported.id, path: row.path, createdPhysicalObject: existingScopeRows.length === 0 }
      : null,
  };
}

export async function rollbackLocalizedAttachments(created: CreatedAttachment[]): Promise<void> {
  if (!created.length) return;
  const db = getDb();
  const unique = [...new Map(created.map((item) => [item.id, item])).values()];
  const physicalPaths = new Set<string>();
  try {
    db.transaction(() => {
      for (const item of unique) {
        const deleted = db.prepare("DELETE FROM attachments WHERE id = ?").run(item.id);
        if (Number(deleted.changes || 0) > 0 && item.createdPhysicalObject) physicalPaths.add(item.path);
      }
    })();
  } catch (error) {
    console.warn("[remote-image-localization] rollback attachment rows failed:", error);
    return;
  }
  for (const storagePath of physicalPaths) {
    const remaining = db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE path = ?")
      .get(storagePath) as { count: number };
    if (Number(remaining.count || 0) > 0) continue;
    try {
      await deleteAttachmentObject(storagePath);
    } catch (error) {
      console.warn("[remote-image-localization] rollback attachment object failed:", storagePath, error);
    }
  }
}

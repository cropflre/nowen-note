import { createHash } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";

import { extractAttachmentIdsFromContent } from "../lib/attachmentRefs.js";
import { hasPermission, resolveNotePermission } from "../middleware/acl.js";
import {
  deleteAttachmentObject,
  getUploadMonthPath,
  readAttachmentObject,
  writeAttachmentObject,
} from "./attachment-storage.js";

interface StoredAttachmentObject {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  hash: string | null;
}

interface SourceNoteAttachment extends StoredAttachmentObject {
  noteId: string;
}

export interface CopiedAttachmentObject {
  id: string;
  sourceId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  hash: string;
}

export class NoteAttachmentCopyError extends Error {
  constructor(
    public readonly code: "ATTACHMENT_UNAVAILABLE" | "ATTACHMENT_FORBIDDEN" | "ATTACHMENT_MISSING",
    public readonly status: 403 | 409,
    message: string,
  ) {
    super(message);
    this.name = "NoteAttachmentCopyError";
  }
}

function extensionFor(filename: string, storagePath: string): string {
  const candidate = path.extname(filename || storagePath).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(candidate) ? candidate : "";
}

function newStoragePath(filename: string, sourcePath: string): string {
  return `${getUploadMonthPath()}/${uuid()}${extensionFor(filename, sourcePath)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rewriteSourceAttachmentUrl(content: string, sourceId: string, targetUrl: string): string {
  if (!content || !sourceId || !targetUrl) return content || "";
  const attachmentPath = `/api/attachments/${escapeRegExp(sourceId)}`;
  const pattern = new RegExp(
    `(?:https?:\\/\\/[^/\\s"'<>]+)?${attachmentPath}(?:\\?[^\\s"'<>)]*)?`,
    "gi",
  );
  return content.replace(pattern, targetUrl);
}

export async function cleanupCopiedAttachmentObjects(
  copied: Iterable<Pick<CopiedAttachmentObject, "path">>,
): Promise<void> {
  const paths = Array.from(new Set(Array.from(copied, (item) => item.path).filter(Boolean)));
  await Promise.allSettled(paths.map((item) => deleteAttachmentObject(item)));
}

export async function copyStoredAttachmentObjects(
  sources: readonly StoredAttachmentObject[],
): Promise<CopiedAttachmentObject[]> {
  const copied: CopiedAttachmentObject[] = [];
  try {
    for (const source of sources) {
      const buffer = await readAttachmentObject(source.path);
      if (!buffer) {
        throw new NoteAttachmentCopyError(
          "ATTACHMENT_MISSING",
          409,
          `附件“${source.filename}”的物理文件不存在，无法复制`,
        );
      }
      const id = uuid();
      const storagePath = newStoragePath(source.filename, source.path);
      const copiedObject: CopiedAttachmentObject = {
        id,
        sourceId: source.id,
        filename: source.filename,
        mimeType: source.mimeType,
        size: buffer.byteLength,
        path: storagePath,
        hash: source.hash || createHash("sha256").update(buffer).digest("hex"),
      };
      copied.push(copiedObject);
      await writeAttachmentObject(storagePath, buffer, source.mimeType);
    }
    return copied;
  } catch (error) {
    await cleanupCopiedAttachmentObjects(copied);
    throw error;
  }
}

export async function copyReferencedNoteAttachments(input: {
  db: Database.Database;
  userId: string;
  noteId: string;
  content: string;
  contentText?: string;
}): Promise<CopiedAttachmentObject[]> {
  const ids = new Set([
    ...extractAttachmentIdsFromContent(input.content),
    ...extractAttachmentIdsFromContent(input.contentText || ""),
  ]);
  const sources: SourceNoteAttachment[] = [];

  for (const sourceId of ids) {
    const source = input.db.prepare(`
      SELECT id, noteId, filename, mimeType, size, path, hash
      FROM attachments WHERE id = ?
    `).get(sourceId) as SourceNoteAttachment | undefined;
    if (!source) {
      throw new NoteAttachmentCopyError(
        "ATTACHMENT_UNAVAILABLE",
        409,
        `正文引用的附件 ${sourceId} 不存在，无法复制`,
      );
    }
    if (source.noteId !== input.noteId) {
      const { permission } = resolveNotePermission(source.noteId, input.userId);
      if (!hasPermission(permission, "read")) {
        throw new NoteAttachmentCopyError(
          "ATTACHMENT_FORBIDDEN",
          403,
          `无权复制正文引用的附件“${source.filename}”`,
        );
      }
    }
    sources.push(source);
  }

  return copyStoredAttachmentObjects(sources);
}

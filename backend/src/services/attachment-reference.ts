import { getDb } from "../db/schema.js";
import { syncReferences, syncReferencesAsync } from "../lib/attachmentRefs.js";
import { attachmentReferencesRepository } from "../repositories/index.js";
import { rewriteAttachmentUrls, rewriteInternalNoteLinks } from "./workspaceNotebookTransfer.js";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ATTACHMENT_RE = new RegExp(`\\/api\\/attachments\\/(${UUID})`, "gi");
const NOTE_RE = new RegExp(`(?:note:\\/\\/|note:|\\/api\\/notes\\/|\\/notes\\/)(${UUID})`, "gi");

function collectIds(value: string, pattern: RegExp): string[] {
  const ids: string[] = [];
  const expression = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = expression.exec(value)) !== null) ids.push(match[1].toLowerCase());
  return ids;
}

function positionalMap(before: string[], after: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (before.length !== after.length) return map;
  for (let index = 0; index < before.length; index += 1) {
    map.set(before[index], after[index]);
  }
  return map;
}

function rewriteContentText(contentText: string | null, normalizedContent: string): string | null {
  if (!contentText) return contentText;
  const attachmentMap = positionalMap(
    collectIds(contentText, ATTACHMENT_RE),
    collectIds(normalizedContent, ATTACHMENT_RE),
  );
  const noteMap = positionalMap(
    collectIds(contentText, NOTE_RE),
    collectIds(normalizedContent, NOTE_RE),
  );
  const noteRewritten = rewriteInternalNoteLinks(contentText, noteMap).content;
  return rewriteAttachmentUrls(noteRewritten, attachmentMap);
}

/**
 * SQLite compatibility path used inside the existing note-transfer transaction.
 * This remains synchronous until the whole note-transfer transaction is migrated.
 */
export function syncAttachmentReferencesForNote(
  noteId: string,
  content: string | null | undefined,
): { added: number; removed: number } {
  const db = getDb();
  const normalizedContent = content || "";
  const row = db.prepare('SELECT "contentText" FROM notes WHERE id = ?').get(noteId) as
    | { contentText: string | null }
    | undefined;
  const nextContentText = rewriteContentText(row?.contentText ?? null, normalizedContent);
  if (nextContentText !== null && nextContentText !== row?.contentText) {
    db.prepare('UPDATE notes SET "contentText" = ? WHERE id = ?').run(nextContentText, noteId);
  }
  return syncReferences(db, noteId, normalizedContent);
}

/**
 * Runtime Adapter path for PostgreSQL-capable callers.
 */
export async function syncAttachmentReferencesForNoteAsync(
  noteId: string,
  content: string | null | undefined,
): Promise<{ added: number; removed: number }> {
  const normalizedContent = content || "";
  const currentContentText = await attachmentReferencesRepository.getNoteContentTextAsync(noteId);
  const nextContentText = rewriteContentText(currentContentText, normalizedContent);
  if (nextContentText !== null && nextContentText !== currentContentText) {
    await attachmentReferencesRepository.updateNoteContentTextAsync(noteId, nextContentText);
  }
  return syncReferencesAsync(noteId, normalizedContent);
}

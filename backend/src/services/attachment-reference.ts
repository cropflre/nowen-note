import { getDb } from "../db/schema.js";
import { syncReferences } from "../lib/attachmentRefs.js";
import { rewriteAttachmentUrls, rewriteInternalNoteLinks } from "./workspaceNotebookTransfer.js";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ATTACHMENT_RE = new RegExp(`\\/api\\/attachments\\/(${UUID})`, "gi");
const NOTE_RE = new RegExp(`(?:note:\\/\\/|note:|\\/api\\/notes\\/|\\/notes\\/)(${UUID})`, "gi");

function collectIds(value: string, pattern: RegExp): string[] {
  const ids: string[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) ids.push(match[1].toLowerCase());
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

/**
 * Keep attachment indexes and the derived contentText representation aligned inside the
 * caller's SQLite transaction. The transfer service rewrites structured content first; when
 * contentText contains the same ordered references, this compatibility step applies the same
 * note/attachment ID mapping without attempting to parse or regenerate user text.
 */
export function syncAttachmentReferencesForNote(
  noteId: string,
  content: string | null | undefined,
): { added: number; removed: number } {
  const db = getDb();
  const normalizedContent = content || "";
  const row = db.prepare("SELECT contentText FROM notes WHERE id = ?").get(noteId) as
    | { contentText: string | null }
    | undefined;

  if (row?.contentText) {
    const attachmentMap = positionalMap(
      collectIds(row.contentText, ATTACHMENT_RE),
      collectIds(normalizedContent, ATTACHMENT_RE),
    );
    const noteMap = positionalMap(
      collectIds(row.contentText, NOTE_RE),
      collectIds(normalizedContent, NOTE_RE),
    );
    let next = rewriteInternalNoteLinks(row.contentText, noteMap).content;
    next = rewriteAttachmentUrls(next, attachmentMap);
    if (next !== row.contentText) {
      db.prepare("UPDATE notes SET contentText = ? WHERE id = ?").run(next, noteId);
    }
  }

  return syncReferences(db, noteId, normalizedContent);
}

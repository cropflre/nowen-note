/**
 * 附件反向索引（attachment_references）维护工具。
 *
 * 同步入口由现有 SQLite 事务调用；异步入口通过 Repository Runtime Adapter，
 * 用于 PostgreSQL 业务路径。两条路径共享同一内容解析和差异计算语义。
 */

import { attachmentReferencesRepository } from "../repositories";

const ATTACHMENT_ID_RE =
  /\/api\/attachments\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

export function extractAttachmentIdsFromContent(
  content: string | null | undefined,
): Set<string> {
  const output = new Set<string>();
  if (!content || typeof content !== "string") return output;
  if (!content.includes("/api/attachments/")) return output;

  const pattern = new RegExp(ATTACHMENT_ID_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    output.add(match[1].toLowerCase());
  }
  return output;
}

function referenceDiff(
  currentIds: string[],
  content: string | null | undefined,
): { toAdd: string[]; toRemove: string[] } {
  const next = extractAttachmentIdsFromContent(content);
  const current = new Set(currentIds.map((id) => id.toLowerCase()));
  const toAdd = [...next].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !next.has(id));
  return { toAdd, toRemove };
}

/**
 * SQLite 同步路径。函数本身不开事务，由调用方的原子事务统一管理。
 */
export function syncReferences(
  _db: unknown,
  noteId: string,
  content: string | null | undefined,
): { added: number; removed: number } {
  const { toAdd, toRemove } = referenceDiff(
    attachmentReferencesRepository.listByNoteId(noteId),
    content,
  );
  attachmentReferencesRepository.addReferences(noteId, toAdd);
  const removed = attachmentReferencesRepository.removeReferences(noteId, toRemove);
  return { added: toAdd.length, removed };
}

/**
 * Runtime Adapter 异步路径，可运行于 SQLite 或 PostgreSQL。
 */
export async function syncReferencesAsync(
  noteId: string,
  content: string | null | undefined,
): Promise<{ added: number; removed: number }> {
  const { toAdd, toRemove } = referenceDiff(
    await attachmentReferencesRepository.listByNoteIdAsync(noteId),
    content,
  );
  await attachmentReferencesRepository.addReferencesAsync(noteId, toAdd);
  const removed = await attachmentReferencesRepository.removeReferencesAsync(noteId, toRemove);
  return { added: toAdd.length, removed };
}

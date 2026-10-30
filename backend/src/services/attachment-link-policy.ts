import type Database from "better-sqlite3";
import { getDb } from "../db/schema";

let schemaReadyFor: ReturnType<typeof getDb> | null = null;

// Like file_shares, this is a policy on the serving instance, not note content.
// An absent row preserves existing files' sharing behavior.
export function ensureAttachmentLinkPolicyTable(db: Database.Database = getDb()): void {
  if (schemaReadyFor === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_link_policies (
      attachmentId TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
      externalAccessEnabled INTEGER NOT NULL CHECK (externalAccessEnabled IN (0, 1))
    )
  `);
  if (!db.inTransaction) schemaReadyFor = db;
}

export function isAttachmentExternalAccessEnabled(attachmentId: string): boolean {
  ensureAttachmentLinkPolicyTable();
  const row = getDb().prepare(
    "SELECT externalAccessEnabled FROM attachment_link_policies WHERE attachmentId = ?",
  ).get(attachmentId) as { externalAccessEnabled: number } | undefined;
  if (getDb().prepare("SELECT 1 FROM attachments WHERE id=? AND trashedAt IS NOT NULL").get(attachmentId)) return false;
  return row?.externalAccessEnabled !== 0;
}

export function setAttachmentExternalAccessEnabled(attachmentId: string, enabled: boolean, db: Database.Database = getDb()): void {
  ensureAttachmentLinkPolicyTable(db);
  db.prepare(`
    INSERT INTO attachment_link_policies (attachmentId, externalAccessEnabled) VALUES (?, ?)
    ON CONFLICT(attachmentId) DO UPDATE SET externalAccessEnabled = excluded.externalAccessEnabled
  `).run(attachmentId, enabled ? 1 : 0);
}

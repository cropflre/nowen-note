import type { NativeDatabase } from "./nativeDatabase";

/** Recovery history can outlive a profile switch or a resolved conflict. */
export async function retainedNativeDeletionAttachments(
  db: NativeDatabase,
): Promise<Set<string>> {
  const rows = await db.query<{
    payload: string;
  }>(`SELECT payload FROM sync_outbox WHERE entityType='note' AND operation='delete'
    UNION ALL SELECT localPayload AS payload FROM sync_conflicts WHERE entityType='note'`);
  return new Set(
    rows.flatMap((row) => {
      try {
        const attachments = JSON.parse(row.payload || "{}")._deletionRecovery
          ?.attachments;
        return Array.isArray(attachments)
          ? attachments.map((attachment: { id: string }) => attachment.id)
          : [];
      } catch {
        return [];
      }
    }),
  );
}

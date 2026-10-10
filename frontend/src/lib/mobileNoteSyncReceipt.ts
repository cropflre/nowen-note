import type { NativeDatabase } from "./nativeDatabase";
import type { NoteReceiptPhase } from "./noteSyncReceipt";

export interface NativeNoteSyncReceipt {
  phase: NoteReceiptPhase;
  localRevision: number | null;
  acknowledgedRevision: number | null;
}
export function nativeReceiptKey(profileId: string, noteId: string): string {
  return `note-receipt:v1:${profileId}:${noteId}`;
}
/** Persisted mutation-specific ACK, scoped to the profile and note. */
export async function readNativeNoteSyncReceipt(
  db: NativeDatabase, profileId: string, noteId: string,
): Promise<NativeNoteSyncReceipt> {
  const conflicts = await db.query<{ id: string }>(
    "SELECT id FROM sync_conflicts WHERE profileId=? AND entityType='note' AND entityId=? AND status='unresolved' LIMIT 1",
    [profileId, noteId],
  );
  if (conflicts.length) return { phase: "conflict", localRevision: null, acknowledgedRevision: null };
  const pending = await db.query<{ status: string; lastError: string | null }>(
    "SELECT status,lastError FROM sync_outbox WHERE profileId=? AND entityType='note' AND entityId=? AND status IN ('pending','failed','inflight') LIMIT 20",
    [profileId, noteId],
  );
  if (pending.some((row) => row.status === "failed" || !!row.lastError))
    return { phase: "error", localRevision: null, acknowledgedRevision: null };
  if (pending.length) return { phase: "pending", localRevision: null, acknowledgedRevision: null };
  const rows = await db.query<{ value: string }>(
    "SELECT value FROM native_runtime_meta WHERE key=? LIMIT 1", [nativeReceiptKey(profileId, noteId)],
  );
  try {
    const receipt = rows[0] && JSON.parse(rows[0].value) as { mutationId?: unknown; serverVersion?: unknown };
    if (typeof receipt?.mutationId === "string" && receipt.mutationId) {
      const version = typeof receipt.serverVersion === "number" && Number.isSafeInteger(receipt.serverVersion)
        ? receipt.serverVersion : null;
      return { phase: "confirmed", localRevision: null, acknowledgedRevision: version };
    }
  } catch { /* Corrupt metadata cannot prove an ACK. */ }
  return { phase: "unverified", localRevision: null, acknowledgedRevision: null };
}

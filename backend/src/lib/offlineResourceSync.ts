import type Database from "better-sqlite3";

type MutationResponse = Record<string, unknown>;
const METADATA_RETENTION_DAYS = 30;
const MAX_FUTURE_CLIENT_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

function normalizedClientTime(value: string | undefined): string {
  const serverNow = Date.now();
  if (!value) return new Date(serverNow).toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return new Date(serverNow).toISOString();
  return new Date(
    timestamp > serverNow + MAX_FUTURE_CLIENT_CLOCK_SKEW_MS ? serverNow : timestamp,
  ).toISOString();
}

export function getClientMutationAt(header: string | undefined): string {
  return normalizedClientTime(header);
}

export function getIdempotentMutation(
  db: Database.Database,
  userId: string,
  operationId: string | undefined,
): MutationResponse | null {
  if (!operationId) return null;
  const row = db.prepare(
    "SELECT responseJson FROM offline_mutation_results WHERE userId = ? AND operationId = ?",
  ).get(userId, operationId) as { responseJson: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.responseJson) as MutationResponse;
  } catch {
    return null;
  }
}

export function saveIdempotentMutation(
  db: Database.Database,
  userId: string,
  operationId: string | undefined,
  response: unknown,
): void {
  if (!operationId) return;
  db.prepare(`
    INSERT OR REPLACE INTO offline_mutation_results (userId, operationId, responseJson, createdAt)
    VALUES (?, ?, ?, datetime('now'))
  `).run(userId, operationId, JSON.stringify(response));
  pruneOfflineSyncMetadata(db);
}

export function pruneOfflineSyncMetadata(db: Database.Database): void {
  const retention = `-${METADATA_RETENTION_DAYS} days`;
  db.prepare("DELETE FROM offline_mutation_results WHERE createdAt < datetime('now', ?)").run(retention);
  db.prepare("DELETE FROM offline_resource_field_clocks WHERE recordedAt < datetime('now', ?)").run(retention);
  db.prepare("DELETE FROM offline_resource_tombstones WHERE recordedAt < datetime('now', ?)").run(retention);
}

export function getNewerFields(
  db: Database.Database,
  resourceType: string,
  resourceId: string,
  fields: readonly string[],
  clientUpdatedAt: string,
  operationId?: string,
): Set<string> {
  if (fields.length === 0) return new Set();
  const placeholders = fields.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT fieldName, clientUpdatedAt, clientOperationId
    FROM offline_resource_field_clocks
    WHERE resourceType = ? AND resourceId = ? AND fieldName IN (${placeholders})
  `).all(resourceType, resourceId, ...fields) as Array<{ fieldName: string; clientUpdatedAt: string; clientOperationId: string }>;
  const current = new Map(rows.map((row) => [row.fieldName, row]));
  const incomingOperationId = operationId || "";
  return new Set(fields.filter((field) => {
    const clock = current.get(field);
    if (!clock) return true;
    return clientUpdatedAt > clock.clientUpdatedAt
      || (clientUpdatedAt === clock.clientUpdatedAt && incomingOperationId >= (clock.clientOperationId || ""));
  }));
}

export function hasNewerFieldClock(
  db: Database.Database,
  resourceType: string,
  resourceId: string,
  clientUpdatedAt: string,
): boolean {
  return !!db.prepare(`
    SELECT 1
    FROM offline_resource_field_clocks
    WHERE resourceType = ? AND resourceId = ? AND clientUpdatedAt > ?
    LIMIT 1
  `).get(resourceType, resourceId, clientUpdatedAt);
}

export function writeFieldClocks(
  db: Database.Database,
  resourceType: string,
  resourceId: string,
  fields: Iterable<string>,
  clientUpdatedAt: string,
  operationId?: string,
): void {
  const write = db.prepare(`
    INSERT INTO offline_resource_field_clocks (resourceType, resourceId, fieldName, clientUpdatedAt, clientOperationId, recordedAt)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(resourceType, resourceId, fieldName)
    DO UPDATE SET clientUpdatedAt = excluded.clientUpdatedAt, clientOperationId = excluded.clientOperationId, recordedAt = excluded.recordedAt
  `);
  for (const field of fields) write.run(resourceType, resourceId, field, clientUpdatedAt, operationId || "");
}

export function getTombstone(
  db: Database.Database,
  resourceType: string,
  resourceId: string,
): { userId: string; workspaceId: string | null; deletedAt: string } | undefined {
  return db.prepare(
    "SELECT userId, workspaceId, deletedAt FROM offline_resource_tombstones WHERE resourceType = ? AND resourceId = ?",
  ).get(resourceType, resourceId) as { userId: string; workspaceId: string | null; deletedAt: string } | undefined;
}

export function writeTombstone(
  db: Database.Database,
  resourceType: string,
  resourceId: string,
  userId: string,
  workspaceId: string | null,
  deletedAt: string,
): void {
  db.prepare(`
    INSERT INTO offline_resource_tombstones (resourceType, resourceId, userId, workspaceId, deletedAt, recordedAt)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(resourceType, resourceId)
    DO UPDATE SET deletedAt = excluded.deletedAt, userId = excluded.userId, workspaceId = excluded.workspaceId, recordedAt = excluded.recordedAt
  `).run(resourceType, resourceId, userId, workspaceId, deletedAt);
}

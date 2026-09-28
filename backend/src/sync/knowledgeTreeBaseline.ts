import type Database from "better-sqlite3";
import { recordConflict } from "./conflict.js";
import { SyncError } from "./errors.js";
import {
  isKnowledgeTreeSyncReady,
  markKnowledgeTreeSyncReady,
} from "./knowledgeTreeReadiness.js";
import { prepareKnowledgeTreeSnapshot, type KnowledgeTreeSnapshotItem } from "./knowledgeTreeSnapshot.js";
import type {
  RemoteSnapshotPage,
  SyncRemoteClient,
  SyncProtocolSubscription,
} from "./remote.js";
import { SYNC_V2_NEGOTIATED_ENTITY_TYPES } from "./types.js";
import type { SyncNegotiatedEntityType } from "./types.js";

export type KnowledgeTreeBaselineStatus = "ready" | "conflict" | "unsupported";

export interface KnowledgeTreeBaselineResult {
  status: KnowledgeTreeBaselineStatus;
  scopeKey: string;
  snapshotSequence: number;
  conflictCount: number;
}

interface BaselineOptions {
  db: Database.Database;
  profileId: string;
  deviceId: string;
  userId: string;
  scopeKey: string;
  workspaceId: string | null;
  client: SyncRemoteClient;
  pageSize?: number;
}

const STRUCTURE_FIELDS = [
  "resourceType", "resourceId", "nodeType", "parentId", "sortOrder", "isDeleted", "deletedAt",
] as const;

function sameStructure(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return STRUCTURE_FIELDS.every((key) => (a[key] ?? null) === (b[key] ?? null));
}

function hasUnresolvedConflict(
  db: Database.Database,
  profileId: string,
  scopeKey: string,
  entityId: string,
): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sync_conflicts
    WHERE profileId = ? AND scopeKey = ?
      AND entityType = 'knowledge_tree_node' AND entityId = ?
      AND status = 'unresolved'
    LIMIT 1
  `).get(profileId, scopeKey, entityId));
}

function preparedLocalOverrideMatches(
  db: Database.Database,
  profileId: string,
  scopeKey: string,
  entityId: string,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): boolean {
  const row = db.prepare(`
    SELECT payload FROM sync_outbox
    WHERE profileId = ? AND scopeKey = ?
      AND entityType = 'knowledge_tree_node' AND entityId = ?
      AND status IN ('pending', 'inflight', 'failed')
    ORDER BY rowid DESC LIMIT 1
  `).get(profileId, scopeKey, entityId) as { payload: string | null } | undefined;
  if (!row?.payload) return false;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return false;
  }
  const desiredMatches = sameStructure(payload, local);
  const baseMatches =
    (payload.baseParentId ?? null) === (remote.parentId ?? null)
    && payload.baseSortOrder === remote.sortOrder
    && payload.baseIsDeleted === remote.isDeleted;
  return desiredMatches && baseMatches;
}

function recordBaselineConflict(
  db: Database.Database,
  options: Pick<BaselineOptions, "profileId" | "scopeKey">,
  entityId: string,
  local: Record<string, unknown> | null,
  remote: Record<string, unknown> | null,
): void {
  if (hasUnresolvedConflict(db, options.profileId, options.scopeKey, entityId)) return;
  recordConflict(db, {
    profileId: options.profileId,
    scopeKey: options.scopeKey,
    entityType: "knowledge_tree_node",
    entityId,
    localPayload: local,
    remotePayload: remote,
  });
}

async function readRemoteTreeSnapshot(
  options: BaselineOptions,
  subscription: SyncProtocolSubscription,
): Promise<{ sequence: number; items: KnowledgeTreeSnapshotItem[] }> {
  const items: KnowledgeTreeSnapshotItem[] = [];
  let cursor: string | null = null;
  let sequence = 0;
  let pages = 0;
  do {
    const page: RemoteSnapshotPage<SyncNegotiatedEntityType> =
      await options.client.snapshot<SyncNegotiatedEntityType>(
      cursor,
      sequence,
      options.pageSize ?? 200,
      options.scopeKey,
      subscription,
    );
    if (sequence === 0) sequence = page.snapshotSequence;
    for (const item of page.items) {
      if (item.entityType === "knowledge_tree_node") {
        items.push({ entityId: item.entityId, payload: item.payload });
      }
    }
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 2000) {
      throw new SyncError("SERVER_ERROR", "知识树基线 Snapshot 分页超过安全上限");
    }
  } while (cursor);
  return { sequence, items };
}

/**
 * Establish the tree protocol only after local and remote structural state is safe to converge.
 *
 * No tree data is overwritten here. A structural mismatch is stored in the existing conflict
 * ledger and leaves the scope locked. After the user chooses "keep local", the queued CAS
 * mutation is recognized on the next run and the scope can be bound safely.
 */
export async function runKnowledgeTreeBaseline(
  options: BaselineOptions,
): Promise<KnowledgeTreeBaselineResult> {
  if (isKnowledgeTreeSyncReady(options.db, options.profileId, options.scopeKey)) {
    return { status: "ready", scopeKey: options.scopeKey, snapshotSequence: 0, conflictCount: 0 };
  }
  const subscription: SyncProtocolSubscription = {
    entityTypes: SYNC_V2_NEGOTIATED_ENTITY_TYPES,
    deviceId: options.deviceId,
  };

  let remoteSnapshot: Awaited<ReturnType<typeof readRemoteTreeSnapshot>>;
  try {
    remoteSnapshot = await readRemoteTreeSnapshot(options, subscription);
  } catch (error) {
    if (error instanceof SyncError && error.code === "INVALID_PAYLOAD") {
      return { status: "unsupported", scopeKey: options.scopeKey, snapshotSequence: 0, conflictCount: 0 };
    }
    throw error;
  }

  const localItems = prepareKnowledgeTreeSnapshot(
    options.db,
    options.userId,
    options.workspaceId,
  );
  const local = new Map(localItems.map((item) => [item.entityId, item.payload]));
  const remote = new Map(remoteSnapshot.items.map((item) => [item.entityId, item.payload]));
  const ids = new Set([...local.keys(), ...remote.keys()]);
  let conflicts = 0;

  for (const entityId of ids) {
    const localPayload = local.get(entityId) ?? null;
    const remotePayload = remote.get(entityId) ?? null;
    if (!localPayload || !remotePayload) {
      recordBaselineConflict(options.db, options, entityId, localPayload, remotePayload);
      conflicts += 1;
      continue;
    }
    if (sameStructure(localPayload, remotePayload)) continue;
    if (preparedLocalOverrideMatches(
      options.db,
      options.profileId,
      options.scopeKey,
      entityId,
      localPayload,
      remotePayload,
    )) {
      continue;
    }
    recordBaselineConflict(options.db, options, entityId, localPayload, remotePayload);
    conflicts += 1;
  }

  if (conflicts > 0) {
    return {
      status: "conflict",
      scopeKey: options.scopeKey,
      snapshotSequence: remoteSnapshot.sequence,
      conflictCount: conflicts,
    };
  }

  await options.client.ack(
    options.deviceId,
    remoteSnapshot.sequence,
    options.scopeKey,
    subscription,
  );
  markKnowledgeTreeSyncReady(options.db, options.profileId, options.scopeKey);
  return {
    status: "ready",
    scopeKey: options.scopeKey,
    snapshotSequence: remoteSnapshot.sequence,
    conflictCount: 0,
  };
}

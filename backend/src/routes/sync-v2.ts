import type Database from "better-sqlite3";
import { Hono } from "hono";
import { getDb } from "../db/schema";
import {
  SYNC_CHANGES_PAGE_SIZE,
  SYNC_PERSONAL_SCOPE_KEY,
  SYNC_PUSH_MAX_MUTATIONS,
  SYNC_SNAPSHOT_MAX_PAGE_SIZE,
  SYNC_SNAPSHOT_PAGE_SIZE,
} from "../sync/constants";
import { isLocalFirstSyncV2Enabled } from "../sync/flag";
import {
  isSyncNegotiatedEntityType,
  isSyncOperation,
  SYNC_V2_LEGACY_ENTITY_TYPES,
  SYNC_V2_NEGOTIATED_ENTITY_TYPES,
} from "../sync/types";
import type { SyncEntityType, SyncNegotiatedEntityType, SyncOperation } from "../sync/types";
import { logSyncInfo, logSyncWarn } from "../sync/log";
import { applyMutation } from "../sync/apply";
import type { ApplyMutationResult } from "../sync/apply";
import { SyncError, isSyncErrorCode } from "../sync/errors";
import { notifySyncChanged } from "../sync/notify";
import {
  assertSyncMutationAccess,
  listAuthorizedScopes,
  resolveAuthorizedScope,
  type SyncScopeDescriptor,
} from "../sync/scope";
import {
  hasKnowledgeCapability,
  resolveKnowledgeNodeAccess,
  resolveResourceKnowledgeAccess,
} from "../services/knowledgeCapabilities";
import { knowledgeTreeSnapshotPage } from "../sync/knowledgeTreeSnapshot";

/**
 * Sync Protocol V2。
 *
 * 与 /api/offline-sync（V1）完全并存：V1 仍被已发布客户端使用，
 * 本路由不读写 offline_sync_changes，也不改动任何 V1 行为。
 *
 * 复用 V1 已验证的思想：sequence / cursor / 增量 changes / ACK /
 * resetRequired / minAvailableSequence。新增的是 push 方向与实体级粒度。
 *
 * 所有端点都按 personal / workspace:<id> Scope 独立授权与推进游标。
 */
const app = new Hono();
const LEGACY_ENTITY_SET = SYNC_V2_LEGACY_ENTITY_TYPES.join(",");
const NEGOTIATED_ENTITY_SET = SYNC_V2_NEGOTIATED_ENTITY_TYPES.join(",");

interface EntitySubscription {
  types: readonly SyncNegotiatedEntityType[];
  entitySet: string;
  explicit: boolean;
}

function sameEntitySet(values: string[], expected: readonly string[]): boolean {
  return values.length === expected.length
    && new Set(values).size === expected.length
    && values.every((value) => expected.includes(value));
}

function resolveEntitySubscription(c: any): EntitySubscription {
  const requested = c.req.queries("entityTypes") as string[] | undefined;
  if (requested === undefined) {
    return { types: SYNC_V2_LEGACY_ENTITY_TYPES, entitySet: LEGACY_ENTITY_SET, explicit: false };
  }
  if (requested.length !== 1) {
    throw new SyncError("INVALID_PAYLOAD", "entityTypes 只能声明一次");
  }
  const types = requested[0].split(",").map((value) => value.trim()).filter(Boolean);
  if (sameEntitySet(types, SYNC_V2_LEGACY_ENTITY_TYPES)) {
    return { types: SYNC_V2_LEGACY_ENTITY_TYPES, entitySet: LEGACY_ENTITY_SET, explicit: true };
  }
  if (sameEntitySet(types, SYNC_V2_NEGOTIATED_ENTITY_TYPES)) {
    return { types: SYNC_V2_NEGOTIATED_ENTITY_TYPES, entitySet: NEGOTIATED_ENTITY_SET, explicit: true };
  }
  throw new SyncError("INVALID_PAYLOAD", "当前同步协议不支持请求的实体集合");
}

interface ChangeRowV2 {
  sequence: number;
  entityType: SyncNegotiatedEntityType;
  entityId: string;
  noteId: string | null;
  operation: SyncOperation;
  version: number | null;
  changedAt: string;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function currentSequence(
  db: Database.Database,
  userId: string,
  workspaceId: string | null,
): number {
  const row = db.prepare(`
    SELECT MAX(sequence) AS sequence FROM sync_changes_v2
    WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?)
  `).get(workspaceId, workspaceId, userId) as
    | { sequence: number | null } | undefined;
  return Number(row?.sequence || 0);
}

/**
 * 服务端仍可增量供给的最小序号。
 * 客户端游标早于此值说明中间变更已被清理，必须回退 snapshot，
 * 否则会静默丢失那段变更。
 */
function minAvailableSequence(
  db: Database.Database,
  userId: string,
  workspaceId: string | null,
  entityTypes: readonly SyncNegotiatedEntityType[],
): number {
  const row = db.prepare(`
    SELECT MIN(sequence) AS sequence FROM sync_changes_v2
    WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?)
      AND entityType IN (${entityTypes.map(() => "?").join(",")})
  `).get(workspaceId, workspaceId, userId, ...entityTypes) as
    | { sequence: number | null } | undefined;
  return Number(row?.sequence || 0);
}

function needsReset(after: number, minSequence: number): boolean {
  return after > 0 && minSequence > 0 && after < minSequence - 1;
}

/** Flag 关闭时整个 V2 不可用，避免半启用状态被误用。 */
function guard(c: any): Response | null {
  if (!isLocalFirstSyncV2Enabled()) {
    return c.json({ error: "Sync V2 未启用", code: "SYNC_V2_DISABLED" }, 404);
  }
  if (!c.req.header("X-User-Id")) {
    return c.json({ error: "缺少用户身份", code: "SYNC_V2_UNAUTHORIZED" }, 401);
  }
  return null;
}

function canViewWorkspaceEntity(
  db: Database.Database,
  userId: string,
  workspaceId: string | null,
  entityType: SyncNegotiatedEntityType,
  entityId: string,
  noteId?: string | null,
): boolean {
  if (!workspaceId) return true;
  if (entityType === "knowledge_tree_node") {
    try {
      return hasKnowledgeCapability(
        resolveKnowledgeNodeAccess(entityId, userId, db, { includeDeleted: true }),
        "canView",
      );
    } catch {
      return false;
    }
  }
  let resourceType: "note" | "notebook" | null = null;
  let resourceId = "";
  if (entityType === "notebook") { resourceType = "notebook"; resourceId = entityId; }
  else if (entityType === "note") { resourceType = "note"; resourceId = entityId; }
  else if (entityType === "note_tag" || entityType === "favorite" || entityType === "attachment") {
    resourceType = "note";
    resourceId = noteId || (entityType === "favorite"
      ? entityId.split(":").at(-1) || ""
      : entityId.split(":")[0]);
  }
  if (!resourceType || !resourceId) return true;
  try {
    return hasKnowledgeCapability(
      resolveResourceKnowledgeAccess(resourceType,resourceId,userId,db),
      "canView",
    );
  } catch {
    return false;
  }
}

function scopeError(c: any, error: unknown): Response {
  const code = error instanceof SyncError && isSyncErrorCode(error.code)
    ? error.code
    : "SERVER_ERROR";
  const status = code === "INVALID_PAYLOAD" ? 400
    : code === "ACCESS_REVOKED" || code === "SCOPE_FORBIDDEN" ? 403
      : 500;
  return c.json({
    error: error instanceof Error ? error.message.slice(0, 200) : code,
    code,
  }, status);
}

function requestScope(
  c: any,
  db: Database.Database,
  access: "read" | "write" = "read",
): SyncScopeDescriptor {
  // 旧客户端曾尝试传 workspaceId。新协议只接受 scopeKey；静默忽略会把
  // 工作区请求误当 personal，存在跨 Scope 写入/ACK 的数据安全风险。
  if (c.req.query("workspaceId") !== undefined) {
    throw new SyncError("INVALID_PAYLOAD", "请使用 scopeKey=workspace:<id> 指定工作区同步作用域");
  }
  const scope = resolveAuthorizedScope(
    db,
    c.req.header("X-User-Id") as string,
    c.req.query("scopeKey") || SYNC_PERSONAL_SCOPE_KEY,
    access,
  );
  // 未声明的旧客户端继续使用原有 10 类实体；新客户端必须显式声明完整协商集合。
  resolveEntitySubscription(c);
  return scope;
}

function explicitSubscriptionDevice(c: any): string | null {
  if (c.req.query("entityTypes") === undefined) return null;
  const values = c.req.queries("deviceId") as string[] | undefined;
  const deviceId = values?.length === 1 ? values[0].trim() : "";
  if (!deviceId || deviceId.length > 128) {
    throw new SyncError("INVALID_PAYLOAD", "显式实体订阅需要有效的 deviceId");
  }
  return deviceId;
}

function hasBoundSubscription(
  db: Database.Database,
  userId: string,
  scopeKey: string,
  deviceId: string,
  entitySet: string,
): boolean {
  const row = db.prepare(`
    SELECT entitySet FROM sync_v2_clients
    WHERE deviceId = ? AND userId = ? AND scopeKey = ?
  `).get(deviceId, userId, scopeKey) as { entitySet: string | null } | undefined;
  return row?.entitySet === entitySet;
}

app.get("/scopes", (c) => {
  const denied = guard(c);
  if (denied) return denied;
  const db = getDb();
  const userId = c.req.header("X-User-Id") as string;
  return c.json({ items: listAuthorizedScopes(db, userId) });
});

// ---------------------------------------------------------------------------
// GET /plan
// ---------------------------------------------------------------------------

app.get("/plan", (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const userId = c.req.header("X-User-Id") as string;
  let scope: SyncScopeDescriptor;
  let deviceId: string | null;
  try { scope = requestScope(c, db); deviceId = explicitSubscriptionDevice(c); }
  catch (error) { return scopeError(c, error); }
  const subscription = resolveEntitySubscription(c);
  const after = Math.max(0, Number(c.req.query("after") || 0) || 0);
  const minSequence = minAvailableSequence(db, userId, scope.workspaceId, subscription.types);
  const serverSequence = currentSequence(db, userId, scope.workspaceId);

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM notebooks WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?)) AS notebooks,
      (SELECT COUNT(*) FROM notes WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?)) AS notes,
      (SELECT COUNT(*) FROM tags WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?)) AS tags
  `).get(
    scope.workspaceId, scope.workspaceId, userId,
    scope.workspaceId, scope.workspaceId, userId,
    scope.workspaceId, scope.workspaceId, userId,
  ) as { notebooks: number; notes: number; tags: number };

  return c.json({
    scopeKey: scope.scopeKey,
    accessFingerprint: scope.accessFingerprint,
    entityTypes: subscription.types,
    serverSequence,
    minAvailableSequence: minSequence,
    resetRequired: needsReset(after, minSequence)
      || (deviceId !== null
        && !hasBoundSubscription(db, userId, scope.scopeKey, deviceId, subscription.entitySet)),
    notebookCount: counts.notebooks,
    noteCount: counts.notes,
    tagCount: counts.tags,
    serverTime: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /changes — Change Feed 是唯一事实来源
// ---------------------------------------------------------------------------

app.get("/changes", (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const userId = c.req.header("X-User-Id") as string;
  let scope: SyncScopeDescriptor;
  let deviceId: string | null;
  try { scope = requestScope(c, db); deviceId = explicitSubscriptionDevice(c); }
  catch (error) { return scopeError(c, error); }
  const subscription = resolveEntitySubscription(c);
  const after = Math.max(0, Number(c.req.query("after") || 0) || 0);
  const limit = clampInt(c.req.query("limit"), SYNC_CHANGES_PAGE_SIZE, 1, 1000);
  const minSequence = minAvailableSequence(db, userId, scope.workspaceId, subscription.types);
  const serverSequence = currentSequence(db, userId, scope.workspaceId);

  if (needsReset(after, minSequence)
    || (deviceId !== null
      && !hasBoundSubscription(db, userId, scope.scopeKey, deviceId, subscription.entitySet))) {
    return c.json({
      scopeKey: scope.scopeKey,
      accessFingerprint: scope.accessFingerprint,
      resetRequired: true,
      minAvailableSequence: minSequence,
      serverSequence,
      nextSequence: after,
      hasMore: false,
      items: [],
    });
  }

  const scannedRows = db.prepare(`
    SELECT sequence, entityType, entityId, noteId, operation, version, changedAt
    FROM sync_changes_v2
    WHERE sequence > ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)
      AND entityType IN (${subscription.types.map(() => "?").join(",")})
    ORDER BY sequence ASC
    LIMIT ?
  `).all(after, scope.workspaceId, scope.workspaceId, userId, ...subscription.types, limit) as ChangeRowV2[];
  const rows = scannedRows.filter((row) => row.operation === "delete" || canViewWorkspaceEntity(
    db,userId,scope.workspaceId,row.entityType,row.entityId,row.noteId,
  ));

  const hasMore = scannedRows.length === limit;
  // 取空或未满页时把游标推进到 serverSequence，
  // 否则客户端会因为"其他用户产生的序号"反复空转拉取。
  const nextSequence = hasMore ? scannedRows[scannedRows.length - 1].sequence : serverSequence;

  return c.json({
    scopeKey: scope.scopeKey,
    accessFingerprint: scope.accessFingerprint,
    resetRequired: false,
    minAvailableSequence: minSequence,
    serverSequence,
    nextSequence,
    hasMore,
    items: rows,
  });
});

// ---------------------------------------------------------------------------
// GET /snapshot — 全量重建，必须分页
// ---------------------------------------------------------------------------

/**
 * 固定实体顺序遍历，游标为 "entityType:id"。
 * 顺序固定使分页可重放，也保证客户端先拿到 notebook / tag
 * 再拿 note，应用时不会缺少父实体。
 */
// 旧客户端快照依赖顺序与实体类型声明顺序不同：tag 必须先于 note。
// 新实体只能通过后续显式协商加入，不得直接改动这份默认顺序。
const LEGACY_SNAPSHOT_ORDER: SyncNegotiatedEntityType[] = [
  "notebook", "tag", "note", "note_tag", "favorite", "attachment",
  "task", "task_reminder", "diary", "mindmap",
];

function snapshotOrder(subscription: EntitySubscription): SyncNegotiatedEntityType[] {
  return subscription.entitySet === NEGOTIATED_ENTITY_SET
    ? [...LEGACY_SNAPSHOT_ORDER, "knowledge_tree_node"]
    : [...LEGACY_SNAPSHOT_ORDER];
}

function parseCursor(
  raw: string,
  order: readonly SyncNegotiatedEntityType[],
): { type: SyncNegotiatedEntityType; id: string } {
  const separator = raw.indexOf(":");
  if (separator > 0) {
    const type = raw.slice(0, separator);
    if (order.includes(type as SyncNegotiatedEntityType)) {
      return { type: type as SyncNegotiatedEntityType, id: raw.slice(separator + 1) };
    }
  }
  return { type: order[0], id: "" };
}

function snapshotPage(
  db: Database.Database,
  userId: string,
  workspaceId: string | null,
  type: SyncNegotiatedEntityType,
  afterId: string,
  limit: number,
): Array<{ id: string; payload: Record<string, unknown> }> {
  const map = (rows: Array<Record<string, unknown>>) =>
    rows.map((row) => ({ id: String(row.id), payload: row }));

  switch (type) {
    case "notebook":
      return map(db.prepare(`
        SELECT id, userId, parentId, name, description, icon, color,
               sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt, workspaceId
        FROM notebooks WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?) AND id > ?
        ORDER BY id ASC LIMIT ?
      `).all(workspaceId, workspaceId, userId, afterId, limit) as Array<Record<string, unknown>>);

    case "tag":
      return map(db.prepare(`
        SELECT id, userId, name, color, createdAt, workspaceId
        FROM tags WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?) AND id > ?
        ORDER BY id ASC LIMIT ?
      `).all(workspaceId, workspaceId, userId, afterId, limit) as Array<Record<string, unknown>>);

    case "note":
      return map(db.prepare(`
        SELECT id, userId, notebookId, title, content, contentText, contentFormat,
               isPinned, isFavorite, isLocked, isArchived, isTrashed, trashedAt,
               themeId, version, sortOrder, createdAt, updatedAt, workspaceId
        FROM notes WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?) AND id > ?
        ORDER BY id ASC LIMIT ?
      `).all(workspaceId, workspaceId, userId, afterId, limit) as Array<Record<string, unknown>>);

    case "note_tag":
      return (db.prepare(`
        SELECT nt.noteId, nt.tagId FROM note_tags nt
        INNER JOIN notes n ON n.id = nt.noteId
        WHERE n.workspaceId IS ? AND (? IS NOT NULL OR n.userId = ?)
          AND (nt.noteId || ':' || nt.tagId) > ?
        ORDER BY (nt.noteId || ':' || nt.tagId) ASC LIMIT ?
      `).all(workspaceId, workspaceId, userId, afterId, limit) as Array<{ noteId: string; tagId: string }>)
        .map((row) => ({ id: `${row.noteId}:${row.tagId}`, payload: { ...row, workspaceId } }));

    case "favorite":
      return (db.prepare(`
        SELECT userId, noteId, createdAt FROM favorites
        WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?)
          AND (userId || ':' || noteId) > ?
        ORDER BY (userId || ':' || noteId) ASC LIMIT ?
      `).all(workspaceId, workspaceId, userId, afterId, limit) as Array<Record<string, unknown>>)
        .map((row) => ({ id: `${row.userId}:${row.noteId}`, payload: row }));

    case "attachment":
      // 只给元数据；二进制通过附件下载接口取，避免 snapshot 体积失控。
      return map(db.prepare(`
        SELECT a.id, a.noteId, a.userId, a.filename, a.mimeType, a.size, a.hash, a.workspaceId, a.createdAt
        FROM attachments a INNER JOIN notes n ON n.id = a.noteId
        WHERE n.workspaceId IS ? AND (? IS NOT NULL OR a.userId = ?) AND a.id > ?
        ORDER BY a.id ASC LIMIT ?
      `).all(workspaceId, workspaceId, userId, afterId, limit) as Array<Record<string, unknown>>);

    case "task":
      return map(db.prepare(`
        SELECT * FROM tasks
        WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?) AND id > ?
        ORDER BY id ASC LIMIT ?
      `).all(workspaceId, workspaceId, userId, afterId, limit) as Array<Record<string, unknown>>);

    case "task_reminder":
      return map(db.prepare(`
        SELECT r.*, t.workspaceId
        FROM task_reminders r JOIN tasks t ON t.id = r.taskId
        WHERE t.workspaceId IS ? AND (? IS NOT NULL OR r.userId = ?) AND r.id > ?
        ORDER BY r.id ASC LIMIT ?
      `).all(workspaceId, workspaceId, userId, afterId, limit) as Array<Record<string, unknown>>);

    case "diary":
      return map(db.prepare(`
        SELECT * FROM diaries
        WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?) AND id > ?
        ORDER BY id ASC LIMIT ?
      `).all(workspaceId, workspaceId, userId, afterId, limit) as Array<Record<string, unknown>>);

    case "mindmap":
      return map(db.prepare(`
        SELECT * FROM mindmaps
        WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?) AND id > ?
        ORDER BY id ASC LIMIT ?
      `).all(workspaceId, workspaceId, userId, afterId, limit) as Array<Record<string, unknown>>);

    default:
      return [];
  }
}

function authorizedSnapshotPage(
  db: Database.Database,
  userId: string,
  workspaceId: string | null,
  type: SyncNegotiatedEntityType,
  afterId: string,
  limit: number,
): { rows:Array<{id:string;payload:Record<string,unknown>}>;scannedThrough:string;exhausted:boolean } {
  const rows:Array<{id:string;payload:Record<string,unknown>}> = [];
  let scannedThrough = afterId;
  const scanSize = Math.max(50,Math.min(200,limit * 2));
  while (rows.length < limit) {
    const batch = snapshotPage(db,userId,workspaceId,type,scannedThrough,scanSize);
    if (batch.length === 0) return {rows,scannedThrough,exhausted:true};
    for (const row of batch) {
      scannedThrough = row.id;
      const noteId = typeof row.payload.noteId === "string" ? row.payload.noteId : null;
      if (canViewWorkspaceEntity(db,userId,workspaceId,type,row.id,noteId)) rows.push(row);
      if (rows.length >= limit) return {rows,scannedThrough,exhausted:false};
    }
    if (batch.length < scanSize) return {rows,scannedThrough,exhausted:true};
  }
  return {rows,scannedThrough,exhausted:false};
}

app.get("/snapshot", (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const userId = c.req.header("X-User-Id") as string;
  let scope: SyncScopeDescriptor;
  let deviceId: string | null;
  try { scope = requestScope(c, db); deviceId = explicitSubscriptionDevice(c); }
  catch (error) { return scopeError(c, error); }
  const subscription = resolveEntitySubscription(c);
  const limit = clampInt(
    c.req.query("limit"), SYNC_SNAPSHOT_PAGE_SIZE, 1, SYNC_SNAPSHOT_MAX_PAGE_SIZE,
  );
  const requested = Number(c.req.query("snapshotSequence") || 0) || 0;
  const rawCursor = (c.req.query("cursor") || "").trim();
  const needsBinding = deviceId !== null
    && !hasBoundSubscription(db, userId, scope.scopeKey, deviceId, subscription.entitySet);
  let resumedSequence: number | null = null;
  if (needsBinding && (rawCursor || requested !== 0)) {
    const session = db.prepare(`
      SELECT accessFingerprint, snapshotSequence, nextCursor, completed FROM sync_v2_snapshot_sessions
      WHERE deviceId = ? AND userId = ? AND scopeKey = ? AND entitySet = ?
    `).get(deviceId, userId, scope.scopeKey, subscription.entitySet) as
      | { accessFingerprint: string; snapshotSequence: number; nextCursor: string | null; completed: number }
      | undefined;
    if (!session || session.completed || session.nextCursor !== rawCursor
      || session.snapshotSequence !== requested
      || session.accessFingerprint !== scope.accessFingerprint) {
      return scopeError(c, new SyncError("INVALID_PAYLOAD", "Snapshot 分页游标与实体订阅不匹配"));
    }
    resumedSequence = session.snapshotSequence;
  }
  // 首页确定 snapshotSequence，客户端在后续页回传，
  // 保证整份 snapshot 对应同一时间点，之后从该序号继续增量。
  const snapshotSequence = resumedSequence
    ?? (requested > 0 ? requested : currentSequence(db, userId, scope.workspaceId));

  const order = snapshotOrder(subscription);
  const cursor = parseCursor(rawCursor, order);
  let typeIndex = Math.max(0, order.indexOf(cursor.type));
  let afterId = cursor.id;

  const items: Array<{ entityType: SyncNegotiatedEntityType; entityId: string; payload: Record<string, unknown> }> = [];
  let nextCursor: string | null = null;

  while (typeIndex < order.length && items.length < limit) {
    const type = order[typeIndex];
    if (type === "knowledge_tree_node") {
      const page = knowledgeTreeSnapshotPage(
        db,
        userId,
        scope.workspaceId,
        afterId || null,
        limit - items.length,
      );
      for (const row of page.items) {
        items.push({ entityType: type, entityId: row.entityId, payload: row.payload });
      }
      if (page.nextCursor) {
        nextCursor = `${type}:${page.nextCursor}`;
        break;
      }
      typeIndex += 1;
      afterId = "";
      continue;
    }
    const page = authorizedSnapshotPage(db,userId,scope.workspaceId,type,afterId,limit-items.length);
    for (const row of page.rows) {
      items.push({ entityType: type, entityId: row.id, payload: row.payload });
    }
    if (items.length >= limit || !page.exhausted) {
      nextCursor = `${type}:${page.scannedThrough}`;
      break;
    }
    typeIndex += 1;
    afterId = "";
  }

  if (needsBinding) {
    db.prepare(`
      INSERT INTO sync_v2_snapshot_sessions
        (deviceId, userId, scopeKey, entitySet, accessFingerprint, snapshotSequence, nextCursor, completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId, userId, scopeKey) DO UPDATE SET
        entitySet = excluded.entitySet,
        accessFingerprint = excluded.accessFingerprint,
        snapshotSequence = excluded.snapshotSequence,
        nextCursor = excluded.nextCursor,
        completed = excluded.completed
    `).run(deviceId, userId, scope.scopeKey, subscription.entitySet, scope.accessFingerprint,
      snapshotSequence, nextCursor, nextCursor === null ? 1 : 0);
  }

  return c.json({
    scopeKey: scope.scopeKey,
    accessFingerprint: scope.accessFingerprint,
    snapshotSequence,
    items,
    hasMore: nextCursor !== null,
    nextCursor,
  });
});

// ---------------------------------------------------------------------------
// POST /push — 上行，按 mutationId 幂等
// ---------------------------------------------------------------------------

interface IncomingMutation {
  mutationId: string;
  entityType: SyncNegotiatedEntityType;
  entityId: string;
  operation: SyncOperation;
  baseVersion?: number;
  payload?: Record<string, unknown>;
}

function validateMutation(raw: unknown): IncomingMutation | string {
  if (!raw || typeof raw !== "object") return "mutation 必须是对象";
  const m = raw as Record<string, unknown>;

  const mutationId = typeof m.mutationId === "string" ? m.mutationId.trim() : "";
  if (!mutationId || mutationId.length > 128) return "mutationId 无效";
  if (!isSyncNegotiatedEntityType(m.entityType)) return "entityType 超出当前协议范围";
  if (!isSyncOperation(m.operation)) return "operation 只能是 upsert / delete";

  const entityId = typeof m.entityId === "string" ? m.entityId.trim() : "";
  if (!entityId || entityId.length > 256) return "entityId 无效";

  const baseVersion = m.baseVersion === undefined || m.baseVersion === null
    ? undefined
    : Number(m.baseVersion);
  if (baseVersion !== undefined && !Number.isSafeInteger(baseVersion)) {
    return "baseVersion 必须是整数";
  }

  const payload = m.payload && typeof m.payload === "object" && !Array.isArray(m.payload)
    ? (m.payload as Record<string, unknown>)
    : undefined;

  return {
    mutationId,
    entityType: m.entityType,
    entityId,
    operation: m.operation,
    baseVersion,
    payload,
  };
}

app.post("/push", async (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const userId = c.req.header("X-User-Id") as string;
  let scope: SyncScopeDescriptor;
  try { scope = requestScope(c, db, "write"); } catch (error) { return scopeError(c, error); }
  const subscription = resolveEntitySubscription(c);

  let body: { scopeKey?: unknown; deviceId?: unknown; mutations?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON", code: "INVALID_PAYLOAD" }, 400);
  }

  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  if (!deviceId || deviceId.length > 128) {
    return c.json({ error: "缺少有效的 deviceId", code: "INVALID_PAYLOAD" }, 400);
  }

  if (!Array.isArray(body.mutations)) {
    return c.json({ error: "mutations 必须是数组", code: "INVALID_PAYLOAD" }, 400);
  }
  if (body.scopeKey !== undefined && body.scopeKey !== scope.scopeKey) {
    return c.json({ error: "请求体与查询参数的 Scope 不一致", code: "SCOPE_FORBIDDEN" }, 403);
  }
  if (body.mutations.length > SYNC_PUSH_MAX_MUTATIONS) {
    return c.json(
      {
        error: `单次 push 最多 ${SYNC_PUSH_MAX_MUTATIONS} 条`,
        code: "INVALID_PAYLOAD",
      },
      400,
    );
  }

  const results: Array<ApplyMutationResult & { error?: string }> = [];
  let applied = 0;
  let conflicts = 0;

  for (const raw of body.mutations) {
    const parsed = validateMutation(raw);
    if (typeof parsed === "string") {
      results.push({
        mutationId: typeof (raw as any)?.mutationId === "string" ? (raw as any).mutationId : "",
        status: "conflict",
        code: "INVALID_PAYLOAD",
        error: parsed,
      });
      continue;
    }

    if (!subscription.types.includes(parsed.entityType)) {
      results.push({
        mutationId: parsed.mutationId,
        status: "conflict",
        code: "INVALID_PAYLOAD",
        error: "当前客户端未订阅该实体类型",
      });
      continue;
    }
    if (parsed.entityType === "knowledge_tree_node"
      && (!subscription.explicit
        || subscription.entitySet !== NEGOTIATED_ENTITY_SET
        || !hasBoundSubscription(db, userId, scope.scopeKey, deviceId, subscription.entitySet))) {
      results.push({
        mutationId: parsed.mutationId,
        status: "conflict",
        code: "INVALID_PAYLOAD",
        error: "知识树结构同步须先完成显式订阅 Snapshot",
      });
      continue;
    }

    // 每条 mutation 独立成事务：一条冲突不应回滚同批次已成功的其他条目，
    // 否则客户端只能整批重试，反复卡在同一条坏数据上。
    try {
      const payloadWorkspaceId = parsed.payload?.workspaceId ?? null;
      if (payloadWorkspaceId !== null && payloadWorkspaceId !== scope.workspaceId) {
        throw new SyncError("SCOPE_FORBIDDEN", "payload 的 workspaceId 与 Scope 不一致");
      }
      if (parsed.entityType !== "knowledge_tree_node") {
        assertSyncMutationAccess(db, userId, scope, parsed as {
          entityType: SyncEntityType;
          entityId: string;
          operation: SyncOperation;
          payload?: Record<string, unknown>;
        });
      }
      const result = db.transaction(() => applyMutation(db, {
        userId,
        deviceId,
        mutationId: parsed.mutationId,
        entityType: parsed.entityType,
        entityId: parsed.entityId,
        operation: parsed.operation,
        baseVersion: parsed.baseVersion,
        payload: parsed.payload,
        workspaceId: scope.workspaceId,
      }))();
      results.push(result);
      if (result.status === "applied") applied += 1;
    } catch (error: any) {
      const code = error instanceof SyncError && isSyncErrorCode(error.code)
        ? error.code
        : "SERVER_ERROR";
      if (code === "VERSION_CONFLICT") conflicts += 1;

      // 冲突时直接回传服务端当前内容；远端实体未必会再次产生 Change Feed，
      // 只回版本号会让冲突中心永久拿不到服务器一侧正文。
      let serverVersion: number | undefined;
      let serverPayload: Record<string,unknown> | undefined;
      if (code === "VERSION_CONFLICT") {
        const table = parsed.entityType === "note" ? "notes"
          : parsed.entityType === "task" ? "tasks"
            : parsed.entityType === "mindmap" ? "mindmaps" : null;
        if (parsed.entityType === "knowledge_tree_node") {
          serverPayload = db.prepare(`
            SELECT id, userId, workspaceId, parentId, nodeType, resourceType, resourceId,
                   sortOrder, isDeleted, deletedAt, createdAt, updatedAt
            FROM knowledge_tree_nodes
            WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)
          `).get(parsed.entityId, scope.workspaceId, scope.workspaceId, userId) as
            | Record<string, unknown>
            | undefined;
        } else if (table) {
          serverPayload = db.prepare(`SELECT * FROM ${table} WHERE id=? AND workspaceId IS ?
            AND (? IS NOT NULL OR userId=?)`).get(
            parsed.entityId,scope.workspaceId,scope.workspaceId,userId,
          ) as Record<string,unknown> | undefined;
          if (parsed.entityType === "note" && typeof serverPayload?.version === "number") {
            serverVersion=serverPayload.version;
          }
        }
      }

      results.push({
        mutationId: parsed.mutationId,
        status: "conflict",
        code,
        serverVersion,
        serverPayload,
        error: error?.message ? String(error.message).slice(0, 200) : undefined,
      });
    }
  }

  logSyncInfo("push.done", {
    deviceId,
    pushCount: applied,
    conflictCount: conflicts,
  });

  // Phase 6：通知同一用户的其他设备来拉。
  // 只在真的落库了变更时通知，避免空 push 造成无意义唤醒。
  // 通知内容只有 sequence，数据仍以 Change Feed 为唯一来源。
  if (applied > 0) notifySyncChanged(db, userId, scope.scopeKey);

  return c.json({
    scopeKey: scope.scopeKey,
    accessFingerprint: scope.accessFingerprint,
    serverSequence: currentSequence(db, userId, scope.workspaceId),
    results,
  });
});

// ---------------------------------------------------------------------------
// POST /ack — 记录客户端已应用到的位置
// ---------------------------------------------------------------------------

app.post("/ack", async (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const userId = c.req.header("X-User-Id") as string;
  let scope: SyncScopeDescriptor;
  try { scope = requestScope(c, db); } catch (error) { return scopeError(c, error); }
  const subscription = resolveEntitySubscription(c);

  let body: { scopeKey?: unknown; deviceId?: unknown; sequence?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON", code: "INVALID_PAYLOAD" }, 400);
  }

  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  const sequence = Number(body.sequence);
  if (!deviceId || deviceId.length > 128 || !Number.isSafeInteger(sequence) || sequence < 0) {
    logSyncWarn("ack.rejected", { deviceId, errorCode: "INVALID_PAYLOAD" });
    return c.json({ error: "deviceId 或 sequence 无效", code: "INVALID_PAYLOAD" }, 400);
  }
  if (body.scopeKey !== undefined && body.scopeKey !== scope.scopeKey) {
    return c.json({ error: "请求体与查询参数的 Scope 不一致", code: "SCOPE_FORBIDDEN" }, 403);
  }
  if (c.req.query("deviceId") !== undefined && c.req.query("deviceId") !== deviceId) {
    return c.json({ error: "请求体与查询参数的 deviceId 不一致", code: "INVALID_PAYLOAD" }, 400);
  }

  if (c.req.query("entityTypes") !== undefined) {
    if (sequence > currentSequence(db, userId, scope.workspaceId)) {
      return c.json({ error: "ACK 序号超过服务端游标", code: "INVALID_PAYLOAD" }, 400);
    }
    const alreadyBound = hasBoundSubscription(
      db, userId, scope.scopeKey, deviceId, subscription.entitySet,
    );
    if (!alreadyBound) {
      const session = db.prepare(`
        SELECT accessFingerprint, snapshotSequence, completed FROM sync_v2_snapshot_sessions
        WHERE deviceId = ? AND userId = ? AND scopeKey = ? AND entitySet = ?
      `).get(deviceId, userId, scope.scopeKey, subscription.entitySet) as
        | { accessFingerprint: string; snapshotSequence: number; completed: number }
        | undefined;
      if (!session?.completed || session.snapshotSequence !== sequence
        || session.accessFingerprint !== scope.accessFingerprint) {
        return c.json({ error: "实体订阅变更须先完成全量 Snapshot", code: "INVALID_PAYLOAD" }, 400);
      }
    }
    db.transaction(() => {
      db.prepare(`
        INSERT INTO sync_v2_clients (deviceId, userId, scopeKey, lastSequence, lastSeenAt, entitySet)
        VALUES (?, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT(deviceId, userId, scopeKey) DO UPDATE SET
          lastSequence = CASE WHEN entitySet IS excluded.entitySet
            THEN MAX(lastSequence, excluded.lastSequence) ELSE excluded.lastSequence END,
          entitySet = excluded.entitySet,
          lastSeenAt = excluded.lastSeenAt
      `).run(deviceId, userId, scope.scopeKey, sequence, subscription.entitySet);
      db.prepare(`
        DELETE FROM sync_v2_snapshot_sessions
        WHERE deviceId = ? AND userId = ? AND scopeKey = ?
      `).run(deviceId, userId, scope.scopeKey);
    })();
  } else {
    // 旧客户端仍可 ACK，但清除显式绑定。再次升级时必须重建快照，
    // 不能沿用降级期间已经跳过新实体的游标。
    db.prepare(`
      INSERT INTO sync_v2_clients (deviceId, userId, scopeKey, lastSequence, lastSeenAt)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(deviceId, userId, scopeKey) DO UPDATE SET
        lastSequence = MAX(lastSequence, excluded.lastSequence),
        entitySet = NULL,
        lastSeenAt = excluded.lastSeenAt
    `).run(deviceId, userId, scope.scopeKey, sequence);
  }

  const row = db.prepare(`
    SELECT lastSequence FROM sync_v2_clients
    WHERE deviceId = ? AND userId = ? AND scopeKey = ?
  `).get(deviceId, userId, scope.scopeKey) as { lastSequence: number };

  return c.json({
    scopeKey: scope.scopeKey,
    accessFingerprint: scope.accessFingerprint,
    lastSequence: row.lastSequence,
    serverSequence: currentSequence(db, userId, scope.workspaceId),
  });
});

export default app;

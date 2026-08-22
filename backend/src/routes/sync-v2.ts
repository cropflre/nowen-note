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
import { isSyncEntityType, isSyncOperation } from "../sync/types";
import type { SyncEntityType, SyncOperation } from "../sync/types";
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
  resolveResourceKnowledgeAccess,
} from "../services/knowledgeCapabilities";

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

interface ChangeRowV2 {
  sequence: number;
  entityType: SyncEntityType;
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
): number {
  const row = db.prepare(`
    SELECT MIN(sequence) AS sequence FROM sync_changes_v2
    WHERE workspaceId IS ? AND (? IS NOT NULL OR userId = ?)
  `).get(workspaceId, workspaceId, userId) as
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
  entityType: SyncEntityType,
  entityId: string,
  noteId?: string | null,
): boolean {
  if (!workspaceId) return true;
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
  return resolveAuthorizedScope(
    db,
    c.req.header("X-User-Id") as string,
    c.req.query("scopeKey") || SYNC_PERSONAL_SCOPE_KEY,
    access,
  );
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
  try { scope = requestScope(c, db); } catch (error) { return scopeError(c, error); }
  const after = Math.max(0, Number(c.req.query("after") || 0) || 0);
  const minSequence = minAvailableSequence(db, userId, scope.workspaceId);
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
    serverSequence,
    minAvailableSequence: minSequence,
    resetRequired: needsReset(after, minSequence),
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
  try { scope = requestScope(c, db); } catch (error) { return scopeError(c, error); }
  const after = Math.max(0, Number(c.req.query("after") || 0) || 0);
  const limit = clampInt(c.req.query("limit"), SYNC_CHANGES_PAGE_SIZE, 1, 1000);
  const minSequence = minAvailableSequence(db, userId, scope.workspaceId);
  const serverSequence = currentSequence(db, userId, scope.workspaceId);

  if (needsReset(after, minSequence)) {
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
    ORDER BY sequence ASC
    LIMIT ?
  `).all(after, scope.workspaceId, scope.workspaceId, userId, limit) as ChangeRowV2[];
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
const SNAPSHOT_ORDER: SyncEntityType[] = [
  "notebook", "tag", "note", "note_tag", "favorite", "attachment",
  "task", "task_reminder", "diary", "mindmap",
];

function parseCursor(raw: string): { type: SyncEntityType; id: string } {
  const separator = raw.indexOf(":");
  if (separator > 0) {
    const type = raw.slice(0, separator);
    if (isSyncEntityType(type)) return { type, id: raw.slice(separator + 1) };
  }
  return { type: SNAPSHOT_ORDER[0], id: "" };
}

function snapshotPage(
  db: Database.Database,
  userId: string,
  workspaceId: string | null,
  type: SyncEntityType,
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
               version, sortOrder, createdAt, updatedAt, workspaceId
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
  type: SyncEntityType,
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
  try { scope = requestScope(c, db); } catch (error) { return scopeError(c, error); }
  const limit = clampInt(
    c.req.query("limit"), SYNC_SNAPSHOT_PAGE_SIZE, 1, SYNC_SNAPSHOT_MAX_PAGE_SIZE,
  );
  const requested = Number(c.req.query("snapshotSequence") || 0) || 0;
  // 首页确定 snapshotSequence，客户端在后续页回传，
  // 保证整份 snapshot 对应同一时间点，之后从该序号继续增量。
  const snapshotSequence = requested > 0
    ? requested
    : currentSequence(db, userId, scope.workspaceId);

  const cursor = parseCursor((c.req.query("cursor") || "").trim());
  let typeIndex = Math.max(0, SNAPSHOT_ORDER.indexOf(cursor.type));
  let afterId = cursor.id;

  const items: Array<{ entityType: SyncEntityType; entityId: string; payload: Record<string, unknown> }> = [];
  let nextCursor: string | null = null;

  while (typeIndex < SNAPSHOT_ORDER.length && items.length < limit) {
    const type = SNAPSHOT_ORDER[typeIndex];
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
  entityType: SyncEntityType;
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
  if (!isSyncEntityType(m.entityType)) return "entityType 超出第一版范围";
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

    // 每条 mutation 独立成事务：一条冲突不应回滚同批次已成功的其他条目，
    // 否则客户端只能整批重试，反复卡在同一条坏数据上。
    try {
      const payloadWorkspaceId = parsed.payload?.workspaceId ?? null;
      if (payloadWorkspaceId !== null && payloadWorkspaceId !== scope.workspaceId) {
        throw new SyncError("SCOPE_FORBIDDEN", "payload 的 workspaceId 与 Scope 不一致");
      }
      assertSyncMutationAccess(db, userId, scope, parsed);
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
        if (table) {
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

  // 游标只前进不后退：乱序 / 迟到的 ACK 若把它改小，
  // 客户端会被迫重复拉取已应用过的变更。
  db.prepare(`
    INSERT INTO sync_v2_clients (deviceId, userId, scopeKey, lastSequence, lastSeenAt)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(deviceId, userId, scopeKey) DO UPDATE SET
      lastSequence = MAX(lastSequence, excluded.lastSequence),
      lastSeenAt = excluded.lastSeenAt
  `).run(deviceId, userId, scope.scopeKey, sequence);

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

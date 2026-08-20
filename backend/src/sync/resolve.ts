import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { SYNC_TABLES } from "./constants";
import { SyncError } from "./errors";
import { getConflict, resolveConflict } from "./conflict";
import { enqueueMutation } from "./outbox";
import { applyRemoteChanges } from "./applyLocal";
import { logSyncInfo } from "./log";
import type { SyncConflictRow, SyncEntityType } from "./types";

/**
 * 冲突解决（Phase 5）。
 *
 * 三条不可违背的规则：
 *
 * 1. **任何解决方式都不销毁另一方版本**。sync_conflicts 里的三方 payload
 *    永久保留（resolveConflict 只改状态），用户事后发现选错了仍能取回。
 *
 * 2. **不生成"xxx 冲突副本"污染知识树**。这是很多同步产品的做法，
 *    但会让用户的笔记列表被大量重复条目淹没。这里改为：内容留在冲突台账，
 *    用户在冲突中心里显式选择，只有主动"另存为新笔记"才会产生新条目。
 *
 * 3. **保留本机 = 重新入队推送**，而不是直接改远端。
 *    本地永远是权威，推送走正常的 Outbox → Push 链路，
 *    这样幂等、重试、失败保留等既有保证全部继续生效。
 */

export type ConflictResolution = "keep-local" | "keep-remote" | "manual";

export interface ResolveConflictInput {
  conflictId: string;
  resolution: ConflictResolution;
  /** manual 时必填：用户合并后的最终内容。 */
  mergedPayload?: Record<string, unknown>;
  /** 保留本机时用于重新入队；桌面端为本机 deviceId。 */
  deviceId: string;
  userId: string;
}

export interface ConflictDetail {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  localVersion: number | null;
  remoteVersion: number | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  base: Record<string, unknown> | null;
  local: Record<string, unknown> | null;
  remote: Record<string, unknown> | null;
  /** 供 UI 直接渲染的差异摘要，避免前端重复解析 JSON。 */
  diffFields: string[];
}

function parse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * 计算两侧差异字段。
 *
 * 只比较标量与字符串，正文（content）这类大字段仅标记"是否不同"，
 * 不在这里做逐字符 diff——那属于 UI 层职责，且大正文会拖慢列表加载。
 */
function diffFields(
  local: Record<string, unknown> | null,
  remote: Record<string, unknown> | null,
): string[] {
  if (!local || !remote) return [];
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const changed: string[] = [];
  for (const key of keys) {
    // 时间戳与版本号必然不同，列出来只会淹没真正的内容差异。
    if (key === "updatedAt" || key === "version") continue;
    const a = local[key];
    const b = remote[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(key);
  }
  return changed.sort();
}

export function toConflictDetail(row: SyncConflictRow): ConflictDetail {
  const local = parse(row.localPayload);
  const remote = parse(row.remotePayload);
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    localVersion: row.localVersion,
    remoteVersion: row.remoteVersion,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    base: parse(row.basePayload),
    local,
    remote,
    diffFields: diffFields(local, remote),
  };
}

/**
 * 补齐冲突的远端内容。
 *
 * Push 阶段判定冲突时只能拿到服务端版本号，完整内容要等后续 Pull。
 * Engine 在 Pull 到同一实体时调用本函数补齐，
 * 否则冲突中心只能显示"服务器版本 v7"而看不到内容，用户无法做选择。
 */
export function fillRemotePayload(
  db: Database.Database,
  entityType: SyncEntityType,
  entityId: string,
  remotePayload: Record<string, unknown>,
  remoteVersion?: number,
): number {
  const result = db.prepare(`
    UPDATE ${SYNC_TABLES.conflicts}
    SET remotePayload = ?, remoteVersion = COALESCE(?, remoteVersion)
    WHERE entityType = ? AND entityId = ? AND status = 'unresolved'
  `).run(
    JSON.stringify(remotePayload),
    remoteVersion ?? null,
    entityType,
    entityId,
  );
  return result.changes;
}

/**
 * 解决一个冲突。
 *
 * 整个过程在一个事务内：要么完整生效，要么完全不变，
 * 不允许出现"标记已解决但内容没写入"这种状态。
 */
export function applyConflictResolution(
  db: Database.Database,
  input: ResolveConflictInput,
): { conflictId: string; resolution: ConflictResolution } {
  const row = getConflict(db, input.conflictId);
  if (!row) throw new SyncError("INVALID_PAYLOAD", "冲突不存在");
  if (row.status === "resolved") {
    // 幂等：重复解决同一冲突直接返回，不报错也不重复写入。
    return { conflictId: row.id, resolution: input.resolution };
  }

  const local = parse(row.localPayload);
  const remote = parse(row.remotePayload);

  const run = db.transaction(() => {
    if (input.resolution === "keep-remote") {
      // 采用服务端版本：写入本地并抑制 Outbox
      // （这是远端内容，不该被当成本地修改再推回去）。
      if (!remote) throw new SyncError("INVALID_PAYLOAD", "缺少服务器版本内容");
      applyRemoteChanges(
        db,
        [{
          entityType: row.entityType,
          entityId: row.entityId,
          operation: "upsert",
          payload: remote,
        }],
        { userId: input.userId },
      );
      resolveConflict(db, row.id);
      return;
    }

    const payload = input.resolution === "manual" ? input.mergedPayload : local;
    if (!payload) {
      throw new SyncError(
        "INVALID_PAYLOAD",
        input.resolution === "manual" ? "缺少合并后的内容" : "缺少本机版本内容",
      );
    }

    // 保留本机 / 手动合并：先落本地，再重新入队推送。
    // 关键是 baseVersion 用服务端当前版本——只有这样服务端才会接受，
    // 否则会立刻再次判定为冲突，陷入死循环。
    applyRemoteChanges(
      db,
      [{
        entityType: row.entityType,
        entityId: row.entityId,
        operation: "upsert",
        payload,
      }],
      { userId: input.userId },
    );

    enqueueMutation(db, {
      entityType: row.entityType,
      entityId: row.entityId,
      operation: "upsert",
      deviceId: input.deviceId,
      profileId: row.profileId,
      baseVersion: row.remoteVersion ?? undefined,
      payload,
      mutationId: randomUUID(),
    });

    resolveConflict(db, row.id);
  });

  run();

  logSyncInfo("conflict.resolved", {
    profileId: row.profileId,
    entityType: row.entityType,
    entityId: row.entityId,
    state: input.resolution,
  });

  return { conflictId: row.id, resolution: input.resolution };
}

/**
 * 把冲突的某一方另存为新笔记。
 *
 * 只在用户显式要求时使用——这是"两个版本我都想留着"的出口，
 * 但绝不自动执行，否则知识树会被冲突副本淹没。
 */
export function forkConflictVersion(
  db: Database.Database,
  input: {
    conflictId: string;
    side: "local" | "remote";
    userId: string;
    deviceId: string;
  },
): { noteId: string } {
  const row = getConflict(db, input.conflictId);
  if (!row) throw new SyncError("INVALID_PAYLOAD", "冲突不存在");
  if (row.entityType !== "note") {
    throw new SyncError("INVALID_PAYLOAD", "只有笔记支持另存为新条目");
  }

  const payload = parse(input.side === "local" ? row.localPayload : row.remotePayload);
  if (!payload) throw new SyncError("INVALID_PAYLOAD", "该版本内容不存在");

  const newId = randomUUID();
  const title = typeof payload.title === "string" ? payload.title : "无标题笔记";
  const suffix = input.side === "local" ? "本机版本" : "服务器版本";

  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO notes (
        id, userId, notebookId, workspaceId, title, content, contentText, contentFormat,
        version, sortOrder, createdAt, updatedAt
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
    `).run(
      newId,
      input.userId,
      typeof payload.notebookId === "string" ? payload.notebookId : "",
      `${title}（${suffix}）`,
      typeof payload.content === "string" ? payload.content : "{}",
      typeof payload.contentText === "string" ? payload.contentText : "",
      typeof payload.contentFormat === "string" ? payload.contentFormat : "richtext",
    );

    // 新笔记是本地新建，正常入队同步。
    enqueueMutation(db, {
      entityType: "note",
      entityId: newId,
      operation: "upsert",
      deviceId: input.deviceId,
      profileId: row.profileId,
      payload: { ...payload, id: newId, title: `${title}（${suffix}）`, version: 1 },
    });
  });

  run();
  return { noteId: newId };
}

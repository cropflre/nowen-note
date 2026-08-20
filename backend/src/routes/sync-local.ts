import { Hono } from "hono";
import { getDb } from "../db/schema";
import { isLocalFirstSyncV2Enabled } from "../sync/flag";
import {
  countPendingMutations,
  listPendingMutations,
} from "../sync/outbox";
import {
  countUnresolvedConflicts,
  getConflict,
  listUnresolvedConflicts,
} from "../sync/conflict";
import {
  applyConflictResolution,
  forkConflictVersion,
  toConflictDetail,
} from "../sync/resolve";
import {
  createProfile,
  disableProfile,
  findProfileByServer,
  getProfile,
  getSyncState,
  listProfiles,
  setProfileEnabled,
} from "../sync/profile";
import { ensureDevice } from "../sync/device";
import { SyncError, isSyncErrorCode } from "../sync/errors";
import { SYNC_PERSONAL_SCOPE_KEY } from "../sync/constants";
import { logSyncInfo } from "../sync/log";

/**
 * 本地同步管理 API（Phase 5 + Phase 7）。
 *
 * 供 Desktop renderer 调用（renderer 永远只访问 localhost）：
 * - 同步设置：不同步 / 我的 Nowen Server
 * - 冲突中心：列表、详情、三种解决方式
 * - 诊断信息：Device ID / 游标 / 待同步数 / 冲突数 / 最近错误
 *
 * 产品层刻意不暴露 Full / Lite / SQLite / Server Mode 这些实现概念——
 * 用户只需要理解"是否同步"这一件事。
 */
const app = new Hono();

function guard(c: any): Response | null {
  if (!isLocalFirstSyncV2Enabled()) {
    return c.json({ error: "Sync V2 未启用", code: "SYNC_V2_DISABLED" }, 404);
  }
  if (!c.req.header("X-User-Id")) {
    return c.json({ error: "缺少用户身份", code: "SYNC_V2_UNAUTHORIZED" }, 401);
  }
  return null;
}

function errorResponse(c: any, error: any) {
  const code = error instanceof SyncError && isSyncErrorCode(error.code)
    ? error.code
    : "SERVER_ERROR";
  const status = code === "INVALID_PAYLOAD" ? 400 : 500;
  return c.json(
    { error: error?.message ? String(error.message).slice(0, 200) : code, code },
    status,
  );
}

// ---------------------------------------------------------------------------
// 同步设置
// ---------------------------------------------------------------------------

/**
 * 当前同步配置。
 *
 * 语义只有两种：不同步（仅此设备）/ 已连接某个 Nowen Server。
 * 底层数据模式永远是 Local，这里返回的只是"是否启用了可选同步"。
 */
app.get("/settings", (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const profiles = listProfiles(db).map((profile) => ({
    id: profile.id,
    name: profile.name,
    serverUrl: profile.serverUrl,
    enabled: profile.enabled === 1,
    createdAt: profile.createdAt,
  }));
  const active = profiles.find((profile) => profile.enabled) || null;

  return c.json({
    // mode 只用于 UI 展示，不是数据源开关。
    mode: active ? "server" : "device-only",
    activeProfile: active,
    profiles,
  });
});

/**
 * 连接到一台 Nowen Server。
 *
 * 关键行为：**不会**改写既有 Profile 的 serverUrl。
 * 换服务器一律新建 Profile —— 两台服务器的 sequence 游标、远端用户身份、
 * 设备关系完全无关，复用会导致大量变更被跳过或被误判为已同步。
 */
app.post("/settings/server", async (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  let body: { serverUrl?: unknown; name?: unknown; remoteUserId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON", code: "INVALID_PAYLOAD" }, 400);
  }

  const serverUrl = typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
  if (!/^https?:\/\//i.test(serverUrl)) {
    return c.json({ error: "服务器地址必须以 http(s):// 开头", code: "INVALID_PAYLOAD" }, 400);
  }
  const remoteUserId = typeof body.remoteUserId === "string" ? body.remoteUserId.trim() : null;

  try {
    const run = db.transaction(() => {
      // 已有同服务器同账号的 Profile 就复用，保住它的游标，
      // 避免用户重填一次地址就触发全量重拉。
      const existing = findProfileByServer(db, serverUrl, remoteUserId);
      const profile = existing || createProfile(db, {
        name: typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : new URL(serverUrl).host,
        serverUrl,
        remoteUserId,
      });

      // 切换服务器：停用其他 Profile，但**绝不删除**它们的任何数据。
      for (const other of listProfiles(db)) {
        if (other.id !== profile.id && other.enabled === 1) {
          disableProfile(db, other.id);
        }
      }
      setProfileEnabled(db, profile.id, true);
      const device = ensureDevice(db, {
        profileId: profile.id,
        platform: process.platform,
      });
      return { profile: getProfile(db, profile.id), device };
    });

    const { profile, device } = run();
    logSyncInfo("settings.server-connected", {
      profileId: profile?.id,
      deviceId: device.id,
    });

    return c.json({
      mode: "server",
      profile: profile && {
        id: profile.id,
        name: profile.name,
        serverUrl: profile.serverUrl,
        enabled: profile.enabled === 1,
      },
      deviceId: device.id,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

/**
 * 关闭同步。
 *
 * 只停止同步关系：本地笔记、附件、未同步的 Outbox、冲突记录一个字都不删。
 * 这是「已停止同步，此设备中的全部笔记仍完整保留」的落地点。
 */
app.post("/settings/disable", (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const pendingBefore = countPendingMutations(db);
  const run = db.transaction(() => {
    for (const profile of listProfiles(db)) {
      if (profile.enabled === 1) disableProfile(db, profile.id);
    }
  });
  run();

  return c.json({
    mode: "device-only",
    // 回传保留数量，让 UI 能明确告诉用户"数据都还在"。
    retainedPendingMutations: pendingBefore,
    message: "已停止同步，此设备中的全部笔记仍完整保留。",
  });
});

// ---------------------------------------------------------------------------
// 诊断信息
// ---------------------------------------------------------------------------

/**
 * 同步诊断。
 *
 * 真实用户反馈同步问题时，这一页是唯一能定位的依据，
 * 因此字段要足够但不含任何笔记正文或凭据。
 */
app.get("/diagnostics", (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const active = listProfiles(db).find((profile) => profile.enabled === 1) || null;
  const state = active ? getSyncState(db, active.id, SYNC_PERSONAL_SCOPE_KEY) : null;
  const device = active
    ? db.prepare("SELECT id, deviceName, platform, lastSeenAt FROM sync_devices WHERE profileId = ? LIMIT 1")
      .get(active.id) as { id: string; lastSeenAt: string | null } | undefined
    : undefined;

  // 待同步条目只回传统计与实体标识，不含 payload。
  const pending = listPendingMutations(db, 20, active?.id ?? null).map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
    operation: row.operation,
    status: row.status,
    retryCount: row.retryCount,
    lastError: row.lastError,
    createdAt: row.createdAt,
  }));

  return c.json({
    profileId: active?.id ?? null,
    serverUrl: active?.serverUrl ?? null,
    deviceId: device?.id ?? null,
    lastSeenAt: device?.lastSeenAt ?? null,
    localCursor: state?.lastSequence ?? 0,
    lastSyncAt: state?.lastSyncAt ?? null,
    lastError: state?.lastError ?? null,
    pendingMutations: countPendingMutations(db),
    conflictCount: countUnresolvedConflicts(db),
    pendingSample: pending,
  });
});

// ---------------------------------------------------------------------------
// 冲突中心
// ---------------------------------------------------------------------------

app.get("/conflicts", (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const rows = listUnresolvedConflicts(db);
  return c.json({
    total: rows.length,
    items: rows.map((row) => {
      const detail = toConflictDetail(row);
      // 列表只给摘要：正文可能很大，逐条返回会让页面卡住。
      return {
        id: detail.id,
        entityType: detail.entityType,
        entityId: detail.entityId,
        localVersion: detail.localVersion,
        remoteVersion: detail.remoteVersion,
        createdAt: detail.createdAt,
        diffFields: detail.diffFields,
        localTitle: typeof detail.local?.title === "string" ? detail.local.title : null,
        remoteTitle: typeof detail.remote?.title === "string" ? detail.remote.title : null,
      };
    }),
  });
});

app.get("/conflicts/:id", (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const row = getConflict(db, c.req.param("id"));
  if (!row) return c.json({ error: "冲突不存在", code: "INVALID_PAYLOAD" }, 404);
  return c.json(toConflictDetail(row));
});

/**
 * 解决冲突。
 *
 * 三种方式：keep-local / keep-remote / manual。
 * 无论哪一种，三方内容都继续保留在 sync_conflicts 里，
 * 用户事后发现选错仍能回到详情页取回另一版本。
 */
app.post("/conflicts/:id/resolve", async (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const userId = c.req.header("X-User-Id") as string;

  let body: { resolution?: unknown; mergedPayload?: unknown; deviceId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON", code: "INVALID_PAYLOAD" }, 400);
  }

  const resolution = body.resolution;
  if (resolution !== "keep-local" && resolution !== "keep-remote" && resolution !== "manual") {
    return c.json({ error: "resolution 取值非法", code: "INVALID_PAYLOAD" }, 400);
  }

  const deviceId = typeof body.deviceId === "string" && body.deviceId.trim()
    ? body.deviceId.trim()
    : (db.prepare("SELECT id FROM sync_devices LIMIT 1").get() as { id?: string } | undefined)?.id;
  if (!deviceId) {
    return c.json({ error: "尚未建立同步设备身份", code: "INVALID_PAYLOAD" }, 400);
  }

  try {
    const result = applyConflictResolution(db, {
      conflictId: c.req.param("id"),
      resolution,
      mergedPayload: body.mergedPayload && typeof body.mergedPayload === "object"
        ? body.mergedPayload as Record<string, unknown>
        : undefined,
      deviceId,
      userId,
    });
    return c.json({
      ...result,
      remainingConflicts: countUnresolvedConflicts(db),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

/**
 * 把冲突的某一方另存为新笔记。
 *
 * 仅在用户显式点击时调用。系统绝不自动生成冲突副本——
 * 那会让知识树被大量重复条目淹没。
 */
app.post("/conflicts/:id/fork", async (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const userId = c.req.header("X-User-Id") as string;

  let body: { side?: unknown; deviceId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON", code: "INVALID_PAYLOAD" }, 400);
  }

  const side = body.side === "remote" ? "remote" : "local";
  const deviceId = typeof body.deviceId === "string" && body.deviceId.trim()
    ? body.deviceId.trim()
    : (db.prepare("SELECT id FROM sync_devices LIMIT 1").get() as { id?: string } | undefined)?.id;
  if (!deviceId) {
    return c.json({ error: "尚未建立同步设备身份", code: "INVALID_PAYLOAD" }, 400);
  }

  try {
    const result = forkConflictVersion(db, {
      conflictId: c.req.param("id"),
      side,
      userId,
      deviceId,
    });
    return c.json(result);
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default app;

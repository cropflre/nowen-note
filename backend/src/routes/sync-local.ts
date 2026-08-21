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
  disableAllProfiles,
  findProfileByServer,
  getActiveProfile,
  getProfile,
  getSyncState,
  listProfiles,
  switchActiveProfile,
} from "../sync/profile";
import { ensureDevice, getInstallationDeviceId } from "../sync/device";
import {
  getBootstrapProgress,
  resetBootstrap,
  runBootstrap,
} from "../sync/bootstrap";
import {
  clearRemoteCredential,
  createRemoteClientForProfile,
  hasRemoteCredential,
  saveRemoteCredential,
} from "../sync/credentials";
import {
  getActiveEngine,
  getActiveEngineInfo,
  reconcileSyncEngine,
  stopSyncEngine,
  triggerSyncNow,
} from "../sync/runtime";
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
    // 区分"已配置服务器"与"真在同步"：用户可能填了地址但还没登录，
    // 或 token 已过期。UI 需要据此显示不同引导。
    authorized: active ? hasRemoteCredential(active.id) : false,
    engineRunning: getActiveEngine() !== null,
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
  let body: {
    serverUrl?: unknown;
    name?: unknown;
    remoteUserId?: unknown;
    token?: unknown;
  };
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
  const token = typeof body.token === "string" ? body.token.trim() : "";

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

      // 切换服务器：switchActiveProfile 在事务内先全部停用再启用目标，
      // 保证"最多一个 active"这个不变量在任何时刻都成立。
      // 只改同步开关，**绝不删除**任何 Profile 的数据。
      switchActiveProfile(db, profile.id);
      const device = ensureDevice(db, {
        profileId: profile.id,
        platform: process.platform,
      });
      return { profile: getProfile(db, profile.id), device };
    });

    const { profile, device } = run();

    // 凭据落在事务之外：它是设备本地文件，不参与数据库事务。
    // 只有显式传了 token 才写，避免"仅改名字"的请求把已有凭据清掉。
    if (token && profile) {
      saveRemoteCredential({
        profileId: profile.id,
        serverUrl: profile.serverUrl,
        token,
        remoteUserId,
      });
    }

    logSyncInfo("settings.server-connected", {
      profileId: profile?.id,
      deviceId: device.id,
    });

    // 立即让引擎跟随新配置，用户不需要重启应用。
    // 未授权时返回 null，属正常情况 —— 本地读写始终可用。
    const engine = reconcileSyncEngine(db);

    return c.json({
      mode: "server",
      profile: profile && {
        id: profile.id,
        name: profile.name,
        serverUrl: profile.serverUrl,
        enabled: profile.enabled === 1,
      },
      deviceId: device.id,
      authorized: profile ? hasRemoteCredential(profile.id) : false,
      engineRunning: engine !== null,
      // 未授权时明确告知 UI 该引导用户登录，而不是让它以为同步已就绪。
      message: engine
        ? "已连接，正在同步。"
        : "已保存服务器信息，等待登录授权后开始同步。",
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

  // 先停引擎，再改数据库状态：反过来的话引擎可能在这中间又启动一轮。
  stopSyncEngine();

  // 事务内停用全部 Profile，返回被停用的 ID 供清理凭据。
  const disabledIds = disableAllProfiles(db);

  // 清远端凭据：关闭同步后不该继续持有可用 token。
  // 只清凭据 —— 本地笔记、附件、未同步 Outbox、冲突记录一个字都不动。
  for (const id of disabledIds) {
    try { clearRemoteCredential(id); } catch { /* 凭据文件缺失不影响关闭 */ }
  }

  return c.json({
    mode: "device-only",
    // 回传保留数量，让 UI 能明确告诉用户"数据都还在"。
    retainedPendingMutations: pendingBefore,
    message: "已停止同步，此设备中的全部笔记仍完整保留。",
  });
});

// ---------------------------------------------------------------------------
// 手动触发与引擎状态
// ---------------------------------------------------------------------------

/**
 * 立即同步一次。
 *
 * 引擎未运行时返回 200 + engineRunning=false，而不是错误状态码：
 * "没有开启同步"不是失败，用户的本地保存早已成功（RULE 2）。
 */
app.post("/sync-now", async (c) => {
  const denied = guard(c);
  if (denied) return denied;

  try {
    const status = await triggerSyncNow();
    if (!status) {
      return c.json({
        engineRunning: false,
        message: "当前未开启同步，笔记已保存在此设备。",
      });
    }
    return c.json({ engineRunning: true, status });
  } catch (error) {
    return errorResponse(c, error);
  }
});

/**
 * 引擎实时状态，供状态指示器轮询。
 *
 * 刻意与 /diagnostics 分开：这个端点要足够轻量以便高频轮询，
 * 不做任何统计查询。
 */
app.get("/engine", (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const engine = getActiveEngine();
  const info = getActiveEngineInfo();
  if (!engine || !info) {
    return c.json({
      running: false,
      state: "disabled",
      // 关闭同步时本地依旧是可信的，UI 应显示"已保存"而非任何异常措辞。
      localAuthoritative: true,
    });
  }
  return c.json({
    // 先展开 getStatus()：它自带 profileId / deviceId，
    // 下面的显式字段以运行时管理器为准，避免两处不一致。
    ...engine.getStatus(),
    running: true,
    profileId: info.profileId,
    deviceId: info.deviceId,
    localAuthoritative: true,
  });
});

// ---------------------------------------------------------------------------
// Bootstrap / Reconcile（阶段 D）
// ---------------------------------------------------------------------------

/**
 * 触发（或续跑）首次同步对账。
 *
 * 幂等且可断点续跑：网络中断或应用被强杀后再调一次即可从当前阶段继续。
 * 失败不影响任何本地业务数据 —— 最差情况只是同步没建立起来。
 */
app.post("/bootstrap", async (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const active = getActiveProfile(db);
  if (!active) {
    return c.json(
      { error: "尚未选择同步服务器", code: "SYNC_V2_NO_PROFILE" },
      400,
    );
  }

  const client = createRemoteClientForProfile(active.id, active.serverUrl);
  if (!client) {
    return c.json(
      { error: "尚未完成登录授权，无法开始同步对账", code: "AUTH_EXPIRED" },
      401,
    );
  }

  const userId = c.req.header("X-User-Id") as string;
  const device = ensureDevice(db, { profileId: active.id, platform: process.platform });

  try {
    const progress = await runBootstrap({
      db,
      profileId: active.id,
      deviceId: device.id,
      userId,
      client,
    });
    // 基线建立完成后立刻启动增量引擎，用户无需重启应用。
    const engine = progress.status === "ready" ? reconcileSyncEngine(db) : null;
    return c.json({ ...progress, engineRunning: engine !== null });
  } catch (error) {
    // 失败时把当前阶段回传给 UI，便于显示"在哪一步失败了、可否重试"。
    return c.json(
      {
        ...getBootstrapProgress(db, active.id),
        error: error instanceof Error ? error.message.slice(0, 200) : "SERVER_ERROR",
      },
      500,
    );
  }
});

/** 对账进度，供设置页显示当前阶段与失败原因。 */
app.get("/bootstrap", (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const active = getActiveProfile(db);
  if (!active) {
    return c.json({ status: "pending", mode: "device-only" });
  }
  return c.json({
    ...getBootstrapProgress(db, active.id),
    profileId: active.id,
    serverUrl: active.serverUrl,
  });
});

/**
 * 重置对账状态以便重新建立基线。
 *
 * 用于恢复备份之后（旧游标不再可信）或用户手动重试。
 * 只清对账进度，**不动本地业务数据、不动 Outbox、不动冲突台账**。
 */
app.post("/bootstrap/reset", (c) => {
  const denied = guard(c);
  if (denied) return denied;

  const db = getDb();
  const active = getActiveProfile(db);
  if (!active) {
    return c.json({ error: "尚未选择同步服务器", code: "SYNC_V2_NO_PROFILE" }, 400);
  }
  // 先停引擎：重置后 bootstrapStatus 不再是 ready，引擎不该继续跑。
  stopSyncEngine();
  resetBootstrap(db, active.id);
  return c.json({
    ...getBootstrapProgress(db, active.id),
    message: "已重置同步对账状态，本地数据完整保留。",
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
    ? db.prepare("SELECT deviceId AS id, deviceName, platform, lastSeenAt FROM sync_profile_devices WHERE profileId = ? LIMIT 1")
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
    // 引擎运行时状态：用户报"改了半天没同步"时，
    // 首先要能区分是引擎没跑、没授权，还是推送失败。
    engineRunning: getActiveEngine() !== null,
    engineStatus: getActiveEngine()?.getStatus() ?? null,
    authorized: active ? hasRemoteCredential(active.id) : false,
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
    : getInstallationDeviceId(db) ?? undefined;
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
    : getInstallationDeviceId(db) ?? undefined;
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

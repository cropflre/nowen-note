/**
 * 日历 ICS 镜像导出到 S3 服务
 *
 * 支持将任务日历 ICS 文件上传到 S3 兼容对象存储。
 * 复用 image-hosting.ts 的 S3 签名逻辑，不新增 AWS SDK。
 */

import crypto from "crypto";
import { getDb } from "../db/schema";

// ====== 类型定义 ======

export interface CalendarExportTarget {
  id: string;
  userId: string;
  feedId: string;
  type: string;
  enabled: boolean;
  name: string;
  configJson: string;
  publicUrl: string | null;
  lastExportAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarExportTargetConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathPrefix: string;
  publicBaseUrl: string;
  usePathStyle: boolean;
}

export interface CalendarExportTargetPublic {
  id: string;
  userId: string;
  feedId: string;
  type: string;
  enabled: boolean;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKeySet: boolean;
  pathPrefix: string;
  publicBaseUrl: string;
  usePathStyle: boolean;
  publicUrl: string | null;
  lastExportAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

// ====== 加密工具（复用 image-hosting.ts 逻辑） ======

function getEncryptionKeySource(): { key: string; source: string } {
  const dedicatedKey = process.env.IMAGE_HOSTING_ENCRYPTION_KEY;
  if (dedicatedKey) {
    return { key: dedicatedKey, source: "IMAGE_HOSTING_ENCRYPTION_KEY" };
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (jwtSecret) {
    return { key: jwtSecret, source: "JWT_SECRET" };
  }

  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    throw new Error(
      "[calendar-export] Production environment requires IMAGE_HOSTING_ENCRYPTION_KEY or JWT_SECRET. " +
      "Please set one of these environment variables before using calendar export."
    );
  }

  console.warn(
    "[calendar-export] Neither IMAGE_HOSTING_ENCRYPTION_KEY nor JWT_SECRET is set. " +
    "Using development fallback key. This is NOT safe for production."
  );
  return { key: "nowen-note-dev-fallback-key-not-for-production", source: "development-fallback" };
}

function deriveCipherKey(): Buffer {
  const { key } = getEncryptionKeySource();
  return crypto.scryptSync(key, "nowen-calendar-export-v1", 32);
}

function encryptSecret(plain: string): string {
  if (!plain) return "";
  const key = deriveCipherKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decryptSecret(encoded: string): string {
  if (!encoded || !encoded.startsWith("v1:")) return "";
  try {
    const [, ivB64, tagB64, dataB64] = encoded.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveCipherKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return dec.toString("utf8");
  } catch (err) {
    console.warn("[calendar-export] decrypt secret failed:", err);
    return "";
  }
}

// ====== 配置解析 ======

function parseConfig(configJson: string): CalendarExportTargetConfig {
  const parsed = JSON.parse(configJson || "{}") as Record<string, any>;
  return {
    endpoint: String(parsed.endpoint || "").trim().replace(/\/+$/, ""),
    region: String(parsed.region || "auto").trim() || "auto",
    bucket: String(parsed.bucket || "").trim(),
    accessKeyId: String(parsed.accessKeyId || "").trim(),
    secretAccessKey: decryptSecret(parsed.secretAccessKeyEnc || ""),
    pathPrefix: String(parsed.pathPrefix || "").trim().replace(/^\/+|\/+$/g, ""),
    publicBaseUrl: String(parsed.publicBaseUrl || "").trim().replace(/\/+$/, ""),
    usePathStyle: parsed.usePathStyle !== false,
  };
}

function toPublic(row: CalendarExportTarget): CalendarExportTargetPublic {
  const cfg = parseConfig(row.configJson);
  return {
    id: row.id,
    userId: row.userId,
    feedId: row.feedId,
    type: row.type,
    enabled: !!row.enabled,
    name: row.name,
    endpoint: cfg.endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
    accessKeyId: cfg.accessKeyId,
    secretAccessKeySet: !!cfg.secretAccessKey,
    pathPrefix: cfg.pathPrefix,
    publicBaseUrl: cfg.publicBaseUrl,
    usePathStyle: cfg.usePathStyle,
    publicUrl: row.publicUrl,
    lastExportAt: row.lastExportAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ====== S3 签名上传 ======

function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function buildS3SignedRequest(
  method: string,
  objectKey: string,
  cfg: CalendarExportTargetConfig,
  body?: Buffer,
  contentType?: string,
  extraHeaders?: Record<string, string>,
): { url: string; headers: Record<string, string> } {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

  const endpointUrl = new URL(cfg.endpoint);
  const endpointHost = endpointUrl.host;
  const payloadHash = sha256(body || Buffer.alloc(0));

  // path-style:  https://s3.amazonaws.com/{bucket}/{key}
  // virtual-hosted-style: https://{bucket}.s3.amazonaws.com/{key}
  //
  // 关键：canonicalUri、Host header、真实 URL 必须三者一致。
  let requestHost: string;
  let canonicalUri: string;
  let requestUrl: string;

  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");

  if (cfg.usePathStyle) {
    // path-style: host 不变，路径包含 bucket
    requestHost = endpointHost;
    canonicalUri = `/${cfg.bucket}/${encodedKey}`;
    requestUrl = `${cfg.endpoint}/${cfg.bucket}/${encodedKey}`;
  } else {
    // virtual-hosted-style: host 前缀加 bucket，路径不含 bucket
    requestHost = `${cfg.bucket}.${endpointHost}`;
    canonicalUri = `/${encodedKey}`;
    requestUrl = `${endpointUrl.protocol}//${requestHost}/${encodedKey}`;
  }

  // 构建签名 headers —— 所有参与签名的 header 必须在 canonicalHeaders 中
  const signingHeaders: Record<string, string> = {
    "host": requestHost,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) signingHeaders["content-type"] = contentType;
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      signingHeaders[k.toLowerCase()] = v;
    }
  }

  const sorted = Object.keys(signingHeaders).sort();
  const canonicalHeaders = sorted.map((k) => `${k}:${signingHeaders[k]}\n`).join("");
  const signedHeaders = sorted.join(";");

  const canonicalRequest = [
    method, canonicalUri, "",
    canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, credentialScope,
    sha256(Buffer.from(canonicalRequest)),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, cfg.region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // 输出 headers（不含 host，fetch 会自动设置；但签名里已包含）
  const headers: Record<string, string> = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "Authorization": authorization,
    "Host": requestHost,
  };
  if (contentType) headers["Content-Type"] = contentType;
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers[k] = v;
    }
  }

  return { url: requestUrl, headers };
}

// ====== 导出函数 ======

/** 列出用户的所有 export targets */
export function listExportTargets(userId: string): CalendarExportTargetPublic[] {
  const rows = getDb()
    .prepare("SELECT * FROM calendar_export_targets WHERE userId = ? ORDER BY createdAt DESC")
    .all(userId) as CalendarExportTarget[];
  return rows.map(toPublic);
}

/** 创建 export target */
export function createExportTarget(
  userId: string,
  input: {
    feedId: string;
    name?: string;
    enabled?: boolean;
    endpoint: string;
    region?: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    pathPrefix?: string;
    publicBaseUrl: string;
    forcePathStyle?: boolean;
  },
): CalendarExportTargetPublic {
  // 校验 feed 属于当前用户
  const feed = getDb()
    .prepare("SELECT id FROM task_calendar_feeds WHERE id = ? AND userId = ?")
    .get(input.feedId, userId) as { id: string } | undefined;
  if (!feed) {
    throw new Error("Feed not found or access denied");
  }

  const id = crypto.randomUUID();
  const configJson = JSON.stringify({
    endpoint: input.endpoint.trim().replace(/\/+$/, ""),
    region: (input.region || "auto").trim(),
    bucket: input.bucket.trim(),
    accessKeyId: input.accessKeyId.trim(),
    secretAccessKeyEnc: encryptSecret(input.secretAccessKey),
    pathPrefix: (input.pathPrefix || "").trim().replace(/^\/+|\/+$/g, ""),
    publicBaseUrl: input.publicBaseUrl.trim().replace(/\/+$/, ""),
    usePathStyle: input.forcePathStyle !== false,
  });

  getDb().prepare(`
    INSERT INTO calendar_export_targets (id, userId, feedId, type, enabled, name, configJson)
    VALUES (?, ?, ?, 's3', ?, ?, ?)
  `).run(
    id,
    userId,
    input.feedId,
    input.enabled !== false ? 1 : 0,
    input.name || "",
    configJson,
  );

  const row = getDb()
    .prepare("SELECT * FROM calendar_export_targets WHERE id = ?")
    .get(id) as CalendarExportTarget;
  return toPublic(row);
}

/** 更新 export target */
export function updateExportTarget(
  userId: string,
  targetId: string,
  input: {
    name?: string;
    enabled?: boolean;
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    pathPrefix?: string;
    publicBaseUrl?: string;
    forcePathStyle?: boolean;
  },
): CalendarExportTargetPublic {
  const existing = getDb()
    .prepare("SELECT * FROM calendar_export_targets WHERE id = ? AND userId = ?")
    .get(targetId, userId) as CalendarExportTarget | undefined;
  if (!existing) {
    throw new Error("Export target not found");
  }

  const oldCfg = parseConfig(existing.configJson);
  const newCfg = {
    endpoint: input.endpoint !== undefined ? input.endpoint.trim().replace(/\/+$/, "") : oldCfg.endpoint,
    region: input.region !== undefined ? (input.region || "auto").trim() : oldCfg.region,
    bucket: input.bucket !== undefined ? input.bucket.trim() : oldCfg.bucket,
    accessKeyId: input.accessKeyId !== undefined ? input.accessKeyId.trim() : oldCfg.accessKeyId,
    secretAccessKeyEnc: input.secretAccessKey
      ? encryptSecret(input.secretAccessKey)
      : existing.configJson.includes("secretAccessKeyEnc")
        ? (JSON.parse(existing.configJson).secretAccessKeyEnc || "")
        : "",
    pathPrefix: input.pathPrefix !== undefined ? input.pathPrefix.trim().replace(/^\/+|\/+$/g, "") : oldCfg.pathPrefix,
    publicBaseUrl: input.publicBaseUrl !== undefined ? input.publicBaseUrl.trim().replace(/\/+$/, "") : oldCfg.publicBaseUrl,
    usePathStyle: input.forcePathStyle !== undefined ? input.forcePathStyle !== false : oldCfg.usePathStyle,
  };

  const updates: string[] = [];
  const params: any[] = [];

  if (input.name !== undefined) {
    updates.push("name = ?");
    params.push(input.name);
  }
  if (input.enabled !== undefined) {
    updates.push("enabled = ?");
    params.push(input.enabled ? 1 : 0);
  }

  updates.push("configJson = ?");
  params.push(JSON.stringify(newCfg));
  updates.push("updatedAt = datetime('now')");

  params.push(targetId, userId);
  getDb().prepare(`
    UPDATE calendar_export_targets SET ${updates.join(", ")} WHERE id = ? AND userId = ?
  `).run(...params);

  const row = getDb()
    .prepare("SELECT * FROM calendar_export_targets WHERE id = ?")
    .get(targetId) as CalendarExportTarget;
  return toPublic(row);
}

/** 删除 export target */
export function deleteExportTarget(userId: string, targetId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM calendar_export_targets WHERE id = ? AND userId = ?")
    .run(targetId, userId);
  return result.changes > 0;
}

/** 测试 S3 连接 */
export async function testExportTarget(
  userId: string,
  targetId: string,
): Promise<{ ok: boolean; error?: string }> {
  const row = getDb()
    .prepare("SELECT * FROM calendar_export_targets WHERE id = ? AND userId = ?")
    .get(targetId, userId) as CalendarExportTarget | undefined;
  if (!row) {
    return { ok: false, error: "Export target not found" };
  }

  const cfg = parseConfig(row.configJson);
  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.publicBaseUrl) {
    return { ok: false, error: "Configuration incomplete" };
  }

  try {
    // 上传一个测试文件
    const testContent = Buffer.from("nowen-note calendar export probe");
    const testKey = buildObjectKey(cfg, row.userId, row.feedId, true);
    const { url, headers } = buildS3SignedRequest("PUT", testKey, cfg, testContent, "text/plain");

    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: new Uint8Array(testContent),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      return { ok: false, error: `Upload test failed: HTTP ${res.status} ${errorText}` };
    }

    // 清理测试文件
    try {
      const { url: delUrl, headers: delHeaders } = buildS3SignedRequest("DELETE", testKey, cfg);
      await fetch(delUrl, { method: "DELETE", headers: delHeaders });
    } catch {
      /* best effort */
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || "Test failed" };
  }
}

/** 立即导出 ICS 到 S3 */
export async function exportNow(
  userId: string,
  targetId: string,
): Promise<{ success: boolean; publicUrl?: string; error?: string }> {
  const row = getDb()
    .prepare("SELECT * FROM calendar_export_targets WHERE id = ? AND userId = ?")
    .get(targetId, userId) as CalendarExportTarget | undefined;
  if (!row) {
    return { success: false, error: "Export target not found" };
  }

  // 校验 feed 属于当前用户
  const feed = getDb()
    .prepare("SELECT id, enabled, token FROM task_calendar_feeds WHERE id = ? AND userId = ?")
    .get(row.feedId, userId) as { id: string; enabled: number; token: string } | undefined;
  if (!feed) {
    const error = "Feed not found or access denied";
    updateExportStatus(targetId, "error", error);
    return { success: false, error };
  }

  // 检查 feed 是否启用
  if (!feed.enabled) {
    const error = "Calendar feed is disabled";
    updateExportStatus(targetId, "error", error);
    return { success: false, error };
  }

  const cfg = parseConfig(row.configJson);
  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.publicBaseUrl) {
    const error = "Configuration incomplete";
    updateExportStatus(targetId, "error", error);
    return { success: false, error };
  }

  try {
    // 生成 ICS
    const { buildIcsForToken } = await import("../routes/task-calendar");
    const icsResult = buildIcsForToken(feed.token);
    if (!icsResult) {
      const error = "Failed to generate ICS (feed may be disabled)";
      updateExportStatus(targetId, "error", error);
      return { success: false, error };
    }

    // 上传到 S3
    const objectKey = buildObjectKey(cfg, row.userId, row.feedId, false);
    const icsBuffer = Buffer.from(icsResult.body, "utf-8");
    // Cache-Control 必须参与签名，否则 S3 兼容服务可能返回 SignatureDoesNotMatch
    const { url, headers } = buildS3SignedRequest(
      "PUT", objectKey, cfg, icsBuffer, "text/calendar; charset=utf-8",
      { "cache-control": "public, max-age=300" },
    );

    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: new Uint8Array(icsBuffer),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      const error = `Upload failed: HTTP ${res.status} ${errorText}`;
      updateExportStatus(targetId, "error", error);
      return { success: false, error };
    }

    // 生成公开 URL
    const publicUrl = `${cfg.publicBaseUrl}/${objectKey}`;

    // 更新成功状态
    updateExportStatus(targetId, "success", undefined, publicUrl);

    return { success: true, publicUrl };
  } catch (err: any) {
    const error = err.message || "Export failed";
    updateExportStatus(targetId, "error", error);
    return { success: false, error };
  }
}

// ====== 内部工具函数 ======

/** 构建 S3 对象键 */
function buildObjectKey(
  cfg: CalendarExportTargetConfig,
  userId: string,
  feedId: string,
  isTest: boolean,
): string {
  const prefix = cfg.pathPrefix || "nowen-calendar";
  if (isTest) {
    return `${prefix}/.probe/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`;
  }
  return `${prefix}/${userId}/${feedId}.ics`;
}

/** 更新导出状态 */
function updateExportStatus(
  targetId: string,
  status: "success" | "error",
  error?: string,
  publicUrl?: string,
): void {
  const updates = ["lastStatus = ?", "lastExportAt = datetime('now')", "updatedAt = datetime('now')"];
  const params: any[] = [status];

  if (status === "success" && publicUrl) {
    updates.push("publicUrl = ?");
    params.push(publicUrl);
    updates.push("lastError = NULL");
  } else if (status === "error" && error) {
    updates.push("lastError = ?");
    params.push(error);
  }

  params.push(targetId);
  getDb().prepare(`
    UPDATE calendar_export_targets SET ${updates.join(", ")} WHERE id = ?
  `).run(...params);
}

// ====== 定时导出调度器 ======

/** 模块级状态：防止重复启动和并发执行 */
let schedulerIntervalHandle: ReturnType<typeof setInterval> | null = null;
let isExportRunning = false;

/** 列出所有启用的 export targets */
export function listEnabledExportTargets(): CalendarExportTarget[] {
  return getDb()
    .prepare("SELECT * FROM calendar_export_targets WHERE enabled = 1")
    .all() as CalendarExportTarget[];
}

/**
 * 执行一轮定时导出：遍历所有 enabled targets，逐个调用 exportNow。
 * 返回统计摘要。
 */
export async function runCalendarExportOnce(): Promise<{
  total: number;
  success: number;
  failed: number;
  skipped: number;
}> {
  const targets = listEnabledExportTargets();
  const stats = { total: targets.length, success: 0, failed: 0, skipped: 0 };

  for (const target of targets) {
    try {
      const result = await exportNow(target.userId, target.id);
      if (result.success) {
        stats.success++;
      } else {
        stats.failed++;
        console.warn(`[calendar-export] target ${target.id} failed: ${result.error}`);
      }
    } catch (err: any) {
      stats.failed++;
      console.warn(`[calendar-export] target ${target.id} error: ${err?.message || err}`);
    }
  }

  return stats;
}

/**
 * 启动定时导出调度器。
 *
 * 行为：
 *   - 读取环境变量 CALENDAR_EXPORT_INTERVAL_MINUTES（默认 30，最小 5）
 *   - 读取环境变量 CALENDAR_EXPORT_TIMER_DISABLED=1 可关闭
 *   - NODE_ENV=test 时不启动
 *   - 延迟 15 秒后执行第一轮，之后按 interval 执行
 *   - 同一进程内多次调用不会重复启动
 *   - 上一轮未完成时跳过本轮
 */
export function startCalendarExportScheduler(): void {
  // 测试环境不启动
  if (process.env.NODE_ENV === "test") {
    return;
  }

  // 环境变量关闭
  if (process.env.CALENDAR_EXPORT_TIMER_DISABLED === "1") {
    console.log("[calendar-export] scheduler disabled by CALENDAR_EXPORT_TIMER_DISABLED=1");
    return;
  }

  // 防止重复启动
  if (schedulerIntervalHandle) {
    return;
  }

  // 解析间隔（默认 30 分钟，最小 5 分钟）
  let intervalMinutes = Number(process.env.CALENDAR_EXPORT_INTERVAL_MINUTES) || 30;
  if (intervalMinutes < 5) intervalMinutes = 5;
  const intervalMs = intervalMinutes * 60 * 1000;

  console.log(`[calendar-export] scheduler started, interval=${intervalMinutes} minutes`);

  // 延迟 15 秒后执行第一轮（不阻塞启动流程）
  setTimeout(async () => {
    if (isExportRunning) return;
    isExportRunning = true;
    try {
      const stats = await runCalendarExportOnce();
      if (stats.total > 0) {
        console.log(`[calendar-export] first run: total=${stats.total} success=${stats.success} failed=${stats.failed} skipped=${stats.skipped}`);
      }
    } catch (err: any) {
      console.warn("[calendar-export] first run error:", err?.message || err);
    } finally {
      isExportRunning = false;
    }
  }, 15_000);

  // 定时执行
  schedulerIntervalHandle = setInterval(async () => {
    if (isExportRunning) {
      console.log("[calendar-export] skipping round, previous round still running");
      return;
    }
    isExportRunning = true;
    try {
      const stats = await runCalendarExportOnce();
      if (stats.total > 0) {
        console.log(`[calendar-export] run: total=${stats.total} success=${stats.success} failed=${stats.failed} skipped=${stats.skipped}`);
      }
    } catch (err: any) {
      console.warn("[calendar-export] run error:", err?.message || err);
    } finally {
      isExportRunning = false;
    }
  }, intervalMs);
}

/** 停止定时导出调度器（用于优雅关停） */
export function stopCalendarExportScheduler(): void {
  if (schedulerIntervalHandle) {
    clearInterval(schedulerIntervalHandle);
    schedulerIntervalHandle = null;
    console.log("[calendar-export] scheduler stopped");
  }
}

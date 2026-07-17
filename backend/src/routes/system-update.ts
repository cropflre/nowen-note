import crypto from "crypto";
import fs from "fs";
import { Hono } from "hono";
import type { Context } from "hono";
import { getDb, getDbSchemaVersion, getCodeSchemaVersion } from "../db/schema";
import { verifySudoFromRequest } from "../lib/auth-security";
import { requireAdmin } from "../middleware/acl";
import { systemSettingsRepository } from "../repositories";
import { getBackupManager } from "../services/backup";
import { logAudit } from "../services/audit";
import { getLatestReleasePayload } from "./releases";
import { resolveAppVersion } from "./version";

const router = new Hono();
const UPDATER_URL = (process.env.NOWEN_UPDATER_URL || "http://nowen-note-updater:3002").replace(/\/+$/, "");
const UPDATER_TOKEN = (process.env.NOWEN_UPDATER_TOKEN || "").trim();
const PREFLIGHT_TTL_MS = Math.max(5 * 60_000, Number(process.env.NOWEN_UPDATE_PREFLIGHT_TTL_MS) || 30 * 60_000);
const INTERACTIVE_HEADER = "Nowen-System-Update";
const PREFLIGHT_PREFIX = "system-update:preflight:";

interface StoredPreflight {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  jobId: string | null;
  currentVersion: string;
  targetVersion: string;
  currentImageId: string;
  targetImageId: string;
  targetDigest: string | null;
  backup: {
    filename: string;
    size: number;
    checksum: string;
    schemaVersion: number | null;
    sameVolume: boolean;
  };
  warnings: Array<{ code: string; message: string }>;
}

interface UpdaterPreflight {
  ok: boolean;
  canApply: boolean;
  noOp: boolean;
  targetVersion: string;
  targetImage: string;
  targetImageId: string;
  targetDigest: string | null;
  currentImage: string;
  currentImageId: string;
  currentDigest: string | null;
  architecture: string;
  imageSize: number | null;
  disk: { freeBytes: number | null; totalBytes: number | null; minimumRequiredBytes: number; path: string };
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

const mutationRate = new Map<string, { count: number; resetAt: number }>();

router.use("*", requireAdmin);

function detectDeploymentType(): string {
  const explicit = (process.env.NOWEN_DEPLOYMENT_TYPE || "").trim();
  if (explicit) return explicit;
  const packageType = (process.env.NOWEN_NAS_PACKAGE_TYPE || process.env.NOWEN_PACKAGE_TYPE || "").toLowerCase();
  if (packageType === "fpk" || packageType === "upk") return packageType;
  if (fs.existsSync("/.dockerenv")) return "docker-unmanaged";
  if (process.env.ELECTRON_RUN_AS_NODE || process.env.ELECTRON_USER_DATA) return "desktop-local";
  return "native";
}

function deploymentLabel(type: string): string {
  const labels: Record<string, string> = {
    "docker-compose-managed": "官方 Docker Compose（可托管）",
    "docker-compose-build": "Docker Compose 本地构建",
    "docker-unmanaged": "Docker（非托管）",
    fpk: "飞牛 NAS 应用包（FPK）",
    upk: "绿联 NAS 应用包（UPK）",
    "desktop-local": "桌面端本地服务",
    native: "源码/原生进程",
  };
  return labels[type] || type;
}

function manualGuidance(type: string, latestVersion: string | null): { title: string; steps: string[] } {
  if (type === "fpk" || type === "upk") {
    return {
      title: "请在 NAS 应用中心升级",
      steps: ["不要在容器更新中心操作应用包安装实例。", "前往 NAS 应用中心安装官方新版本，并保留现有数据目录。"],
    };
  }
  if (type === "docker-compose-build") {
    return {
      title: "本地构建部署不支持在线替换",
      steps: ["拉取最新源码。", "运行 docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build。"],
    };
  }
  if (type.startsWith("docker")) {
    const target = latestVersion ? `v${latestVersion}` : "v<目标版本>";
    return {
      title: "手动 Docker 升级",
      steps: [
        `NOWEN_IMAGE_TAG=${target} docker compose pull nowen-note`,
        `NOWEN_IMAGE_TAG=${target} docker compose up -d --no-deps nowen-note`,
        "docker compose logs -f --tail=100 nowen-note",
      ],
    };
  }
  return {
    title: "当前部署类型不支持 Docker 在线升级",
    steps: ["请使用当前平台对应的安装包或发布说明完成升级。"],
  };
}

function parseSemver(input: string): [number, number, number, string] | null {
  const match = input.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ""];
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return left.localeCompare(right);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3].localeCompare(b[3]);
}

function updaterConfigured(): boolean {
  return UPDATER_TOKEN.length >= 32 && !!UPDATER_URL;
}

async function callUpdater<T>(requestPath: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> {
  if (!updaterConfigured()) throw new Error("更新代理未启用或共享密钥长度不足");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${UPDATER_URL}${requestPath}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${UPDATER_TOKEN}`,
        ...(init?.headers || {}),
      },
    });
    const text = await response.text();
    let payload: any = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
    if (!response.ok) throw new Error(payload?.error || `更新代理 HTTP ${response.status}`);
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}

function requireInteractiveMutation(c: Context): Response | null {
  if (c.req.header("X-Auth-Mode") === "api-token") {
    return c.json({ error: "Personal API Token 不允许执行系统在线升级", code: "INTERACTIVE_LOGIN_REQUIRED" }, 403);
  }
  if (c.req.header("X-Requested-With") !== INTERACTIVE_HEADER) {
    return c.json({ error: "缺少系统升级交互标识", code: "INTERACTIVE_HEADER_REQUIRED" }, 403);
  }
  const origin = c.req.header("Origin");
  if (origin && origin !== "null") {
    try {
      const originHost = new URL(origin).host;
      const requestHost = (c.req.header("X-Forwarded-Host") || c.req.header("Host") || "").split(",")[0].trim();
      if (requestHost && originHost !== requestHost) {
        return c.json({ error: "系统升级只允许同源管理界面发起", code: "SAME_ORIGIN_REQUIRED" }, 403);
      }
    } catch {
      return c.json({ error: "Origin 无效", code: "SAME_ORIGIN_REQUIRED" }, 403);
    }
  }

  const userId = c.req.header("X-User-Id") || "unknown";
  const now = Date.now();
  const current = mutationRate.get(userId);
  if (current && current.resetAt > now) {
    current.count += 1;
    if (current.count > 12) return c.json({ error: "系统升级操作过于频繁", code: "RATE_LIMITED" }, 429);
  } else {
    mutationRate.set(userId, { count: 1, resetAt: now + 60_000 });
  }
  return null;
}

function requireSudo(c: Context): Response | null {
  const userId = c.req.header("X-User-Id") || "";
  const row = getDb().prepare("SELECT tokenVersion FROM users WHERE id = ?").get(userId) as { tokenVersion?: number } | undefined;
  const result = verifySudoFromRequest(c, userId, row?.tokenVersion ?? 0);
  if (!result.ok) return c.json({ error: result.message, code: result.code }, result.status as 401 | 403);
  return null;
}

function requestAuditContext(c: Context) {
  return {
    ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "",
    userAgent: c.req.header("user-agent") || "",
  };
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function cleanupPreflights(): void {
  const now = Date.now();
  for (const row of systemSettingsRepository.getByPrefix(PREFLIGHT_PREFIX)) {
    try {
      const parsed = JSON.parse(row.value) as StoredPreflight;
      if (new Date(parsed.expiresAt).getTime() < now - 24 * 60 * 60_000) systemSettingsRepository.delete(row.key);
    } catch {
      systemSettingsRepository.delete(row.key);
    }
  }
}

function readPreflight(id: string): StoredPreflight | null {
  const row = systemSettingsRepository.get(`${PREFLIGHT_PREFIX}${id}`);
  if (!row) return null;
  try { return JSON.parse(row.value) as StoredPreflight; } catch { return null; }
}

function writePreflight(record: StoredPreflight): void {
  systemSettingsRepository.set(`${PREFLIGHT_PREFIX}${record.id}`, JSON.stringify(record));
}

async function buildStatus() {
  const deploymentType = detectDeploymentType();
  const currentVersion = resolveAppVersion();
  const schemaVersion = getDbSchemaVersion();
  const codeSchemaVersion = getCodeSchemaVersion();
  const latest = await getLatestReleasePayload();
  const latestVersion = latest.available && !latest.draft && !latest.prerelease ? latest.version : null;
  const updateAvailable = !!latestVersion && compareSemver(latestVersion, currentVersion) > 0;
  let updater: any = null;
  let updaterError: string | null = null;
  if (updaterConfigured() && deploymentType === "docker-compose-managed") {
    try {
      updater = await callUpdater("/v1/status");
    } catch (error) {
      updaterError = error instanceof Error ? error.message : String(error);
    }
  }

  const blockers: Array<{ code: string; message: string }> = [];
  const warnings: Array<{ code: string; message: string }> = [];
  if (deploymentType !== "docker-compose-managed") {
    blockers.push({ code: "DEPLOYMENT_NOT_MANAGED", message: "当前部署不是官方可托管 Docker Compose 实例" });
  } else if (!updaterConfigured()) {
    blockers.push({ code: "UPDATER_DISABLED", message: "更新代理默认关闭；需配置共享密钥并启用 updater profile" });
  } else if (!updater) {
    blockers.push({ code: "UPDATER_UNAVAILABLE", message: updaterError || "更新代理不可达" });
  }
  if (schemaVersion !== codeSchemaVersion) {
    blockers.push({ code: "SCHEMA_NOT_READY", message: `数据库 Schema 未就绪：${schemaVersion}/${codeSchemaVersion}` });
  }
  if (!latestVersion) blockers.push({ code: "LATEST_RELEASE_UNAVAILABLE", message: "无法确定最新稳定版本" });
  else if (!updateAvailable) warnings.push({ code: "ALREADY_LATEST", message: "当前已经是最新稳定版本" });

  return {
    current: {
      version: currentVersion,
      schemaVersion,
      codeSchemaVersion,
      image: updater?.container?.image || null,
      imageId: updater?.container?.imageId || null,
      digest: updater?.container?.digest || null,
      health: updater?.container?.health || null,
    },
    latest: latest.available ? latest : null,
    deployment: {
      type: deploymentType,
      label: deploymentLabel(deploymentType),
      onlineUpdateEligible: deploymentType === "docker-compose-managed",
    },
    updater: {
      configured: updaterConfigured(),
      available: !!updater,
      error: updaterError,
      details: updater,
    },
    updateAvailable,
    canPreflight: updateAvailable && blockers.length === 0,
    migrationRisk: {
      level: "unknown",
      message: "目标镜像尚未提供可机器校验的迁移兼容元数据；失败时只自动恢复旧镜像，升级前完整备份不会被自动覆盖。",
      rollbackMode: "image-only-with-backup",
      dataRollbackAutomatic: false,
    },
    blockers,
    warnings,
    manualGuidance: manualGuidance(deploymentType, latestVersion),
  };
}

router.get("/status", async (c) => {
  try {
    c.header("Cache-Control", "no-store");
    return c.json(await buildStatus());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

router.post("/preflight", async (c) => {
  const interactiveDenied = requireInteractiveMutation(c);
  if (interactiveDenied) return interactiveDenied;
  const sudoDenied = requireSudo(c);
  if (sudoDenied) return sudoDenied;

  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json().catch(() => ({})) as { targetVersion?: string };
  const status = await buildStatus();
  const latestVersion = status.latest?.available ? status.latest.version : null;
  if (!latestVersion || body.targetVersion !== latestVersion) {
    return c.json({ error: "目标版本必须等于当前最新稳定 Release", code: "TARGET_RELEASE_CHANGED" }, 409);
  }
  if (!status.canPreflight) {
    return c.json({ error: "当前状态不满足升级预检条件", code: "PREFLIGHT_BLOCKED", blockers: status.blockers }, 409);
  }

  let updaterPreflight: UpdaterPreflight;
  try {
    updaterPreflight = await callUpdater<UpdaterPreflight>(
      "/v1/preflight",
      { method: "POST", body: JSON.stringify({ targetVersion: latestVersion }) },
      20 * 60_000,
    );
  } catch (error) {
    logAudit(userId, "system", "docker_update_preflight_failed", { targetVersion: latestVersion, error: String(error) }, {
      ...requestAuditContext(c), targetType: "system-update", targetId: latestVersion, level: "warn",
    });
    return c.json({ error: error instanceof Error ? error.message : String(error), code: "UPDATER_PREFLIGHT_FAILED" }, 409);
  }
  if (updaterPreflight.noOp) return c.json({ ok: true, noOp: true, updater: updaterPreflight });
  if (!updaterPreflight.canApply) {
    return c.json({ error: "更新代理预检未通过", code: "UPDATER_PREFLIGHT_BLOCKED", updater: updaterPreflight }, 409);
  }

  const manager = getBackupManager();
  try {
    const backup = await manager.createBackup({
      type: "full",
      description: `Docker online update ${resolveAppVersion()} -> ${latestVersion}`,
    });
    const backupPath = manager.getBackupPath(backup.filename);
    if (!backupPath) throw new Error("备份文件创建后无法定位");
    const stat = fs.statSync(backupPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size !== backup.size) throw new Error("备份文件大小校验失败");
    const checksum = await sha256File(backupPath);
    if (checksum !== backup.checksum) throw new Error("备份 SHA-256 校验失败");
    const health = manager.getHealth();

    cleanupPreflights();
    const id = crypto.randomUUID();
    const createdAt = new Date();
    const record: StoredPreflight = {
      id,
      userId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + PREFLIGHT_TTL_MS).toISOString(),
      usedAt: null,
      jobId: null,
      currentVersion: resolveAppVersion(),
      targetVersion: latestVersion,
      currentImageId: updaterPreflight.currentImageId,
      targetImageId: updaterPreflight.targetImageId,
      targetDigest: updaterPreflight.targetDigest,
      backup: {
        filename: backup.filename,
        size: backup.size,
        checksum: backup.checksum,
        schemaVersion: backup.schemaVersion ?? getDbSchemaVersion(),
        sameVolume: health.sameVolume,
      },
      warnings: [
        ...updaterPreflight.warnings,
        ...(health.sameVolume
          ? [{ code: "BACKUP_SAME_VOLUME", message: "升级备份与数据目录位于同一物理卷，不能防御卷级故障" }]
          : []),
        { code: "DATA_ROLLBACK_NOT_AUTOMATIC", message: "失败时只自动恢复旧镜像；完整备份保留供人工数据恢复" },
      ],
    };
    writePreflight(record);
    logAudit(userId, "system", "docker_update_preflight_succeeded", {
      preflightId: id,
      currentVersion: record.currentVersion,
      targetVersion: latestVersion,
      targetDigest: record.targetDigest,
      backup: record.backup,
    }, { ...requestAuditContext(c), targetType: "system-update", targetId: id });

    return c.json({
      ok: true,
      noOp: false,
      preflightId: id,
      expiresAt: record.expiresAt,
      currentVersion: record.currentVersion,
      targetVersion: record.targetVersion,
      updater: updaterPreflight,
      backup: record.backup,
      warnings: record.warnings,
      migrationRisk: status.migrationRisk,
    });
  } catch (error) {
    logAudit(userId, "system", "docker_update_backup_failed", { targetVersion: latestVersion, error: String(error) }, {
      ...requestAuditContext(c), targetType: "system-update", targetId: latestVersion, level: "error",
    });
    return c.json({ error: `升级前完整备份失败：${error instanceof Error ? error.message : String(error)}`, code: "BACKUP_REQUIRED" }, 500);
  }
});

router.post("/apply", async (c) => {
  const interactiveDenied = requireInteractiveMutation(c);
  if (interactiveDenied) return interactiveDenied;
  const sudoDenied = requireSudo(c);
  if (sudoDenied) return sudoDenied;

  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json().catch(() => ({})) as {
    preflightId?: string;
    currentVersion?: string;
    targetVersion?: string;
    confirmVersion?: string;
  };
  if (!body.preflightId) return c.json({ error: "缺少 preflightId" }, 400);
  const record = readPreflight(body.preflightId);
  if (!record || record.userId !== userId) return c.json({ error: "预检记录不存在或不属于当前管理员", code: "PREFLIGHT_NOT_FOUND" }, 404);
  if (record.usedAt || record.jobId) return c.json({ error: "该预检记录已使用", code: "PREFLIGHT_ALREADY_USED" }, 409);
  if (new Date(record.expiresAt).getTime() <= Date.now()) return c.json({ error: "预检已过期，请重新预检和备份", code: "PREFLIGHT_EXPIRED" }, 409);
  if (
    body.currentVersion !== record.currentVersion ||
    body.targetVersion !== record.targetVersion ||
    body.confirmVersion !== record.targetVersion ||
    resolveAppVersion() !== record.currentVersion
  ) {
    return c.json({ error: "版本确认不一致或服务端版本已变化", code: "VERSION_CONFIRMATION_MISMATCH" }, 409);
  }
  if (getDbSchemaVersion() !== getCodeSchemaVersion()) {
    return c.json({ error: "数据库 Schema 状态已变化，请重新预检", code: "SCHEMA_NOT_READY" }, 409);
  }

  try {
    const job = await callUpdater<any>("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({
        targetVersion: record.targetVersion,
        targetImageId: record.targetImageId,
        expectedCurrentImageId: record.currentImageId,
        backup: record.backup,
      }),
    }, 30_000);
    record.usedAt = new Date().toISOString();
    record.jobId = job.id;
    writePreflight(record);
    logAudit(userId, "system", "docker_update_started", {
      jobId: job.id,
      preflightId: record.id,
      currentVersion: record.currentVersion,
      targetVersion: record.targetVersion,
      targetDigest: record.targetDigest,
      rollbackMode: "image-only-with-backup",
    }, { ...requestAuditContext(c), targetType: "system-update-job", targetId: job.id, level: "warn" });
    return c.json(job, 202);
  } catch (error) {
    logAudit(userId, "system", "docker_update_start_failed", { preflightId: record.id, error: String(error) }, {
      ...requestAuditContext(c), targetType: "system-update", targetId: record.id, level: "error",
    });
    return c.json({ error: error instanceof Error ? error.message : String(error), code: "UPDATE_START_FAILED" }, 409);
  }
});

router.get("/jobs/:id", async (c) => {
  try {
    return c.json(await callUpdater(`/v1/jobs/${encodeURIComponent(c.req.param("id"))}`));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 503);
  }
});

router.post("/jobs/:id/cancel", async (c) => {
  const interactiveDenied = requireInteractiveMutation(c);
  if (interactiveDenied) return interactiveDenied;
  const sudoDenied = requireSudo(c);
  if (sudoDenied) return sudoDenied;
  const userId = c.req.header("X-User-Id") || "";
  try {
    const job = await callUpdater<any>(`/v1/jobs/${encodeURIComponent(c.req.param("id"))}/cancel`, { method: "POST", body: "{}" });
    logAudit(userId, "system", "docker_update_cancel_requested", { jobId: job.id }, {
      ...requestAuditContext(c), targetType: "system-update-job", targetId: job.id, level: "warn",
    });
    return c.json(job);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
});

export default router;

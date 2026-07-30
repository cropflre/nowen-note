import crypto from "crypto";
import fs from "fs";
import path from "path";

import { getDb } from "../db/schema.js";
import { getBackupManager } from "./backup.js";

const CONFIG_KEY = "backup:webdav";
const STATUS_KEY = "backup:webdav:status";
const DEFAULT_REMOTE_PATH = "nowen-note/backups";
const TEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

export interface BackupWebDavConfigInput {
  enabled?: boolean;
  endpoint?: string;
  username?: string;
  password?: string;
  clearPassword?: boolean;
  remotePath?: string;
  uploadOnAutoBackup?: boolean;
}

interface StoredBackupWebDavConfig {
  enabled: boolean;
  endpoint: string;
  username: string;
  passwordEnc: string;
  remotePath: string;
  uploadOnAutoBackup: boolean;
  updatedAt: string;
}

export interface BackupWebDavStatus {
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastUploadAt: string | null;
  lastFilename: string | null;
  lastError: string | null;
}

export interface BackupWebDavPublicConfig {
  enabled: boolean;
  configured: boolean;
  endpoint: string;
  username: string;
  passwordSet: boolean;
  remotePath: string;
  uploadOnAutoBackup: boolean;
  insecureHttp: boolean;
  status: BackupWebDavStatus;
}

interface ResolvedBackupWebDavConfig {
  enabled: boolean;
  endpoint: string;
  username: string;
  password: string;
  remotePath: string;
  uploadOnAutoBackup: boolean;
}

const EMPTY_STATUS: BackupWebDavStatus = {
  lastTestAt: null,
  lastTestOk: null,
  lastUploadAt: null,
  lastFilename: null,
  lastError: null,
};

function readSetting(key: string): string | null {
  try {
    const row = getDb().prepare("SELECT value FROM system_settings WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')
  `).run(key, value);
}

function deleteSetting(key: string): void {
  getDb().prepare("DELETE FROM system_settings WHERE key = ?").run(key);
}

function normalizeEndpoint(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("WebDAV 地址格式不合法");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("WebDAV 地址仅支持 http:// 或 https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("请不要把账号密码写在 WebDAV URL 中");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("WebDAV 地址不能包含查询参数或锚点");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "/" : "");
}

function normalizeRemotePath(value: unknown): string {
  const raw = String(value ?? DEFAULT_REMOTE_PATH)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
  if (!raw) return "";
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f]/.test(segment))) {
    throw new Error("远端目录格式不合法");
  }
  return segments.join("/");
}

function keySource(): string {
  const dedicated = process.env.BACKUP_WEBDAV_ENCRYPTION_KEY;
  if (dedicated) return dedicated;
  const jwt = process.env.JWT_SECRET;
  if (jwt) return jwt;
  try {
    const secretPath = path.join(getBackupManager().getDataDir(), ".jwt_secret");
    const stored = fs.readFileSync(secretPath, "utf8").trim();
    if (stored) return stored;
  } catch {
    // Development/test installations may not have persisted the secret yet.
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置 BACKUP_WEBDAV_ENCRYPTION_KEY 或 JWT_SECRET");
  }
  return "nowen-note-webdav-development-key";
}

function encryptionKey(): Buffer {
  return crypto.scryptSync(keySource(), "nowen-backup-webdav-v1", 32);
}

function encryptSecret(value: string): string {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value: string): string {
  if (!value) return "";
  if (!value.startsWith("v1:")) return "";
  try {
    const [, iv, tag, encrypted] = value.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("WebDAV 密码解密失败，请重新保存配置");
  }
}

function loadStoredConfig(): StoredBackupWebDavConfig {
  const defaults: StoredBackupWebDavConfig = {
    enabled: false,
    endpoint: "",
    username: "",
    passwordEnc: "",
    remotePath: DEFAULT_REMOTE_PATH,
    uploadOnAutoBackup: false,
    updatedAt: new Date(0).toISOString(),
  };
  const raw = readSetting(CONFIG_KEY);
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredBackupWebDavConfig>;
    return {
      enabled: parsed.enabled === true,
      endpoint: normalizeEndpoint(parsed.endpoint || ""),
      username: String(parsed.username || "").trim(),
      passwordEnc: typeof parsed.passwordEnc === "string" ? parsed.passwordEnc : "",
      remotePath: normalizeRemotePath(parsed.remotePath ?? DEFAULT_REMOTE_PATH),
      uploadOnAutoBackup: parsed.uploadOnAutoBackup === true,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch (error) {
    console.warn("[backup-webdav] invalid stored config:", error instanceof Error ? error.message : error);
    return defaults;
  }
}

function loadStatus(): BackupWebDavStatus {
  const raw = readSetting(STATUS_KEY);
  if (!raw) return { ...EMPTY_STATUS };
  try {
    const parsed = JSON.parse(raw) as Partial<BackupWebDavStatus>;
    return {
      lastTestAt: typeof parsed.lastTestAt === "string" ? parsed.lastTestAt : null,
      lastTestOk: typeof parsed.lastTestOk === "boolean" ? parsed.lastTestOk : null,
      lastUploadAt: typeof parsed.lastUploadAt === "string" ? parsed.lastUploadAt : null,
      lastFilename: typeof parsed.lastFilename === "string" ? parsed.lastFilename : null,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
    };
  } catch {
    return { ...EMPTY_STATUS };
  }
}

function patchStatus(patch: Partial<BackupWebDavStatus>): BackupWebDavStatus {
  const status = { ...loadStatus(), ...patch };
  writeSetting(STATUS_KEY, JSON.stringify(status));
  return status;
}

function resolveConfig(input?: BackupWebDavConfigInput): ResolvedBackupWebDavConfig {
  const stored = loadStoredConfig();
  const endpoint = normalizeEndpoint(input?.endpoint ?? stored.endpoint);
  const remotePath = normalizeRemotePath(input?.remotePath ?? stored.remotePath);
  const username = String(input?.username ?? stored.username).trim();
  let password = decryptSecret(stored.passwordEnc);
  if (input?.clearPassword === true) password = "";
  if (typeof input?.password === "string" && input.password.length > 0) password = input.password;
  return {
    enabled: input?.enabled ?? stored.enabled,
    endpoint,
    username,
    password,
    remotePath,
    uploadOnAutoBackup: input?.uploadOnAutoBackup ?? stored.uploadOnAutoBackup,
  };
}

function validateResolvedConfig(config: ResolvedBackupWebDavConfig): void {
  if (!config.endpoint) throw new Error("请填写 WebDAV 地址");
  if (config.username && !config.password) throw new Error("已填写 WebDAV 用户名，请同时填写密码");
}

export function getBackupWebDavConfig(): BackupWebDavPublicConfig {
  const stored = loadStoredConfig();
  return {
    enabled: stored.enabled,
    configured: Boolean(stored.endpoint),
    endpoint: stored.endpoint,
    username: stored.username,
    passwordSet: Boolean(stored.passwordEnc),
    remotePath: stored.remotePath,
    uploadOnAutoBackup: stored.uploadOnAutoBackup,
    insecureHttp: stored.endpoint.startsWith("http://"),
    status: loadStatus(),
  };
}

export function saveBackupWebDavConfig(input: BackupWebDavConfigInput): BackupWebDavPublicConfig {
  const previous = loadStoredConfig();
  const resolved = resolveConfig(input);
  if (resolved.enabled || resolved.endpoint) validateResolvedConfig(resolved);

  let passwordEnc = previous.passwordEnc;
  if (input.clearPassword === true) passwordEnc = "";
  if (typeof input.password === "string" && input.password.length > 0) {
    passwordEnc = encryptSecret(input.password);
  }

  const stored: StoredBackupWebDavConfig = {
    enabled: resolved.enabled,
    endpoint: resolved.endpoint,
    username: resolved.username,
    passwordEnc,
    remotePath: resolved.remotePath,
    uploadOnAutoBackup: resolved.uploadOnAutoBackup,
    updatedAt: new Date().toISOString(),
  };
  writeSetting(CONFIG_KEY, JSON.stringify(stored));
  return getBackupWebDavConfig();
}

export function clearBackupWebDavConfig(): BackupWebDavPublicConfig {
  deleteSetting(CONFIG_KEY);
  deleteSetting(STATUS_KEY);
  return getBackupWebDavConfig();
}

function authHeaders(config: ResolvedBackupWebDavConfig): Record<string, string> {
  if (!config.username && !config.password) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`,
  };
}

async function timedFetch(
  url: string,
  config: ResolvedBackupWebDavConfig,
  init: RequestInit & { duplex?: "half" },
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      headers: {
        ...authHeaders(config),
        ...(init.headers || {}),
      },
      redirect: "follow",
      signal: controller.signal,
    } as RequestInit);
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      throw new Error("WebDAV 请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function remoteDirectoryUrl(config: ResolvedBackupWebDavConfig): string {
  let current = ensureTrailingSlash(config.endpoint);
  for (const segment of config.remotePath.split("/").filter(Boolean)) {
    current = new URL(`${encodeURIComponent(segment)}/`, current).toString();
  }
  return current;
}

async function propfind(url: string, config: ResolvedBackupWebDavConfig): Promise<Response> {
  return timedFetch(url, config, {
    method: "PROPFIND",
    headers: {
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
  }, TEST_TIMEOUT_MS);
}

async function ensureRemoteDirectory(config: ResolvedBackupWebDavConfig): Promise<string> {
  validateResolvedConfig(config);
  const root = ensureTrailingSlash(config.endpoint);
  const rootProbe = await propfind(root, config);
  if (![200, 207].includes(rootProbe.status)) {
    throw new Error(`WebDAV 根目录不可访问（HTTP ${rootProbe.status}）`);
  }

  let current = root;
  for (const segment of config.remotePath.split("/").filter(Boolean)) {
    current = new URL(`${encodeURIComponent(segment)}/`, current).toString();
    const response = await timedFetch(current, config, { method: "MKCOL" }, TEST_TIMEOUT_MS);
    if (![200, 201, 204, 301, 302, 405].includes(response.status)) {
      throw new Error(`创建 WebDAV 目录失败（HTTP ${response.status}）`);
    }
  }

  const finalProbe = await propfind(current, config);
  if (![200, 207].includes(finalProbe.status)) {
    throw new Error(`WebDAV 目标目录不可访问（HTTP ${finalProbe.status}）`);
  }
  return current;
}

export async function testBackupWebDavConnection(input?: BackupWebDavConfigInput): Promise<BackupWebDavPublicConfig> {
  const config = resolveConfig(input);
  const now = new Date().toISOString();
  try {
    await ensureRemoteDirectory(config);
    patchStatus({ lastTestAt: now, lastTestOk: true, lastError: null });
    return getBackupWebDavConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    patchStatus({ lastTestAt: now, lastTestOk: false, lastError: message });
    throw error;
  }
}

async function putFile(url: string, filePath: string, config: ResolvedBackupWebDavConfig): Promise<Response> {
  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = ext === ".zip" ? "application/zip" : "application/octet-stream";
  return timedFetch(url, config, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
    },
    body: stream as unknown as BodyInit,
    duplex: "half",
  }, UPLOAD_TIMEOUT_MS);
}

async function deleteRemoteBestEffort(url: string, config: ResolvedBackupWebDavConfig): Promise<void> {
  try {
    await timedFetch(url, config, { method: "DELETE" }, TEST_TIMEOUT_MS);
  } catch {
    // Cleanup failures must not hide the actual upload result.
  }
}

export async function uploadBackupToWebDav(
  filename: string,
  options: { requireEnabled?: boolean } = {},
): Promise<{ filename: string; remoteUrl: string; size: number }> {
  const config = resolveConfig();
  validateResolvedConfig(config);
  if (options.requireEnabled !== false && !config.enabled) {
    throw new Error("WebDAV 备份通道尚未启用");
  }

  const manager = getBackupManager();
  const filePath = manager.getBackupPath(filename);
  if (!filePath || !fs.existsSync(filePath)) throw new Error("本地备份文件不存在");

  const directory = await ensureRemoteDirectory(config);
  const targetUrl = new URL(encodeURIComponent(filename), directory).toString();
  const tempName = `.${filename}.upload-${crypto.randomUUID()}`;
  const tempUrl = new URL(encodeURIComponent(tempName), directory).toString();
  const stat = fs.statSync(filePath);

  try {
    const uploaded = await putFile(tempUrl, filePath, config);
    if (![200, 201, 204].includes(uploaded.status)) {
      throw new Error(`WebDAV 上传失败（HTTP ${uploaded.status}）`);
    }

    const moved = await timedFetch(tempUrl, config, {
      method: "MOVE",
      headers: {
        Destination: targetUrl,
        Overwrite: "T",
      },
    }, TEST_TIMEOUT_MS);

    if (![200, 201, 204].includes(moved.status)) {
      // A few WebDAV providers do not implement MOVE. Fall back to a direct PUT while
      // retaining the temporary-object strategy for providers that do support it.
      const fallback = await putFile(targetUrl, filePath, config);
      if (![200, 201, 204].includes(fallback.status)) {
        throw new Error(`WebDAV 最终写入失败（HTTP ${fallback.status}）`);
      }
      await deleteRemoteBestEffort(tempUrl, config);
    }

    patchStatus({
      lastUploadAt: new Date().toISOString(),
      lastFilename: filename,
      lastError: null,
    });
    return { filename, remoteUrl: targetUrl, size: stat.size };
  } catch (error) {
    await deleteRemoteBestEffort(tempUrl, config);
    const message = error instanceof Error ? error.message : String(error);
    patchStatus({ lastError: message });
    throw error;
  }
}

export async function uploadAutomaticBackupToWebDav(filename: string): Promise<boolean> {
  const config = resolveConfig();
  if (!config.enabled || !config.uploadOnAutoBackup) return false;
  await uploadBackupToWebDav(filename);
  return true;
}

export function getBackupWebDavRemoteDirectory(): string | null {
  const config = resolveConfig();
  if (!config.endpoint) return null;
  return remoteDirectoryUrl(config);
}

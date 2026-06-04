import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDb } from "../db/schema";

const SETTING_KEY = "attachmentStorage:config";
const DATA_DIR = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
const ATTACHMENTS_DIR = path.join(DATA_DIR, "attachments");

type StorageDriver = "local" | "s3";

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export interface ObjectStorageConfigPublic {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  prefix: string;
  secretAccessKeySet: boolean;
  source: "settings" | "env" | "default";
  updatedAt: string | null;
}

export interface WriteObjectStorageConfigInput {
  enabled: boolean;
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey?: string;
  prefix?: string;
}

export interface AttachmentStorageInfo {
  driver: StorageDriver;
  localDir: string;
  bucket?: string;
  endpoint?: string;
  prefix?: string;
  migrationCommand?: string;
}

function env(name: string): string {
  return (process.env[name] || "").trim();
}

function deriveCipherKey(): Buffer {
  const secret = process.env.JWT_SECRET || "nowen-note-default-secret";
  return crypto.scryptSync(secret, "nowen-attachment-storage-v1", 32);
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
    console.warn("[attachment-storage] decrypt secret failed:", err);
    return "";
  }
}

function getDriver(): StorageDriver {
  const raw = env("ATTACHMENT_STORAGE").toLowerCase();
  return raw === "s3" || raw === "r2" || raw === "minio" ? "s3" : "local";
}

function getEnvS3Config(): (S3Config & { updatedAt: null }) | null {
  if (getDriver() !== "s3") return null;
  const endpoint = env("S3_ENDPOINT").replace(/\/+$/, "");
  const region = env("S3_REGION") || "auto";
  const bucket = env("S3_BUCKET");
  const accessKeyId = env("S3_ACCESS_KEY_ID");
  const secretAccessKey = env("S3_SECRET_ACCESS_KEY");
  const prefix = env("S3_PREFIX").replace(/^\/+|\/+$/g, "");
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    console.warn("[attachment-storage] S3 mode is incomplete; falling back to local storage");
    return null;
  }
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, prefix, updatedAt: null };
}

function readPersistedObjectStorageConfig(): (S3Config & { enabled: boolean; updatedAt: string | null }) | null {
  try {
    const row = getDb()
      .prepare("SELECT value, updatedAt FROM system_settings WHERE key = ?")
      .get(SETTING_KEY) as { value: string; updatedAt: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value || "{}") as Partial<S3Config> & {
      enabled?: boolean;
      secretAccessKeyEnc?: string;
    };
    return {
      enabled: parsed.enabled === true,
      endpoint: String(parsed.endpoint || "").trim().replace(/\/+$/, ""),
      region: String(parsed.region || "auto").trim() || "auto",
      bucket: String(parsed.bucket || "").trim(),
      accessKeyId: String(parsed.accessKeyId || "").trim(),
      secretAccessKey: decryptSecret(parsed.secretAccessKeyEnc || ""),
      prefix: String(parsed.prefix || "").trim().replace(/^\/+|\/+$/g, ""),
      updatedAt: row.updatedAt || null,
    };
  } catch (err) {
    console.warn("[attachment-storage] read persisted config failed:", err);
    return null;
  }
}

function getS3Config(): S3Config | null {
  const saved = readPersistedObjectStorageConfig();
  if (saved) {
    if (!saved.enabled) return null;
    if (!saved.endpoint || !saved.bucket || !saved.accessKeyId || !saved.secretAccessKey) {
      console.warn("[attachment-storage] saved S3 mode is incomplete; falling back to local storage");
      return null;
    }
    return saved;
  }
  return getEnvS3Config();
}

function encodePathSegment(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function objectKey(relPath: string, cfg: S3Config): string {
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const key = cfg.prefix ? `${cfg.prefix}/${clean}` : clean;
  return key
    .split("/")
    .filter(Boolean)
    .map(encodePathSegment)
    .join("/");
}

function objectUrl(relPath: string, cfg: S3Config): URL {
  return new URL(`${cfg.endpoint}/${encodePathSegment(cfg.bucket)}/${objectKey(relPath, cfg)}`);
}

async function sha256Hex(data: Buffer | string): Promise<string> {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function amzDate(date: Date): string {
  return `${yyyymmdd(date)}T${date.toISOString().slice(11, 19).replace(/:/g, "")}Z`;
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

async function signedFetch(
  method: "GET" | "PUT" | "DELETE" | "HEAD",
  relPath: string,
  cfg: S3Config,
  body?: Buffer,
  contentType?: string,
): Promise<Response> {
  const url = objectUrl(relPath, cfg);
  const now = new Date();
  const date = yyyymmdd(now);
  const payloadHash = body ? await sha256Hex(body) : await sha256Hex("");
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate(now),
  };
  if (contentType) headers["content-type"] = contentType;

  const sorted = Object.keys(headers).sort();
  const canonicalHeaders = sorted.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = sorted.join(";");
  const canonicalRequest = [
    method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    headers["x-amz-date"],
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = crypto
    .createHmac("sha256", signingKey(cfg.secretAccessKey, date, cfg.region))
    .update(stringToSign)
    .digest("hex");

  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: body as BodyInit | undefined,
  });
  return res;
}

export function ensureAttachmentsDir(): string {
  if (!fs.existsSync(ATTACHMENTS_DIR)) {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }
  return ATTACHMENTS_DIR;
}

export function getAttachmentsDir(): string {
  return ATTACHMENTS_DIR;
}

export function getAttachmentStorageInfo(): AttachmentStorageInfo {
  const cfg = getS3Config();
  if (!cfg) return { driver: "local", localDir: ATTACHMENTS_DIR };
  return {
    driver: "s3",
    localDir: ATTACHMENTS_DIR,
    bucket: cfg.bucket,
    endpoint: cfg.endpoint,
    prefix: cfg.prefix,
    migrationCommand: "npm run migrate:attachments:object -- --dry-run",
  };
}

export function readObjectStorageConfigPublic(): ObjectStorageConfigPublic {
  const saved = readPersistedObjectStorageConfig();
  if (saved) {
    return {
      enabled: saved.enabled,
      endpoint: saved.endpoint,
      region: saved.region,
      bucket: saved.bucket,
      accessKeyId: saved.accessKeyId,
      prefix: saved.prefix,
      secretAccessKeySet: !!saved.secretAccessKey,
      source: "settings",
      updatedAt: saved.updatedAt,
    };
  }

  const envCfg = getEnvS3Config();
  if (envCfg) {
    return {
      enabled: true,
      endpoint: envCfg.endpoint,
      region: envCfg.region,
      bucket: envCfg.bucket,
      accessKeyId: envCfg.accessKeyId,
      prefix: envCfg.prefix,
      secretAccessKeySet: !!envCfg.secretAccessKey,
      source: "env",
      updatedAt: null,
    };
  }

  return {
    enabled: false,
    endpoint: "",
    region: "auto",
    bucket: "",
    accessKeyId: "",
    prefix: "",
    secretAccessKeySet: false,
    source: "default",
    updatedAt: null,
  };
}

export function writeObjectStorageConfig(input: WriteObjectStorageConfigInput): ObjectStorageConfigPublic {
  const current = readPersistedObjectStorageConfig();
  const secretAccessKey =
    input.secretAccessKey === undefined ? current?.secretAccessKey || "" : input.secretAccessKey;
  const value = JSON.stringify({
    enabled: !!input.enabled,
    endpoint: (input.endpoint || "").trim().replace(/\/+$/, ""),
    region: (input.region || "auto").trim() || "auto",
    bucket: (input.bucket || "").trim(),
    accessKeyId: (input.accessKeyId || "").trim(),
    secretAccessKeyEnc: secretAccessKey ? encryptSecret(secretAccessKey) : "",
    prefix: (input.prefix || "").trim().replace(/^\/+|\/+$/g, ""),
  });

  getDb()
    .prepare(
      `INSERT INTO system_settings (key, value, updatedAt)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')`,
    )
    .run(SETTING_KEY, value);

  return readObjectStorageConfigPublic();
}

export async function testObjectStorageConfig(): Promise<{ ok: boolean; error?: string }> {
  const cfg = getS3Config();
  if (!cfg) return { ok: false, error: "object storage is not enabled or config is incomplete" };
  const probe = `.nowen-note-probe/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`;
  try {
    const put = await signedFetch("PUT", probe, cfg, Buffer.from("nowen-note object storage probe"), "text/plain");
    if (!put.ok) {
      return { ok: false, error: `PUT failed: ${put.status} ${await put.text().catch(() => "")}` };
    }
    const del = await signedFetch("DELETE", probe, cfg);
    if (!del.ok && del.status !== 404) {
      return { ok: false, error: `DELETE failed: ${del.status} ${await del.text().catch(() => "")}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export function isObjectAttachmentStorageEnabled(): boolean {
  return !!getS3Config();
}

export function getLocalAttachmentPath(relPath: string): string {
  return path.join(ATTACHMENTS_DIR, relPath);
}

export async function writeAttachmentObject(
  relPath: string,
  buffer: Buffer,
  contentType?: string,
): Promise<void> {
  const cfg = getS3Config();
  if (!cfg) {
    ensureAttachmentsDir();
    fs.writeFileSync(getLocalAttachmentPath(relPath), buffer);
    return;
  }
  const res = await signedFetch("PUT", relPath, cfg, buffer, contentType);
  if (!res.ok) {
    throw new Error(`S3 PUT failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

export async function readAttachmentObject(relPath: string): Promise<Buffer | null> {
  const cfg = getS3Config();
  if (!cfg) {
    const abs = getLocalAttachmentPath(relPath);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs);
  }
  const res = await signedFetch("GET", relPath, cfg);
  if (res.status === 404) {
    const abs = getLocalAttachmentPath(relPath);
    return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  }
  if (!res.ok) {
    throw new Error(`S3 GET failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function checkAttachmentObjectExists(relPath: string): Promise<{ exists: boolean; status?: number; error?: string }> {
  const cfg = getS3Config();
  if (!cfg) {
    return { exists: fs.existsSync(getLocalAttachmentPath(relPath)) };
  }
  try {
    const res = await signedFetch("HEAD", relPath, cfg);
    if (res.ok) return { exists: true, status: res.status };
    if (res.status === 404) return { exists: false, status: res.status };
    return { exists: false, status: res.status, error: await res.text().catch(() => "") };
  } catch (err: any) {
    return { exists: false, error: err?.message || String(err) };
  }
}

export async function deleteAttachmentObject(relPath: string): Promise<void> {
  const cfg = getS3Config();
  if (cfg) {
    const res = await signedFetch("DELETE", relPath, cfg);
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DELETE failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }
  const abs = getLocalAttachmentPath(relPath);
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    /* best effort */
  }
}

export function readLocalAttachmentIfExists(relPath: string): Buffer | null {
  const abs = getLocalAttachmentPath(relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

import crypto from "crypto";
import fs from "fs";
import path from "path";

import type { DatabaseAdapter } from "../db/adapters/types";
import { deleteThumbnailsFor } from "./thumbnails";

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

interface PersistedSettingRow {
  value: string;
}

export interface AttachmentDeletionCandidate {
  id: string;
  path: string;
}

export interface AttachmentDeletionCleanupResult {
  removedFiles: number;
  skippedSharedPaths: number;
  warnings: string[];
}

function env(name: string): string {
  return (process.env[name] || "").trim();
}

function getDriver(): StorageDriver {
  const raw = env("ATTACHMENT_STORAGE").toLowerCase();
  return raw === "s3" || raw === "r2" || raw === "minio" ? "s3" : "local";
}

function deriveCipherKey(): Buffer {
  const secret = process.env.JWT_SECRET || "nowen-note-default-secret";
  return crypto.scryptSync(secret, "nowen-attachment-storage-v1", 32);
}

function decryptSecret(encoded: string): string {
  if (!encoded || !encoded.startsWith("v1:")) return "";
  try {
    const [, ivB64, tagB64, dataB64] = encoded.split(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      deriveCipherKey(),
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    console.warn("[attachment-deletion-runtime] decrypt secret failed:", error);
    return "";
  }
}

function getEnvS3Config(): S3Config | null {
  if (getDriver() !== "s3") return null;
  const config: S3Config = {
    endpoint: env("S3_ENDPOINT").replace(/\/+$/, ""),
    region: env("S3_REGION") || "auto",
    bucket: env("S3_BUCKET"),
    accessKeyId: env("S3_ACCESS_KEY_ID"),
    secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
    prefix: env("S3_PREFIX").replace(/^\/+|\/+$/g, ""),
  };
  return config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey
    ? config
    : null;
}

function parsePersistedS3Config(value: string): (S3Config & { enabled: boolean }) | null {
  try {
    const parsed = JSON.parse(value || "{}") as Partial<S3Config> & {
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
    };
  } catch (error) {
    console.warn("[attachment-deletion-runtime] parse persisted storage config failed:", error);
    return null;
  }
}

async function resolveS3Config(adapter: DatabaseAdapter): Promise<S3Config | null> {
  try {
    const row = await adapter.queryOne<PersistedSettingRow>(
      "SELECT value FROM system_settings WHERE key = ?",
      [SETTING_KEY],
    );
    if (row) {
      const saved = parsePersistedS3Config(row.value);
      if (!saved?.enabled) return null;
      if (saved.endpoint && saved.bucket && saved.accessKeyId && saved.secretAccessKey) {
        return saved;
      }
      console.warn("[attachment-deletion-runtime] persisted S3 config is incomplete; using local cleanup");
      return null;
    }
  } catch (error) {
    console.warn("[attachment-deletion-runtime] read storage config failed; falling back to env:", error);
  }
  return getEnvS3Config();
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function objectKey(relPath: string, config: S3Config): string {
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const key = config.prefix ? `${config.prefix}/${clean}` : clean;
  return key.split("/").filter(Boolean).map(encodePathSegment).join("/");
}

function objectUrl(relPath: string, config: S3Config): URL {
  return new URL(
    `${config.endpoint}/${encodePathSegment(config.bucket)}/${objectKey(relPath, config)}`,
  );
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

async function deleteS3Object(relPath: string, config: S3Config): Promise<boolean> {
  const url = objectUrl(relPath, config);
  const now = new Date();
  const date = yyyymmdd(now);
  const payloadHash = crypto.createHash("sha256").update("").digest("hex");
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate(now),
  };
  const sorted = Object.keys(headers).sort();
  const canonicalHeaders = sorted.map((key) => `${key}:${headers[key]}\n`).join("");
  const signedHeaders = sorted.join(";");
  const canonicalRequest = [
    "DELETE",
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    headers["x-amz-date"],
    scope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signature = crypto
    .createHmac("sha256", signingKey(config.secretAccessKey, date, config.region))
    .update(stringToSign)
    .digest("hex");
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`S3 DELETE failed: ${response.status} ${await response.text().catch(() => "")}`);
  }
  return true;
}

function isSafeAttachmentRelPath(relPath: string): boolean {
  if (!relPath || relPath.includes("\\") || relPath.startsWith("/") || relPath.includes("..")) {
    return false;
  }
  return (
    /^[0-9a-f-]{36}\.[a-zA-Z0-9]{1,8}$/.test(relPath)
    || /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-zA-Z0-9]{1,8}$/.test(relPath)
  );
}

function deleteLocalObject(relPath: string): boolean {
  const absolutePath = path.join(ATTACHMENTS_DIR, relPath);
  if (!fs.existsSync(absolutePath)) return false;
  fs.unlinkSync(absolutePath);
  return true;
}

export async function cleanupDeletedNoteAttachments(
  adapter: DatabaseAdapter,
  candidates: AttachmentDeletionCandidate[],
): Promise<AttachmentDeletionCleanupResult> {
  const warnings: string[] = [];
  const uniquePaths = new Map<string, AttachmentDeletionCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.id) deleteThumbnailsFor(ATTACHMENTS_DIR, candidate.id);
    if (!candidate.path) continue;
    const list = uniquePaths.get(candidate.path) || [];
    list.push(candidate);
    uniquePaths.set(candidate.path, list);
  }

  const s3Config = await resolveS3Config(adapter);
  let removedFiles = 0;
  let skippedSharedPaths = 0;
  for (const [relPath] of uniquePaths) {
    if (!isSafeAttachmentRelPath(relPath)) {
      warnings.push(`unsafe attachment path skipped: ${relPath}`);
      continue;
    }

    try {
      const liveReference = await adapter.queryOne<{ id: string }>(
        "SELECT id FROM attachments WHERE path = ? LIMIT 1",
        [relPath],
      );
      if (liveReference) {
        skippedSharedPaths++;
        continue;
      }
    } catch (error) {
      warnings.push(
        `attachment reference recheck failed for ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    try {
      const removedRemote = s3Config ? await deleteS3Object(relPath, s3Config) : false;
      const removedLocal = deleteLocalObject(relPath);
      if (removedRemote || removedLocal) removedFiles++;
      const basename = path.basename(relPath).replace(/\.[^.]+$/, "");
      if (basename) deleteThumbnailsFor(ATTACHMENTS_DIR, basename);
    } catch (error) {
      warnings.push(
        `attachment cleanup failed for ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { removedFiles, skippedSharedPaths, warnings };
}

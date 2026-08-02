import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";

const SETTING_KEY = "attachmentStorage:config";
const DATA_DIR = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
const ATTACHMENTS_DIR = path.join(DATA_DIR, "attachments");

type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
};

type SettingRow = {
  value: string;
};

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function env(name: string): string {
  return (process.env[name] || "").trim();
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
  } catch {
    return "";
  }
}

function normalizeS3Config(value: Partial<S3Config>): S3Config | null {
  const config: S3Config = {
    endpoint: String(value.endpoint || "").trim().replace(/\/+$/, ""),
    region: String(value.region || "auto").trim() || "auto",
    bucket: String(value.bucket || "").trim(),
    accessKeyId: String(value.accessKeyId || "").trim(),
    secretAccessKey: String(value.secretAccessKey || ""),
    prefix: String(value.prefix || "").trim().replace(/^\/+|\/+$/g, ""),
  };
  return config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey
    ? config
    : null;
}

function environmentS3Config(): S3Config | null {
  const driver = env("ATTACHMENT_STORAGE").toLowerCase();
  if (driver !== "s3" && driver !== "r2" && driver !== "minio") return null;
  return normalizeS3Config({
    endpoint: env("S3_ENDPOINT"),
    region: env("S3_REGION") || "auto",
    bucket: env("S3_BUCKET"),
    accessKeyId: env("S3_ACCESS_KEY_ID"),
    secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
    prefix: env("S3_PREFIX"),
  });
}

async function runtimeS3Config(adapter: DatabaseAdapter): Promise<S3Config | null> {
  const row = await adapter.queryOne<SettingRow>(
    `SELECT value FROM system_settings WHERE key = ?`,
    [SETTING_KEY],
  );
  if (row) {
    try {
      const parsed = JSON.parse(row.value || "{}") as Partial<S3Config> & {
        enabled?: boolean;
        secretAccessKeyEnc?: string;
      };
      if (parsed.enabled !== true) return null;
      return normalizeS3Config({
        ...parsed,
        secretAccessKey: decryptSecret(parsed.secretAccessKeyEnc || ""),
      });
    } catch {
      return null;
    }
  }
  return environmentS3Config();
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function objectKey(relativePath: string, config: S3Config): string {
  const clean = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const key = config.prefix ? `${config.prefix}/${clean}` : clean;
  return key.split("/").filter(Boolean).map(encodePathSegment).join("/");
}

function objectUrl(relativePath: string, config: S3Config): URL {
  return new URL(
    `${config.endpoint}/${encodePathSegment(config.bucket)}/${objectKey(relativePath, config)}`,
  );
}

function hmac(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function amzDate(date: Date): string {
  return `${dateStamp(date)}T${date.toISOString().slice(11, 19).replace(/:/g, "")}Z`;
}

function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
}

async function signedHead(relativePath: string, config: S3Config): Promise<Response> {
  const url = objectUrl(relativePath, config);
  const now = new Date();
  const date = dateStamp(now);
  const payloadHash = crypto.createHash("sha256").update("").digest("hex");
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate(now),
  };
  const sortedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaders.map((key) => `${key}:${headers[key]}\n`).join("");
  const signedHeaders = sortedHeaders.join(";");
  const canonicalRequest = [
    "HEAD",
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

  return fetch(url, {
    method: "HEAD",
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

export function createAttachmentStorageRuntime(adapter?: DatabaseAdapter) {
  const db = resolveAdapter(adapter);

  return {
    async checkExists(relativePath: string): Promise<{
      exists: boolean;
      status?: number;
      error?: string;
    }> {
      const config = await runtimeS3Config(db);
      if (!config) {
        return {
          exists: fs.existsSync(path.join(ATTACHMENTS_DIR, relativePath)),
        };
      }
      try {
        const response = await signedHead(relativePath, config);
        if (response.ok) return { exists: true, status: response.status };
        if (response.status === 404) return { exists: false, status: response.status };
        return {
          exists: false,
          status: response.status,
          error: await response.text().catch(() => ""),
        };
      } catch (error) {
        return {
          exists: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

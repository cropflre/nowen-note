import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";

const SETTING_KEY = "attachmentStorage:config";
const DEFAULT_DATA_DIR = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");

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

export type AttachmentStorageRuntimeOptions = {
  dataDir?: string;
  fetchImpl?: typeof fetch;
};

export type AttachmentStageCopyResult = {
  size: number;
  sha256: string;
  reused: boolean;
  driver: "local" | "s3";
};

export class AttachmentStorageRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AttachmentStorageRuntimeError";
  }
}

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

function normalizeRelativePath(value: string): string {
  const input = String(value || "");
  if (!input || input.includes("\\") || input.includes("\0") || input.startsWith("/")) {
    throw new AttachmentStorageRuntimeError(
      "ATTACHMENT_PATH_INVALID",
      "附件路径不是安全的相对路径",
      { path: input },
    );
  }
  const segments = input.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new AttachmentStorageRuntimeError(
      "ATTACHMENT_PATH_INVALID",
      "附件路径包含不安全的目录段",
      { path: input },
    );
  }
  return segments.join("/");
}

function attachmentsDir(options?: AttachmentStorageRuntimeOptions): string {
  return path.resolve(options?.dataDir || DEFAULT_DATA_DIR, "attachments");
}

function localPath(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new AttachmentStorageRuntimeError(
      "ATTACHMENT_PATH_ESCAPE",
      "附件路径越过存储目录",
      { path: relativePath },
    );
  }
  return resolved;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function objectKey(relativePath: string, config: S3Config): string {
  const clean = normalizeRelativePath(relativePath);
  const key = config.prefix ? `${config.prefix}/${clean}` : clean;
  return key.split("/").map(encodePathSegment).join("/");
}

function objectUrl(relativePath: string, config: S3Config): URL {
  return new URL(
    `${config.endpoint}/${encodePathSegment(config.bucket)}/${objectKey(relativePath, config)}`,
  );
}

function copySourceHeader(relativePath: string, config: S3Config): string {
  return `/${encodePathSegment(config.bucket)}/${objectKey(relativePath, config)}`;
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

async function signedRequest(
  method: "GET" | "PUT" | "DELETE" | "HEAD",
  relativePath: string,
  config: S3Config,
  fetchImpl: typeof fetch,
  extraHeaders: Record<string, string> = {},
  body?: Buffer,
  contentType?: string,
): Promise<Response> {
  const url = objectUrl(relativePath, config);
  const now = new Date();
  const date = dateStamp(now);
  const payloadHash = crypto.createHash("sha256").update(body || "").digest("hex");
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate(now),
  };
  if (contentType) headers["content-type"] = contentType;
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers[key.toLowerCase()] = value;
  }
  const sortedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaders.map((key) => `${key}:${headers[key]}\n`).join("");
  const signedHeaders = sortedHeaders.join(";");
  const canonicalRequest = [
    method,
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

  return fetchImpl(url, {
    method,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: body as BodyInit | undefined,
  });
}

async function responseFailure(prefix: string, response: Response): Promise<AttachmentStorageRuntimeError> {
  const message = await response.text().catch(() => "");
  return new AttachmentStorageRuntimeError(
    "ATTACHMENT_STORAGE_REQUEST_FAILED",
    `${prefix}: ${response.status}${message ? ` ${message.slice(0, 500)}` : ""}`,
    { status: response.status },
  );
}

function expectedSha256(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

async function hashLocalFile(filePath: string): Promise<{ size: number; sha256: string }> {
  const hash = crypto.createHash("sha256");
  let size = 0;
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    hash.update(buffer);
  }
  return { size, sha256: hash.digest("hex") };
}

async function hashResponse(response: Response): Promise<{ size: number; sha256: string }> {
  if (!response.body) return { size: 0, sha256: crypto.createHash("sha256").digest("hex") };
  const hash = crypto.createHash("sha256");
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buffer = Buffer.from(value);
      size += buffer.length;
      hash.update(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return { size, sha256: hash.digest("hex") };
}

function assertVerified(
  actual: { size: number; sha256: string },
  expectedSize: number,
  expectedHash: string | null,
  sourceHash?: string,
): void {
  if (actual.size !== expectedSize) {
    throw new AttachmentStorageRuntimeError(
      "ATTACHMENT_SIZE_MISMATCH",
      `附件大小不匹配：预期 ${expectedSize}，实际 ${actual.size}`,
      { expectedSize, actualSize: actual.size },
    );
  }
  const expected = expectedSha256(expectedHash);
  const comparison = expected || sourceHash;
  if (comparison && actual.sha256 !== comparison) {
    throw new AttachmentStorageRuntimeError(
      "ATTACHMENT_HASH_MISMATCH",
      "附件 SHA-256 校验失败",
      { expectedHash: comparison, actualHash: actual.sha256 },
    );
  }
}

async function copyLocal(
  root: string,
  sourcePath: string,
  stagedPath: string,
  expectedSize: number,
  expectedHash: string | null,
): Promise<AttachmentStageCopyResult> {
  const source = localPath(root, sourcePath);
  const destination = localPath(root, stagedPath);
  let sourceStat: fs.Stats;
  try {
    sourceStat = await fs.promises.lstat(source);
  } catch {
    throw new AttachmentStorageRuntimeError(
      "ATTACHMENT_SOURCE_MISSING",
      "源附件文件不存在",
      { sourcePath },
    );
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new AttachmentStorageRuntimeError(
      "ATTACHMENT_SOURCE_INVALID",
      "源附件不是普通文件",
      { sourcePath },
    );
  }
  if (sourceStat.size !== expectedSize) {
    throw new AttachmentStorageRuntimeError(
      "ATTACHMENT_SOURCE_SIZE_MISMATCH",
      `源附件大小已变化：预期 ${expectedSize}，实际 ${sourceStat.size}`,
      { sourcePath, expectedSize, actualSize: sourceStat.size },
    );
  }

  const sourceVerified = await hashLocalFile(source);
  assertVerified(sourceVerified, expectedSize, expectedHash);

  try {
    const existingStat = await fs.promises.lstat(destination);
    if (existingStat.isFile() && !existingStat.isSymbolicLink()) {
      const existing = await hashLocalFile(destination);
      if (existing.size === sourceVerified.size && existing.sha256 === sourceVerified.sha256) {
        return { ...existing, reused: true, driver: "local" };
      }
    }
  } catch {
    // A missing staging object is the normal first-attempt path.
  }

  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    const copied = await hashLocalFile(temporary);
    assertVerified(copied, expectedSize, expectedHash, sourceVerified.sha256);
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(temporary, destination);
    return { ...copied, reused: false, driver: "local" };
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function getS3Hash(
  relativePath: string,
  config: S3Config,
  fetchImpl: typeof fetch,
): Promise<{ size: number; sha256: string }> {
  const response = await signedRequest("GET", relativePath, config, fetchImpl);
  if (!response.ok) throw await responseFailure("S3 GET failed", response);
  return hashResponse(response);
}

async function getS3Size(
  relativePath: string,
  config: S3Config,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  const response = await signedRequest("HEAD", relativePath, config, fetchImpl);
  if (response.status === 404) return null;
  if (!response.ok) throw await responseFailure("S3 HEAD failed", response);
  const length = Number(response.headers.get("content-length"));
  return Number.isFinite(length) && length >= 0 ? length : null;
}

async function copyS3(
  config: S3Config,
  fetchImpl: typeof fetch,
  sourcePath: string,
  stagedPath: string,
  expectedSize: number,
  expectedHash: string | null,
): Promise<AttachmentStageCopyResult> {
  const sourceSize = await getS3Size(sourcePath, config, fetchImpl);
  if (sourceSize == null) {
    throw new AttachmentStorageRuntimeError(
      "ATTACHMENT_SOURCE_MISSING",
      "源附件对象不存在",
      { sourcePath },
    );
  }
  if (sourceSize !== expectedSize) {
    throw new AttachmentStorageRuntimeError(
      "ATTACHMENT_SOURCE_SIZE_MISMATCH",
      `源附件大小已变化：预期 ${expectedSize}，实际 ${sourceSize}`,
      { sourcePath, expectedSize, actualSize: sourceSize },
    );
  }

  const expected = expectedSha256(expectedHash);
  const sourceVerified = expected
    ? { size: sourceSize, sha256: expected }
    : await getS3Hash(sourcePath, config, fetchImpl);
  assertVerified(sourceVerified, expectedSize, expectedHash);

  const existingSize = await getS3Size(stagedPath, config, fetchImpl);
  if (existingSize === expectedSize) {
    const existing = await getS3Hash(stagedPath, config, fetchImpl);
    if (existing.sha256 === sourceVerified.sha256) {
      return { ...existing, reused: true, driver: "s3" };
    }
  }

  const copied = await signedRequest(
    "PUT",
    stagedPath,
    config,
    fetchImpl,
    { "x-amz-copy-source": copySourceHeader(sourcePath, config) },
  );
  if (!copied.ok) throw await responseFailure("S3 CopyObject failed", copied);

  const verified = await getS3Hash(stagedPath, config, fetchImpl);
  assertVerified(verified, expectedSize, expectedHash, sourceVerified.sha256);
  return { ...verified, reused: false, driver: "s3" };
}

export function createAttachmentStorageRuntime(
  adapter?: DatabaseAdapter,
  options: AttachmentStorageRuntimeOptions = {},
) {
  const db = resolveAdapter(adapter);
  const root = attachmentsDir(options);
  const fetchImpl = options.fetchImpl || fetch;

  return {
    getAttachmentsDir(): string {
      return root;
    },

    async getDriver(): Promise<"local" | "s3"> {
      return (await runtimeS3Config(db)) ? "s3" : "local";
    },

    async checkExists(relativePath: string): Promise<{
      exists: boolean;
      status?: number;
      error?: string;
    }> {
      const normalized = normalizeRelativePath(relativePath);
      const config = await runtimeS3Config(db);
      if (!config) {
        return { exists: fs.existsSync(localPath(root, normalized)) };
      }
      try {
        const response = await signedRequest("HEAD", normalized, config, fetchImpl);
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

    async readObject(relativePath: string): Promise<Buffer | null> {
    const normalized = normalizeRelativePath(relativePath);
    const config = await runtimeS3Config(db);
    if (!config) {
      const filePath = localPath(root, normalized);
      try {
        const stat = await fs.promises.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        return await fs.promises.readFile(filePath);
      } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    }

    const response = await signedRequest("GET", normalized, config, fetchImpl);
    if (response.status === 404) {
      const fallback = localPath(root, normalized);
      try {
        const stat = await fs.promises.lstat(fallback);
        if (stat.isFile() && !stat.isSymbolicLink()) return await fs.promises.readFile(fallback);
      } catch {
        // no local fallback
      }
      return null;
    }
    if (!response.ok) throw await responseFailure("S3 GET failed", response);
    return Buffer.from(await response.arrayBuffer());
  },

  async writeObject(relativePath: string, buffer: Buffer, contentType?: string): Promise<void> {
    const normalized = normalizeRelativePath(relativePath);
    const config = await runtimeS3Config(db);
    if (!config) {
      const filePath = localPath(root, normalized);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, buffer);
      return;
    }
    const response = await signedRequest("PUT", normalized, config, fetchImpl, {}, buffer, contentType);
    if (!response.ok) throw await responseFailure("S3 PUT failed", response);
  },

  async copyAndVerify(input: {
      sourcePath: string;
      stagedPath: string;
      expectedSize: number;
      expectedHash: string | null;
    }): Promise<AttachmentStageCopyResult> {
      const sourcePath = normalizeRelativePath(input.sourcePath);
      const stagedPath = normalizeRelativePath(input.stagedPath);
      if (!Number.isInteger(input.expectedSize) || input.expectedSize < 0) {
        throw new AttachmentStorageRuntimeError(
          "ATTACHMENT_EXPECTED_SIZE_INVALID",
          "附件预期大小无效",
          { expectedSize: input.expectedSize },
        );
      }
      const config = await runtimeS3Config(db);
      if (!config) {
        return copyLocal(root, sourcePath, stagedPath, input.expectedSize, input.expectedHash);
      }
      return copyS3(
        config,
        fetchImpl,
        sourcePath,
        stagedPath,
        input.expectedSize,
        input.expectedHash,
      );
    },

    async deleteObject(relativePath: string): Promise<void> {
      const normalized = normalizeRelativePath(relativePath);
      const config = await runtimeS3Config(db);
      if (!config) {
        await fs.promises.rm(localPath(root, normalized), { force: true });
        return;
      }
      const response = await signedRequest("DELETE", normalized, config, fetchImpl);
      if (!response.ok && response.status !== 404) {
        throw await responseFailure("S3 DELETE failed", response);
      }
    },
  };
}

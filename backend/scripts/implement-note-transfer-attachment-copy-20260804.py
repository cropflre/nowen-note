#!/usr/bin/env python3
"""One-shot implementation for recoverable PostgreSQL Note Transfer attachment staging."""

from __future__ import annotations

from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    source = path.read_text(encoding="utf-8")
    if old not in source:
        if new in source:
            return
        raise SystemExit(f"{label} anchor changed in {path}")
    path.write_text(source.replace(old, new, 1), encoding="utf-8")


def write_migration() -> None:
    Path("backend/src/db/postgres/migrations/0018_note_transfer_attachment_staging_runtime.sql").write_text(
        '''ALTER TABLE note_transfer_staged_attachments
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "verifiedSize" BIGINT CHECK ("verifiedSize" IS NULL OR "verifiedSize" >= 0),
  ADD COLUMN IF NOT EXISTS "verifiedHash" TEXT,
  ADD COLUMN IF NOT EXISTS "stagedAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_note_transfer_staged_attachments_lease
  ON note_transfer_staged_attachments("operationId", status, "leaseExpiresAt", "sourceAttachmentId");
''',
        encoding="utf-8",
    )


def write_storage_runtime() -> None:
    Path("backend/src/services/attachment-storage-runtime.ts").write_text(
        r'''import crypto from "node:crypto";
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
): Promise<Response> {
  const url = objectUrl(relativePath, config);
  const now = new Date();
  const date = dateStamp(now);
  const payloadHash = crypto.createHash("sha256").update("").digest("hex");
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate(now),
  };
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
''',
        encoding="utf-8",
    )


def patch_operation_repository() -> None:
    path = Path("backend/src/repositories/noteTransferOperationRepository.ts")

    replace_once(
        path,
        '''  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
''',
        '''  lastError: string | null;
  verifiedSize: number | null;
  verifiedHash: string | null;
  stagedAt: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NoteTransferStagingClaim = {
  operationId: string;
  sourceAttachmentId: string;
  sourceNoteId: string;
  targetAttachmentId: string;
  targetNoteId: string;
  sourcePath: string;
  stagedPath: string;
  filename: string;
  mimeType: string;
  size: number;
  hash: string | null;
  attempts: number;
  leaseToken: string;
};
''',
        "public staging verification fields",
    )

    replace_once(
        path,
        '''type StagedAttachmentRow = Omit<NoteTransferStagedAttachment, "size" | "attempts" | "createdAt" | "updatedAt"> & {
  size: number | string;
  attempts: number | string;
  createdAt: string | Date;
  updatedAt: string | Date;
};
''',
        '''type StagedAttachmentRow = Omit<
  NoteTransferStagedAttachment,
  "size" | "attempts" | "verifiedSize" | "stagedAt" | "leaseExpiresAt" | "createdAt" | "updatedAt"
> & {
  size: number | string;
  attempts: number | string;
  verifiedSize: number | string | null;
  stagedAt: string | Date | null;
  leaseExpiresAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
};

type StagingClaimRow = Omit<NoteTransferStagingClaim, "size" | "attempts" | "leaseToken"> & {
  size: number | string;
  attempts: number | string;
};
''',
        "staging row types",
    )

    replace_once(
        path,
        '''              sourcePath, stagedPath, filename, mimeType, size, hash,
              status, attempts, lastError, createdAt, updatedAt
''',
        '''              sourcePath, stagedPath, filename, mimeType, size, hash,
              status, attempts, lastError, verifiedSize, verifiedHash,
              stagedAt, leaseExpiresAt, createdAt, updatedAt
''',
        "load staging verification columns",
    )

    replace_once(
        path,
        '''        attempts: toNumber(attachment.attempts),
        lastError: attachment.lastError,
        createdAt: toTimestamp(attachment.createdAt),
''',
        '''        attempts: toNumber(attachment.attempts),
        lastError: attachment.lastError,
        verifiedSize: attachment.verifiedSize == null ? null : toNumber(attachment.verifiedSize),
        verifiedHash: attachment.verifiedHash,
        stagedAt: attachment.stagedAt == null ? null : toTimestamp(attachment.stagedAt),
        leaseExpiresAt: attachment.leaseExpiresAt == null
          ? null
          : toTimestamp(attachment.leaseExpiresAt),
        createdAt: toTimestamp(attachment.createdAt),
''',
        "map staging verification columns",
    )

    methods = '''    async requeueFailedStagedAttachments(input: {
      actorUserId: string;
      idempotencyKey: string;
      maxAttempts: number;
    }): Promise<number> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      const result = await db.execute(
        `UPDATE note_transfer_staged_attachments manifest
            SET status = 'planned', leaseToken = NULL, leaseExpiresAt = NULL,
                updatedAt = CURRENT_TIMESTAMP
           FROM note_transfer_operations operation
          WHERE manifest.operationId = operation.id
            AND operation.userId = ? AND operation.idempotencyKey = ?
            AND operation.status = 'staging'
            AND manifest.status = 'failed' AND manifest.attempts < ?`,
        [input.actorUserId, key, input.maxAttempts],
      );
      return result.changes;
    },

    async claimNextStagedAttachment(input: {
      actorUserId: string;
      idempotencyKey: string;
      maxAttempts: number;
      leaseSeconds: number;
    }): Promise<NoteTransferStagingClaim | null> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      const leaseToken = randomUUID();
      const row = await db.queryOne<StagingClaimRow>(
        `WITH candidate AS (
           SELECT manifest.operationId, manifest.sourceAttachmentId
             FROM note_transfer_staged_attachments manifest
             JOIN note_transfer_operations operation
               ON operation.id = manifest.operationId
            WHERE operation.userId = ? AND operation.idempotencyKey = ?
              AND operation.status = 'staging'
              AND manifest.attempts < ?
              AND (
                manifest.status = 'planned'
                OR (
                  manifest.status = 'copying'
                  AND (manifest.leaseExpiresAt IS NULL OR manifest.leaseExpiresAt <= CURRENT_TIMESTAMP)
                )
              )
            ORDER BY manifest.sourceNoteId, manifest.sourceAttachmentId
            FOR UPDATE OF manifest SKIP LOCKED
            LIMIT 1
         )
         UPDATE note_transfer_staged_attachments manifest
            SET status = 'copying', attempts = manifest.attempts + 1,
                leaseToken = ?,
                leaseExpiresAt = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                lastError = NULL, updatedAt = CURRENT_TIMESTAMP
           FROM candidate
          WHERE manifest.operationId = candidate.operationId
            AND manifest.sourceAttachmentId = candidate.sourceAttachmentId
         RETURNING manifest.operationId, manifest.sourceAttachmentId,
                   manifest.sourceNoteId, manifest.targetAttachmentId,
                   manifest.targetNoteId, manifest.sourcePath, manifest.stagedPath,
                   manifest.filename, manifest.mimeType, manifest.size, manifest.hash,
                   manifest.attempts`,
        [
          input.actorUserId,
          key,
          input.maxAttempts,
          leaseToken,
          Math.max(30, input.leaseSeconds),
        ],
      );
      if (!row) return null;
      return {
        operationId: row.operationId,
        sourceAttachmentId: row.sourceAttachmentId,
        sourceNoteId: row.sourceNoteId,
        targetAttachmentId: row.targetAttachmentId,
        targetNoteId: row.targetNoteId,
        sourcePath: row.sourcePath,
        stagedPath: row.stagedPath,
        filename: row.filename,
        mimeType: row.mimeType,
        size: toNumber(row.size),
        hash: row.hash,
        attempts: toNumber(row.attempts),
        leaseToken,
      };
    },

    async markStagedAttachmentComplete(input: {
      operationId: string;
      sourceAttachmentId: string;
      leaseToken: string;
      verifiedSize: number;
      verifiedHash: string;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE note_transfer_staged_attachments
            SET status = 'staged', verifiedSize = ?, verifiedHash = ?,
                stagedAt = CURRENT_TIMESTAMP, leaseToken = NULL, leaseExpiresAt = NULL,
                lastError = NULL, updatedAt = CURRENT_TIMESTAMP
          WHERE operationId = ? AND sourceAttachmentId = ?
            AND status = 'copying' AND leaseToken = ?`,
        [
          input.verifiedSize,
          input.verifiedHash,
          input.operationId,
          input.sourceAttachmentId,
          input.leaseToken,
        ],
      );
      if (result.changes !== 1) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_STAGING_LEASE_LOST",
          "附件 staging 租约已失效，请重新恢复操作",
          409,
          { operationId: input.operationId, sourceAttachmentId: input.sourceAttachmentId },
        );
      }
    },

    async markStagedAttachmentFailed(input: {
      operationId: string;
      sourceAttachmentId: string;
      leaseToken: string;
      error: string;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE note_transfer_staged_attachments
            SET status = 'failed', lastError = ?,
                leaseToken = NULL, leaseExpiresAt = NULL,
                updatedAt = CURRENT_TIMESTAMP
          WHERE operationId = ? AND sourceAttachmentId = ?
            AND status = 'copying' AND leaseToken = ?`,
        [
          input.error.slice(0, 2000),
          input.operationId,
          input.sourceAttachmentId,
          input.leaseToken,
        ],
      );
      if (result.changes !== 1) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_STAGING_LEASE_LOST",
          "附件 staging 租约已失效，请重新恢复操作",
          409,
          { operationId: input.operationId, sourceAttachmentId: input.sourceAttachmentId },
        );
      }
    },

'''
    replace_once(
        path,
        '''    async prepareOperation(input: {
''',
        methods + '''    async prepareOperation(input: {
''',
        "attachment staging repository methods",
    )


def write_staging_service() -> None:
    Path("backend/src/services/note-transfer-attachment-staging-runtime.ts").write_text(
        '''import type { DatabaseAdapter } from "../db/adapters/types";
import {
  createNoteTransferOperationRepository,
  NoteTransferOperationError,
  type PreparedNoteTransferOperation,
} from "../repositories/noteTransferOperationRepository";
import {
  createAttachmentStorageRuntime,
  type AttachmentStageCopyResult,
} from "./attachment-storage-runtime";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_SECONDS = 300;

export type NoteTransferAttachmentStagingSummary = {
  complete: boolean;
  attempted: number;
  copied: number;
  reusedObjects: number;
  failedThisRun: number;
  staged: number;
  failed: number;
  pending: number;
  exhausted: number;
  total: number;
};

export type NoteTransferAttachmentStagingResult = {
  operation: PreparedNoteTransferOperation;
  summary: NoteTransferAttachmentStagingSummary;
};

type StorageRuntime = ReturnType<typeof createAttachmentStorageRuntime>;
type OperationRepository = ReturnType<typeof createNoteTransferOperationRepository>;

export function createNoteTransferAttachmentStagingRuntime(
  adapter?: DatabaseAdapter,
  options: {
    storage?: StorageRuntime;
    operations?: OperationRepository;
    concurrency?: number;
    maxAttempts?: number;
    leaseSeconds?: number;
  } = {},
) {
  const operations = options.operations || createNoteTransferOperationRepository(adapter);
  const storage = options.storage || createAttachmentStorageRuntime(adapter);
  const concurrency = Math.max(1, Math.min(8, options.concurrency || DEFAULT_CONCURRENCY));
  const maxAttempts = Math.max(1, Math.min(20, options.maxAttempts || DEFAULT_MAX_ATTEMPTS));
  const leaseSeconds = Math.max(30, options.leaseSeconds || DEFAULT_LEASE_SECONDS);

  async function loadOperation(input: {
    actorUserId: string;
    idempotencyKey: string;
  }): Promise<PreparedNoteTransferOperation> {
    const operation = await operations.getPrepared(input);
    if (!operation) {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_PLAN_NOT_FOUND",
        "转移计划不存在",
        404,
      );
    }
    if (operation.status !== "staging") {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_STATE_CONFLICT",
        `当前状态 ${operation.status} 无法复制 staging 附件`,
        409,
        { operationId: operation.id, status: operation.status },
      );
    }
    return operation;
  }

  function summarize(
    operation: PreparedNoteTransferOperation,
    counters: {
      attempted: number;
      copied: number;
      reusedObjects: number;
      failedThisRun: number;
    },
  ): NoteTransferAttachmentStagingSummary {
    const total = operation.stagedAttachments.length;
    const staged = operation.stagedAttachments.filter((item) => item.status === "staged").length;
    const failedRows = operation.stagedAttachments.filter((item) => item.status === "failed");
    const failed = failedRows.length;
    const exhausted = failedRows.filter((item) => item.attempts >= maxAttempts).length;
    const pending = total - staged - failed;
    return {
      complete: staged === total,
      attempted: counters.attempted,
      copied: counters.copied,
      reusedObjects: counters.reusedObjects,
      failedThisRun: counters.failedThisRun,
      staged,
      failed,
      pending,
      exhausted,
      total,
    };
  }

  async function stageClaim(claim: Awaited<ReturnType<OperationRepository["claimNextStagedAttachment"]>>): Promise<AttachmentStageCopyResult | null> {
    if (!claim) return null;
    try {
      const copied = await storage.copyAndVerify({
        sourcePath: claim.sourcePath,
        stagedPath: claim.stagedPath,
        expectedSize: claim.size,
        expectedHash: claim.hash,
      });
      await operations.markStagedAttachmentComplete({
        operationId: claim.operationId,
        sourceAttachmentId: claim.sourceAttachmentId,
        leaseToken: claim.leaseToken,
        verifiedSize: copied.size,
        verifiedHash: copied.sha256,
      });
      return copied;
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      try {
        await operations.markStagedAttachmentFailed({
          operationId: claim.operationId,
          sourceAttachmentId: claim.sourceAttachmentId,
          leaseToken: claim.leaseToken,
          error: message,
        });
      } catch (leaseError) {
        if (!(leaseError instanceof NoteTransferOperationError)
          || leaseError.code !== "NOTE_TRANSFER_STAGING_LEASE_LOST") {
          throw leaseError;
        }
      }
      return null;
    }
  }

  return {
    async resume(input: {
      actorUserId: string;
      idempotencyKey: string;
    }): Promise<NoteTransferAttachmentStagingResult> {
      await loadOperation(input);
      await operations.requeueFailedStagedAttachments({
        ...input,
        maxAttempts,
      });

      const counters = {
        attempted: 0,
        copied: 0,
        reusedObjects: 0,
        failedThisRun: 0,
      };

      const worker = async () => {
        while (true) {
          const claim = await operations.claimNextStagedAttachment({
            ...input,
            maxAttempts,
            leaseSeconds,
          });
          if (!claim) return;
          counters.attempted += 1;
          const copied = await stageClaim(claim);
          if (!copied) {
            counters.failedThisRun += 1;
            continue;
          }
          counters.copied += 1;
          if (copied.reused) counters.reusedObjects += 1;
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      const operation = await loadOperation(input);
      return { operation, summary: summarize(operation, counters) };
    },
  };
}
''',
        encoding="utf-8",
    )


def patch_route() -> None:
    path = Path("backend/src/routes/note-transfers-runtime.ts")
    replace_once(
        path,
        '''import {
  createNoteTransferPreviewRuntime,
''',
        '''import { createNoteTransferAttachmentStagingRuntime } from "../services/note-transfer-attachment-staging-runtime";
import {
  createNoteTransferPreviewRuntime,
''',
        "attachment staging service import",
    )
    replace_once(
        path,
        '''  const operations = createNoteTransferOperationRepository(adapter);
''',
        '''  const operations = createNoteTransferOperationRepository(adapter);
  const attachmentStaging = createNoteTransferAttachmentStagingRuntime(adapter, { operations });
''',
        "attachment staging service initialization",
    )
    route = '''
  app.post("/operations/:idempotencyKey/staging/resume", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;

    try {
      const result = await attachmentStaging.resume({
        actorUserId: c.req.header("X-User-Id") || "",
        idempotencyKey: c.req.param("idempotencyKey"),
      });
      return c.json(result, result.summary.complete ? 200 : 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

'''
    replace_once(
        path,
        '''  app.get("/operations/:idempotencyKey", async (c) => {
''',
        route + '''  app.get("/operations/:idempotencyKey", async (c) => {
''',
        "attachment staging resume route",
    )
    replace_once(
        path,
        '''        error: "PostgreSQL 笔记转移最终提交尚未迁移，请先使用预检、prepare 和 staging 接口",
''',
        '''        error: "PostgreSQL 笔记转移最终提交尚未迁移，请先完成预检、prepare、staging 和附件复制",
''',
        "execution pending message",
    )


def write_runtime_test() -> None:
    Path("backend/tests/note-transfer-attachment-staging-runtime-pg.test.ts").write_text(
        '''import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNoteTransferOperationRepository } from "../src/repositories/noteTransferOperationRepository";
import { createAttachmentStorageRuntime } from "../src/services/attachment-storage-runtime";
import { createNoteTransferAttachmentStagingRuntime } from "../src/services/note-transfer-attachment-staging-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const ACTOR = "pg-transfer-copy-actor";
const WORKSPACE = "pg-transfer-copy-workspace";
const SOURCE_NOTEBOOK = "pg-transfer-copy-source-notebook";
const TARGET_NOTEBOOK = "pg-transfer-copy-target-notebook";
const SOURCE_NOTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_ATTACHMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function seed(pool: import("pg").Pool, content: Buffer): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1`, [ACTOR]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0)`,
    [ACTOR],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Transfer', $2)`,
    [WORKSPACE, ACTOR],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name)
     VALUES ($1, $3, NULL, 'Source'), ($2, $3, $4, 'Target')`,
    [SOURCE_NOTEBOOK, TARGET_NOTEBOOK, ACTOR, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version
     ) VALUES ($1, $2, $3, 'Source', '# Source', 'Source', 'markdown', 3)`,
    [SOURCE_NOTE, ACTOR, SOURCE_NOTEBOOK],
  );
  await pool.query(
    `INSERT INTO attachments (
       id, "noteId", "userId", filename, "mimeType", size, path, hash
     ) VALUES ($1, $2, $3, 'source.bin', 'application/octet-stream', $4, $5, $6)`,
    [
      SOURCE_ATTACHMENT,
      SOURCE_NOTE,
      ACTOR,
      content.length,
      "transfer-source/source.bin",
      crypto.createHash("sha256").update(content).digest("hex"),
    ],
  );
}

async function prepare(
  operations: ReturnType<typeof createNoteTransferOperationRepository>,
  key: string,
  size: number,
) {
  await operations.prepareOperation({
    actorUserId: ACTOR,
    idempotencyKey: key,
    mode: "copy",
    sourceWorkspaceId: null,
    targetWorkspaceId: WORKSPACE,
    targetNotebookId: TARGET_NOTEBOOK,
    includeAttachments: true,
    includeTags: false,
    sourceNoteIds: [SOURCE_NOTE],
    sourceVersions: { [SOURCE_NOTE]: 3 },
    attachmentCount: 1,
    attachmentBytes: size,
    tagCount: 0,
    internalNoteLinkCount: 0,
    externalNoteLinkCount: 0,
  });
  return operations.beginStaging({ actorUserId: ACTOR, idempotencyKey: key });
}

test("PostgreSQL note-transfer attachment staging is verified, retryable and crash-safe", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nowen-pg-transfer-copy-"));
  const sourceContent = Buffer.from("recoverable physical attachment copy");

  try {
    await initPgSchema(pool);
    await seed(pool, sourceContent);
    const adapter = new PostgresAdapter(pool);
    const operations = createNoteTransferOperationRepository(adapter);
    const storage = createAttachmentStorageRuntime(adapter, { dataDir });
    const runtime = createNoteTransferAttachmentStagingRuntime(adapter, {
      operations,
      storage,
      concurrency: 2,
      maxAttempts: 3,
      leaseSeconds: 30,
    });
    const attachmentsDir = storage.getAttachmentsDir();
    const sourcePath = path.join(attachmentsDir, "transfer-source", "source.bin");
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.promises.writeFile(sourcePath, sourceContent);

    const staged = await prepare(operations, "transfer-physical-copy-001", sourceContent.length);
    const first = await runtime.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-physical-copy-001",
    });
    assert.equal(first.summary.complete, true);
    assert.equal(first.summary.attempted, 1);
    assert.equal(first.summary.copied, 1);
    assert.equal(first.summary.failed, 0);
    assert.equal(first.operation.status, "staging");
    assert.equal(first.operation.stagedAttachments[0].status, "staged");
    assert.equal(first.operation.stagedAttachments[0].attempts, 1);
    assert.equal(first.operation.stagedAttachments[0].verifiedSize, sourceContent.length);
    assert.equal(
      first.operation.stagedAttachments[0].verifiedHash,
      crypto.createHash("sha256").update(sourceContent).digest("hex"),
    );
    assert.ok(first.operation.stagedAttachments[0].stagedAt);
    const stagedPath = path.join(
      attachmentsDir,
      ...first.operation.stagedAttachments[0].stagedPath.split("/"),
    );
    assert.deepEqual(await fs.promises.readFile(stagedPath), sourceContent);

    const idempotent = await runtime.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-physical-copy-001",
    });
    assert.equal(idempotent.summary.complete, true);
    assert.equal(idempotent.summary.attempted, 0);
    assert.equal(idempotent.operation.stagedAttachments[0].attempts, 1);

    await pool.query(
      `UPDATE note_transfer_staged_attachments
          SET status = 'copying', "leaseToken" = 'crashed-worker',
              "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute'
        WHERE "operationId" = $1`,
      [staged.id],
    );
    const recovered = await runtime.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-physical-copy-001",
    });
    assert.equal(recovered.summary.complete, true);
    assert.equal(recovered.summary.reusedObjects, 1);
    assert.equal(recovered.operation.stagedAttachments[0].attempts, 2);

    await pool.query(
      `DELETE FROM note_transfer_operations WHERE "userId" = $1 AND "idempotencyKey" = $2`,
      [ACTOR, "transfer-physical-copy-retry"],
    );
    await fs.promises.rm(sourcePath, { force: true });
    await prepare(operations, "transfer-physical-copy-retry", sourceContent.length);
    const failed = await runtime.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-physical-copy-retry",
    });
    assert.equal(failed.summary.complete, false);
    assert.equal(failed.summary.failed, 1);
    assert.equal(failed.summary.failedThisRun, 1);
    assert.equal(failed.operation.stagedAttachments[0].status, "failed");
    assert.equal(failed.operation.stagedAttachments[0].attempts, 1);
    assert.match(failed.operation.stagedAttachments[0].lastError || "", /源附件文件不存在/);

    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.promises.writeFile(sourcePath, sourceContent);
    const retried = await runtime.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-physical-copy-retry",
    });
    assert.equal(retried.summary.complete, true);
    assert.equal(retried.summary.failed, 0);
    assert.equal(retried.operation.stagedAttachments[0].status, "staged");
    assert.equal(retried.operation.stagedAttachments[0].attempts, 2);

    await assert.rejects(
      storage.copyAndVerify({
        sourcePath: "../escape.bin",
        stagedPath: "note-transfer-staging/escape",
        expectedSize: 0,
        expectedHash: null,
      }),
      (error: any) => error?.code === "ATTACHMENT_PATH_INVALID",
    );
  } finally {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
    await closePgPool(pool);
  }
});
''',
        encoding="utf-8",
    )


def patch_migration_test() -> None:
    path = Path("backend/tests/postgres-migrations.test.ts")
    replace_once(
        path,
        '''    "0017_note_transfer_staging_manifest",
  ]);
''',
        '''    "0017_note_transfer_staging_manifest",
    "0018_note_transfer_attachment_staging_runtime",
  ]);
''',
        "migration 0018 version",
    )
    replace_once(
        path,
        '''            to_regclass('public.idx_note_transfer_staged_attachments_source_note') AS staged_source`,
''',
        '''            to_regclass('public.idx_note_transfer_staged_attachments_source_note') AS staged_source,
            to_regclass('public.idx_note_transfer_staged_attachments_lease') AS staged_lease`,
''',
        "staging lease index query",
    )
    replace_once(
        path,
        '''  assert.equal(
    transferIndexes.rows[0].staged_source,
    "idx_note_transfer_staged_attachments_source_note",
  );

  const second = await runPostgresMigrations(adapter);
''',
        '''  assert.equal(
    transferIndexes.rows[0].staged_source,
    "idx_note_transfer_staged_attachments_source_note",
  );
  assert.equal(
    transferIndexes.rows[0].staged_lease,
    "idx_note_transfer_staged_attachments_lease",
  );

  const stagingColumns = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'note_transfer_staged_attachments'
       AND column_name IN ('leaseToken', 'leaseExpiresAt', 'verifiedSize', 'verifiedHash', 'stagedAt')
     ORDER BY column_name
  `);
  assert.deepEqual(
    stagingColumns.rows.map((row) => row.column_name),
    ["leaseExpiresAt", "leaseToken", "stagedAt", "verifiedHash", "verifiedSize"],
  );

  const second = await runPostgresMigrations(adapter);
''',
        "staging runtime migration assertions",
    )


def patch_health() -> None:
    path = Path("backend/src/index.postgres-runtime.ts")
    replace_once(
        path,
        '''        "POST /api/note-transfers/operations/:idempotencyKey/staging",
        "GET /api/note-transfers/operations/:idempotencyKey",
''',
        '''        "POST /api/note-transfers/operations/:idempotencyKey/staging",
        "POST /api/note-transfers/operations/:idempotencyKey/staging/resume",
        "GET /api/note-transfers/operations/:idempotencyKey",
''',
        "health staging resume route",
    )
    replace_once(
        path,
        '''        "note-transfer prepared-to-staging CAS and recoverable attachment manifests",
''',
        '''        "note-transfer prepared-to-staging CAS and recoverable attachment manifests",
        "note-transfer local/S3 physical staging copy with leases, SHA-256 verification and crash recovery",
''',
        "health attachment copy capability",
    )
    replace_once(
        path,
        '''        "note-transfer physical attachment copy, atomic target commit and move deletion (#249)",
''',
        '''        "note-transfer atomic target commit, staged-object cleanup and move deletion (#249)",
''',
        "health pending target commit",
    )
    replace_once(
        path,
        '''console.warn("[db] Notes, durable note-transfer planning/staging and knowledge-tree routes are PostgreSQL-safe; production cutover remains disabled until the remaining PostgreSQL phases complete");
''',
        '''console.warn("[db] Notes, durable note-transfer planning/physical staging and knowledge-tree routes are PostgreSQL-safe; production cutover remains disabled until the remaining PostgreSQL phases complete");
''',
        "runtime startup warning",
    )


def patch_pg_runtime_workflow() -> None:
    path = Path(".github/workflows/pg-runtime.yml")
    replace_once(
        path,
        '''          tests/note-transfer-preview-runtime-pg.test.ts
          tests/postgres-yjs-read-runtime-pg.test.ts
''',
        '''          tests/note-transfer-preview-runtime-pg.test.ts
          tests/note-transfer-attachment-staging-runtime-pg.test.ts
          tests/postgres-yjs-read-runtime-pg.test.ts
''',
        "runtime attachment staging test",
    )
    replace_once(
        path,
        '''          test -f dist/postgres/migrations/0016_note_transfer_operations.sql
''',
        '''          test -f dist/postgres/migrations/0016_note_transfer_operations.sql &&
          test -f dist/postgres/migrations/0017_note_transfer_staging_manifest.sql &&
          test -f dist/postgres/migrations/0018_note_transfer_attachment_staging_runtime.sql
''',
        "runtime migration bundle checks",
    )
    replace_once(
        path,
        '''              "POST /api/note-transfers/prepare",
              "GET /api/note-transfers/operations/:idempotencyKey",
''',
        '''              "POST /api/note-transfers/prepare",
              "POST /api/note-transfers/operations/:idempotencyKey/staging",
              "POST /api/note-transfers/operations/:idempotencyKey/staging/resume",
              "GET /api/note-transfers/operations/:idempotencyKey",
''',
        "runtime smoke staging routes",
    )
    replace_once(
        path,
        '''              "note-transfer durable idempotency, source-version snapshots and transactional preparation",
              "knowledge-tree shared-root discovery with overlapping-root de-duplication",
''',
        '''              "note-transfer durable idempotency, source-version snapshots and transactional preparation",
              "note-transfer prepared-to-staging CAS and recoverable attachment manifests",
              "note-transfer local/S3 physical staging copy with leases, SHA-256 verification and crash recovery",
              "knowledge-tree shared-root discovery with overlapping-root de-duplication",
''',
        "runtime smoke attachment copy capability",
    )
    replace_once(
        path,
        '''              "note-transfer copy/move transaction and staged attachment commit (#249)",
''',
        '''              "note-transfer copy/move transaction and staged attachment commit (#249)",
              "note-transfer physical attachment copy, atomic target commit and move deletion (#249)",
''',
        "runtime stale pending capability",
    )


def main() -> None:
    write_migration()
    write_storage_runtime()
    patch_operation_repository()
    write_staging_service()
    patch_route()
    write_runtime_test()
    patch_migration_test()
    patch_health()
    patch_pg_runtime_workflow()


if __name__ == "__main__":
    main()

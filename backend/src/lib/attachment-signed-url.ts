/**
 * 附件签名 URL 工具（SEC-ATTACHMENT-01 / ISSUE-216）
 *
 * v2 scope 携带可重新校验的授权上下文以及当前下载能力。每次附件请求
 * 都会重新检查 ACL / 分享状态，因此成员移除、分享撤销或过期后，旧 URL
 * 会立即失效。
 */

import crypto from "crypto";
import { attachmentSignedAccessRepository } from "../repositories/attachmentSignedAccessRepository";
import { resolveEffectiveNoteCapabilities } from "../services/share-capabilities";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const SCOPE_PREFIX = "v2.";
const MAX_SCOPE_LENGTH = 1024;

export type AttachmentAccessScope =
  | { version: 2; kind: "user"; subjectId: string; noteId: string; allowDownload: boolean }
  | { version: 2; kind: "share"; subjectId: string; noteId: string; allowDownload: boolean }
  | { version: 2; kind: "publication"; subjectId: string; noteId: string; allowDownload: boolean };

export interface AttachmentSignatureVerification {
  valid: boolean;
  reason?: string;
  accessKind?: AttachmentAccessScope["kind"];
  allowDownload?: boolean;
}

function getSigningSecret(): string {
  const explicit = process.env.ATTACHMENT_SIGNING_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  const jwtSecret = process.env.JWT_SECRET || "nowen-note-secret-key-change-in-production";
  return crypto.createHmac("sha256", jwtSecret).update("attachment-signing-v1").digest("hex");
}

function encodeScope(scope: AttachmentAccessScope): string {
  const payload = Buffer.from(JSON.stringify(scope), "utf8").toString("base64url");
  return `${SCOPE_PREFIX}${payload}`;
}

export function createUserAttachmentScope(
  userId: string,
  noteId: string,
  allowDownload = true,
): string {
  return encodeScope({
    version: 2,
    kind: "user",
    subjectId: userId,
    noteId,
    allowDownload,
  });
}

export function createShareAttachmentScope(
  shareId: string,
  noteId: string,
  allowDownload = true,
): string {
  return encodeScope({
    version: 2,
    kind: "share",
    subjectId: shareId,
    noteId,
    allowDownload,
  });
}

export function createPublicationAttachmentScope(
  publicationId: string,
  noteId: string,
  allowDownload = true,
): string {
  return encodeScope({
    version: 2,
    kind: "publication",
    subjectId: publicationId,
    noteId,
    allowDownload,
  });
}

export function parseAttachmentAccessScope(raw: string): AttachmentAccessScope | null {
  if (!raw || raw.length > MAX_SCOPE_LENGTH || !raw.startsWith(SCOPE_PREFIX)) return null;
  try {
    const decoded = Buffer.from(raw.slice(SCOPE_PREFIX.length), "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<AttachmentAccessScope>;
    if (parsed.version !== 2) return null;
    if (parsed.kind !== "user" && parsed.kind !== "share" && parsed.kind !== "publication") return null;
    if (typeof parsed.subjectId !== "string" || !parsed.subjectId.trim()) return null;
    if (typeof parsed.noteId !== "string" || !parsed.noteId.trim()) return null;
    if (parsed.subjectId.length > 256 || parsed.noteId.length > 256) return null;
    return {
      version: 2,
      kind: parsed.kind,
      subjectId: parsed.subjectId,
      noteId: parsed.noteId,
      allowDownload: parsed.allowDownload !== false,
    } as AttachmentAccessScope;
  } catch {
    return null;
  }
}

function isExpiredDate(value: unknown): boolean {
  if (!value) return false;
  const time = new Date(String(value)).getTime();
  return Number.isFinite(time) && time <= Date.now();
}

/**
 * 复核签名 scope 当前是否仍有读取权限。
 *
 * attachmentId 会再次解析到 noteId，防止把 A 笔记签发的 scope 套到 B
 * 笔记附件。持久化查询全部位于 Repository 边界。
 */
export function verifyAttachmentAccessScope(
  attachmentId: string,
  rawScope: string,
): AttachmentSignatureVerification {
  const scope = parseAttachmentAccessScope(rawScope);
  if (!scope) {
    if (process.env.ATTACHMENT_ALLOW_LEGACY_SIGNED_SCOPE === "true") {
      return { valid: true };
    }
    return { valid: false, reason: "unsupported_scope" };
  }

  const attachment = attachmentSignedAccessRepository.findAttachmentNote(attachmentId);
  if (!attachment) {
    return { valid: false, reason: "attachment_not_found", accessKind: scope.kind };
  }
  if (!attachment.noteId || attachment.noteId !== scope.noteId) {
    return { valid: false, reason: "note_mismatch", accessKind: scope.kind };
  }

  if (scope.kind === "user") {
    const capabilities = resolveEffectiveNoteCapabilities(scope.noteId, scope.subjectId);
    if (!capabilities.read) {
      return { valid: false, reason: "user_access_revoked", accessKind: "user" };
    }
    return {
      valid: true,
      accessKind: "user",
      allowDownload: scope.allowDownload && capabilities.download,
    };
  }

  if (scope.kind === "share") {
    const share = attachmentSignedAccessRepository.findShare(scope.subjectId);
    if (!share || share.noteId !== scope.noteId || !share.isActive) {
      return { valid: false, reason: "share_access_revoked", accessKind: "share" };
    }
    if (isExpiredDate(share.expiresAt)) {
      return { valid: false, reason: "share_expired", accessKind: "share" };
    }
    return {
      valid: true,
      accessKind: "share",
      allowDownload: scope.allowDownload,
    };
  }

  try {
    const publication = attachmentSignedAccessRepository.findPublication(
      scope.subjectId,
      scope.noteId,
    );
    if (!publication || !publication.isActive) {
      return {
        valid: false,
        reason: "publication_access_revoked",
        accessKind: "publication",
      };
    }
    if (isExpiredDate(publication.expiresAt)) {
      return {
        valid: false,
        reason: "publication_expired",
        accessKind: "publication",
      };
    }
    return {
      valid: true,
      accessKind: "publication",
      allowDownload:
        scope.allowDownload && publication.allowDownload !== 0,
    };
  } catch {
    return {
      valid: false,
      reason: "publication_access_revoked",
      accessKind: "publication",
    };
  }
}

export function createAttachmentSignedParams(
  attachmentId: string,
  scope: string,
  ttlMs: number = DEFAULT_TTL_MS,
): { exp: string; sig: string; scope: string } {
  const normalizedTtl = Number.isFinite(ttlMs)
    ? Math.max(1000, ttlMs)
    : DEFAULT_TTL_MS;
  const clampedTtl = Math.min(normalizedTtl, MAX_TTL_MS);
  const exp = Math.floor((Date.now() + clampedTtl) / 1000).toString();
  const secret = getSigningSecret();
  const payload = `${attachmentId}:${exp}:${scope}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return { exp, sig, scope };
}

export function createAttachmentSignedUrl(
  baseUrl: string,
  attachmentId: string,
  scope: string,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  const params = createAttachmentSignedParams(attachmentId, scope, ttlMs);
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}exp=${params.exp}&sig=${params.sig}&scope=${encodeURIComponent(params.scope)}`;
}

export function createUserAttachmentAccessUrls(
  userId: string,
  attachments: Array<{ id: string; noteId: string }>,
): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const attachment of attachments) {
    if (!attachment.id || !attachment.noteId) continue;
    const capabilities = resolveEffectiveNoteCapabilities(attachment.noteId, userId);
    const scope = createUserAttachmentScope(
      userId,
      attachment.noteId,
      capabilities.download,
    );
    urls[attachment.id] = createAttachmentSignedUrl(
      `/api/attachments/${attachment.id}`,
      attachment.id,
      scope,
    );
  }
  return urls;
}

export function verifyAttachmentSignature(
  attachmentId: string,
  exp: string,
  sig: string,
  scope: string,
): AttachmentSignatureVerification {
  if (!attachmentId || !exp || !sig || !scope) {
    return { valid: false, reason: "missing_params" };
  }

  const expTimestamp = Number.parseInt(exp, 10);
  if (Number.isNaN(expTimestamp)) return { valid: false, reason: "invalid_exp" };

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (expTimestamp < nowSeconds) return { valid: false, reason: "expired" };
  if (expTimestamp - nowSeconds > Math.ceil(MAX_TTL_MS / 1000)) {
    return { valid: false, reason: "exp_too_long" };
  }

  const secret = getSigningSecret();
  const payload = `${attachmentId}:${exp}:${scope}`;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  try {
    const actual = Buffer.from(sig, "hex");
    const expected = Buffer.from(expectedSig, "hex");
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) {
      return { valid: false, reason: "invalid_sig" };
    }
  } catch {
    return { valid: false, reason: "invalid_sig_format" };
  }

  return verifyAttachmentAccessScope(attachmentId, scope);
}

export function isLegacyPublicUrlEnabled(): boolean {
  const value = process.env.ATTACHMENT_LEGACY_PUBLIC_URL;
  return value === "true" || value === "1";
}

export const SIGNATURE_DEFAULT_TTL_MS = DEFAULT_TTL_MS;
export const SIGNATURE_MAX_TTL_MS = MAX_TTL_MS;

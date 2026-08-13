/**
 * 附件签名 URL 工具（SEC-ATTACHMENT-01 / ISSUE-216）
 *
 * 数据库无关的 HMAC/scope 编解码位于 attachment-signed-url-core.ts，供
 * PostgreSQL runtime 使用而不加载 SQLite Repository。此文件保留 SQLite
 * runtime 的同步 ACL / 分享 / 发布复核语义。
 */

import { attachmentSignedAccessRepository } from "../repositories/attachmentSignedAccessRepository";
import { resolveEffectiveNoteCapabilities } from "../services/share-capabilities";
import {
  createAttachmentSignedUrl,
  createUserAttachmentScope,
  parseAttachmentAccessScope,
  verifyAttachmentSignatureEnvelope,
  type AttachmentSignatureVerification,
} from "./attachment-signed-url-core";

export {
  createAttachmentSignedParams,
  createAttachmentSignedUrl,
  createPublicationAttachmentScope,
  createShareAttachmentScope,
  createUserAttachmentScope,
  parseAttachmentAccessScope,
  verifyAttachmentSignatureEnvelope,
  SIGNATURE_DEFAULT_TTL_MS,
  SIGNATURE_MAX_TTL_MS,
  type AttachmentAccessScope,
  type AttachmentSignatureEnvelopeVerification,
  type AttachmentSignatureVerification,
} from "./attachment-signed-url-core";

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
      allowDownload: scope.allowDownload && publication.allowDownload !== 0,
    };
  } catch {
    return {
      valid: false,
      reason: "publication_access_revoked",
      accessKind: "publication",
    };
  }
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
  const envelope = verifyAttachmentSignatureEnvelope(attachmentId, exp, sig, scope);
  if (!envelope.valid) return envelope;
  return verifyAttachmentAccessScope(attachmentId, scope);
}

export function isLegacyPublicUrlEnabled(): boolean {
  const value = process.env.ATTACHMENT_LEGACY_PUBLIC_URL;
  return value === "true" || value === "1";
}

import crypto from "crypto";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const SCOPE_PREFIX = "v2.";
const MAX_SCOPE_LENGTH = 1024;
const EXP_QUANTIZATION_WINDOW_MS = 15 * 60 * 1000;

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

export interface AttachmentSignatureEnvelopeVerification extends AttachmentSignatureVerification {
  scope?: AttachmentAccessScope | null;
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

export function createAttachmentSignedParams(
  attachmentId: string,
  scope: string,
  ttlMs: number = DEFAULT_TTL_MS,
): { exp: string; sig: string; scope: string } {
  const normalizedTtl = Number.isFinite(ttlMs)
    ? Math.max(1000, ttlMs)
    : DEFAULT_TTL_MS;
  const clampedTtl = Math.min(normalizedTtl, MAX_TTL_MS);
  const rawExpiryMs = Date.now() + clampedTtl;
  const quantizedExpiryMs = Math.ceil(
    rawExpiryMs / EXP_QUANTIZATION_WINDOW_MS,
  ) * EXP_QUANTIZATION_WINDOW_MS;
  const exp = Math.floor(quantizedExpiryMs / 1000).toString();
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

/**
 * Validate only expiry/HMAC and decode the v2 scope. No database or ACL code is loaded here.
 * PostgreSQL runtime re-checks the returned scope asynchronously against DatabaseAdapter.
 * SQLite runtime keeps its existing synchronous scope verification on top of this envelope.
 */
export function verifyAttachmentSignatureEnvelope(
  attachmentId: string,
  exp: string,
  sig: string,
  rawScope: string,
): AttachmentSignatureEnvelopeVerification {
  if (!attachmentId || !exp || !sig || !rawScope) {
    return { valid: false, reason: "missing_params" };
  }

  const expTimestamp = Number.parseInt(exp, 10);
  if (Number.isNaN(expTimestamp)) return { valid: false, reason: "invalid_exp" };

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (expTimestamp < nowSeconds) return { valid: false, reason: "expired" };
  const maxAllowedSeconds = Math.ceil(MAX_TTL_MS / 1000)
    + Math.ceil(EXP_QUANTIZATION_WINDOW_MS / 1000);
  if (expTimestamp - nowSeconds > maxAllowedSeconds) {
    return { valid: false, reason: "exp_too_long" };
  }

  const secret = getSigningSecret();
  const payload = `${attachmentId}:${exp}:${rawScope}`;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  try {
    const actual = Buffer.from(sig, "hex");
    const expected = Buffer.from(expectedSig, "hex");
    if (
      actual.length !== expected.length
      || !crypto.timingSafeEqual(actual, expected)
    ) {
      return { valid: false, reason: "invalid_sig" };
    }
  } catch {
    return { valid: false, reason: "invalid_sig_format" };
  }

  const scope = parseAttachmentAccessScope(rawScope);
  return {
    valid: true,
    accessKind: scope?.kind,
    allowDownload: scope?.allowDownload,
    scope,
  };
}

export const SIGNATURE_DEFAULT_TTL_MS = DEFAULT_TTL_MS;
export const SIGNATURE_MAX_TTL_MS = MAX_TTL_MS;

import type { Context } from "hono";
import { Hono } from "hono";
import attachmentsCoreRouter, {
  handleDownloadAttachment as handleFullAttachmentDownload,
} from "./attachments-core";
import remoteImageImportRouter from "./remote-image-import";
import { handleAttachmentMediaRange } from "./attachment-media-range";
import { getDb } from "../db/schema";
import { inferVideoMime } from "../lib/media-mime";
import { resolvePublicOrigin } from "../lib/shareUrlRewrite";
import { resolveEffectiveNoteCapabilities } from "../services/share-capabilities";
import { authorizeSingleShareRequest, findSingleShareByToken } from "../services/single-share-access";
import { verifyLoginToken } from "../lib/auth-security";
import { hasScope, looksLikeApiToken, resolveApiToken } from "../lib/api-tokens";
import { userSessionsRepository } from "../repositories";
import {
  createAttachmentSignedUrl,
  createShareAttachmentScope,
  createUserAttachmentScope,
  verifyAttachmentSignature,
} from "../lib/attachment-signed-url";

export * from "./attachments-core";
export { inferVideoMime } from "../lib/media-mime";

const ACCESS_REVOKED_REASONS = new Set([
  "attachment_not_found",
  "note_mismatch",
  "user_access_revoked",
  "share_access_revoked",
  "share_expired",
]);

function requestPublicOrigin(c: Context): string {
  return resolvePublicOrigin((name) => c.req.header(name)) || "";
}

function buildSignedAttachmentUrls(
  noteId: string,
  scope: string,
  origin: string,
): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT id FROM attachments WHERE "noteId" = ? ORDER BY id ASC')
    .all(noteId) as Array<{ id: string }>;
  const normalizedOrigin = origin.replace(/\/+$/, "");
  const urls: Record<string, string> = {};
  for (const row of rows) {
    const path = `/api/attachments/${row.id}`;
    const baseUrl = normalizedOrigin ? `${normalizedOrigin}${path}` : path;
    urls[row.id] = createAttachmentSignedUrl(baseUrl, row.id, scope);
  }
  return urls;
}

function noStoreJson(
  c: Context,
  payload: unknown,
  status: 200 | 400 | 401 | 403 | 404 | 410 = 200,
): Response {
  c.header("Cache-Control", "private, no-store");
  c.header("Pragma", "no-cache");
  return c.json(payload, status);
}

function readClientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip")
    || "";
}

/**
 * The download route is registered before the global JWT middleware so native <img>/<video>
 * requests can use signed URLs. Never trust a caller-provided X-User-Id at this boundary.
 */
function resolveVerifiedAttachmentUser(c: Context): string {
  const authHeader = c.req.header("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  const token = authHeader.slice(7).trim();
  if (!token) return "";

  const db = getDb();
  if (looksLikeApiToken(token)) {
    const resolved = resolveApiToken(db, token, readClientIp(c));
    if (!resolved || !hasScope(resolved, "notes:read")) return "";
    const user = db
      .prepare('SELECT "isDisabled" FROM users WHERE id = ?')
      .get(resolved.userId) as { isDisabled: number } | undefined;
    return user && !user.isDisabled ? resolved.userId : "";
  }

  const payload = verifyLoginToken(token);
  if (!payload?.userId) return "";
  const user = db
    .prepare('SELECT "tokenVersion", "isDisabled" FROM users WHERE id = ?')
    .get(payload.userId) as { tokenVersion: number; isDisabled: number } | undefined;
  if (!user || user.isDisabled || (payload.tver ?? 0) !== (user.tokenVersion ?? 0)) return "";
  if (payload.jti) {
    const session = userSessionsRepository.getByIdAndUser(payload.jti, payload.userId);
    if (!session || session.revokedAt) return "";
  }
  return payload.userId;
}

/** Public bridge endpoint used by /share/:token. */
function handleSharedAttachmentAccess(c: Context): Response {
  const token = (c.req.query("token") || "").trim();
  if (!token || token.length > 256) {
    return noStoreJson(c, { error: "缺少有效分享令牌", code: "SHARE_TOKEN_REQUIRED" }, 400);
  }

  const share = findSingleShareByToken(token);
  const access = authorizeSingleShareRequest(c, share, { requireCredential: true });
  if (!access.ok) return noStoreJson(c, access.payload, access.status);
  const scope = createShareAttachmentScope(share!.id, share!.noteId, true);
  return noStoreJson(c, {
    noteId: share!.noteId,
    urls: buildSignedAttachmentUrls(share!.noteId, scope, requestPublicOrigin(c)),
  });
}

/** Normalize known video extensions after successful upload. */
const attachmentsRouter = new Hono();
attachmentsRouter.use("*", async (c, next) => {
  await next();
  if (c.req.method !== "POST" || c.res.status !== 201) return;

  let payload: Record<string, unknown>;
  try {
    payload = await c.res.clone().json() as Record<string, unknown>;
  } catch {
    return;
  }

  const currentMime = String(payload.mimeType || "").toLowerCase();
  if (currentMime && currentMime !== "application/octet-stream") return;
  const inferred = inferVideoMime(String(payload.filename || ""));
  const id = String(payload.id || "");
  if (!inferred || !id) return;

  try {
    getDb()
      .prepare(
        "UPDATE attachments SET mimeType = ? WHERE id = ? AND (mimeType IS NULL OR mimeType = '' OR mimeType = 'application/octet-stream')",
      )
      .run(inferred, id);
  } catch {
    return;
  }

  const headers = new Headers(c.res.headers);
  headers.set("Content-Type", "application/json; charset=UTF-8");
  c.res = new Response(JSON.stringify({ ...payload, mimeType: inferred }), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
});

/** Exchange current note read permission for short-lived attachment URLs. */
attachmentsRouter.get("/access/urls", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const noteId = (c.req.query("noteId") || "").trim();
  if (!noteId) {
    return noStoreJson(c, { error: "缺少 noteId", code: "NOTE_ID_REQUIRED" }, 400);
  }

  const capabilities = resolveEffectiveNoteCapabilities(noteId, userId);
  if (!capabilities.read) {
    console.warn("[attachment.access.denied]", { noteId, userId, reason: "note_read_forbidden" });
    return noStoreJson(
      c,
      { error: "无权访问该笔记的附件", code: "ATTACHMENT_ACCESS_DENIED" },
      403,
    );
  }

  const scope = createUserAttachmentScope(userId, noteId, capabilities.download);
  return noStoreJson(c, {
    noteId,
    urls: buildSignedAttachmentUrls(noteId, scope, requestPublicOrigin(c)),
  });
});

attachmentsRouter.route("/", remoteImageImportRouter);
attachmentsRouter.route("/", attachmentsCoreRouter);

export default attachmentsRouter;

function hardenScopedResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, no-transform");
  headers.set("Pragma", "no-cache");
  headers.set("Vary", "Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Preserve canonical attachment handler while allowing byte-range responses first. */
export async function handleDownloadAttachment(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (id === "share-access") return handleSharedAttachmentAccess(c);

  c.req.raw.headers.delete("X-User-Id");
  const verifiedUserId = resolveVerifiedAttachmentUser(c);
  if (verifiedUserId) c.req.raw.headers.set("X-User-Id", verifiedUserId);

  const exp = c.req.query("exp");
  const sig = c.req.query("sig");
  const scope = c.req.query("scope");
  const hasAnySignaturePart = Boolean(exp || sig || scope);
  const hasCompleteSignature = Boolean(exp && sig && scope);

  if (hasAnySignaturePart && !hasCompleteSignature) {
    console.warn("[attachment.access.denied]", { id, reason: "incomplete_signature" });
    return c.json({ error: "附件访问签名不完整", code: "INVALID_SIGNATURE" }, 403);
  }

  let signatureVerification: ReturnType<typeof verifyAttachmentSignature> | null = null;
  if (hasCompleteSignature) {
    const verification = verifyAttachmentSignature(id, exp!, sig!, scope!);
    signatureVerification = verification;
    if (!verification.valid) {
      const revoked = ACCESS_REVOKED_REASONS.has(verification.reason || "");
      console.warn("[attachment.access.denied]", {
        id,
        reason: verification.reason,
        accessKind: verification.accessKind,
      });
      return c.json(
        revoked
          ? {
              error: "您已无权访问该附件，分享可能已撤销或成员权限已移除",
              code: "ATTACHMENT_ACCESS_REVOKED",
              reason: verification.reason,
            }
          : {
              error: "签名无效或已过期",
              code: "INVALID_SIGNATURE",
              reason: verification.reason,
            },
        403,
      );
    }
  }

  const downloadRequested = /^(?:1|true|yes)$/i.test(c.req.query("download") || "");
  if (downloadRequested && signatureVerification?.allowDownload === false) {
    console.warn("[attachment.access.denied]", { id, reason: "download_forbidden" });
    return c.json({ error: "当前分享不允许下载附件", code: "ATTACHMENT_DOWNLOAD_FORBIDDEN" }, 403);
  }

  const metadataExists = Boolean(
    getDb().prepare("SELECT 1 AS ok FROM attachments WHERE id = ?").get(id),
  );

  let delegated = false;
  const rangeResponse = await handleAttachmentMediaRange(c, async () => {
    delegated = true;
  });
  const response = !delegated && rangeResponse instanceof Response
    ? rangeResponse
    : await handleFullAttachmentDownload(c);

  if (response.status === 404) {
    console.warn(
      metadataExists ? "[attachment.file.missing]" : "[attachment.metadata.missing]",
      { id },
    );
  } else if (response.status === 401 || response.status === 403) {
    console.warn("[attachment.access.denied]", { id, status: response.status });
  }

  return hasCompleteSignature || verifiedUserId
    ? hardenScopedResponse(response)
    : response;
}

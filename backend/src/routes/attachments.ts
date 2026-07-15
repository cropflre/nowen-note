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
import { hasPermission, resolveNotePermission } from "../middleware/acl";
import { verifyLoginToken, verifyShareAccessToken } from "../lib/auth-security";
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

interface ShareAccessRow {
  id: string;
  noteId: string;
  password: string | null;
  isActive: number;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
}

const ACCESS_REVOKED_REASONS = new Set([
  "attachment_not_found",
  "note_mismatch",
  "user_access_revoked",
  "share_access_revoked",
  "share_expired",
]);

function isExpiredDate(value: unknown): boolean {
  if (!value) return false;
  const time = new Date(String(value)).getTime();
  return Number.isFinite(time) && time <= Date.now();
}

function requestPublicOrigin(c: Context): string {
  return resolvePublicOrigin((name) => c.req.header(name)) || "";
}

function buildSignedAttachmentUrls(noteId: string, scope: string, origin: string): Record<string, string> {
  const rows = getDb()
    .prepare("SELECT id FROM attachments WHERE noteId = ? ORDER BY id ASC")
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

function noStoreJson(c: Context, payload: unknown, status: 200 | 400 | 401 | 403 | 404 | 410 = 200): Response {
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
 * For API clients that do send Authorization, independently verify the Bearer credential and
 * only then inject X-User-Id for the mature ACL handler below.
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
      .prepare("SELECT isDisabled FROM users WHERE id = ?")
      .get(resolved.userId) as { isDisabled: number } | undefined;
    return user && !user.isDisabled ? resolved.userId : "";
  }

  const payload = verifyLoginToken(token);
  if (!payload?.userId) return "";
  const user = db
    .prepare("SELECT tokenVersion, isDisabled FROM users WHERE id = ?")
    .get(payload.userId) as { tokenVersion: number; isDisabled: number } | undefined;
  if (!user || user.isDisabled || (payload.tver ?? 0) !== (user.tokenVersion ?? 0)) return "";
  if (payload.jti) {
    const session = userSessionsRepository.getByIdAndUser(payload.jti, payload.userId);
    if (!session || session.revokedAt) return "";
  }
  return payload.userId;
}

/**
 * Public bridge endpoint used by /share/:token.
 *
 * It intentionally lives at the single-segment path `/api/attachments/share-access`,
 * which is handled by the pre-JWT attachment route. Password protected shares must
 * forward the temporary share access token in Authorization.
 */
function handleSharedAttachmentAccess(c: Context): Response {
  const token = (c.req.query("token") || "").trim();
  if (!token || token.length > 256) {
    return noStoreJson(c, { error: "缺少有效分享令牌", code: "SHARE_TOKEN_REQUIRED" }, 400);
  }

  const share = getDb()
    .prepare(
      `SELECT id, noteId, password, isActive, expiresAt, maxViews, viewCount
       FROM shares WHERE shareToken = ?`,
    )
    .get(token) as ShareAccessRow | undefined;

  if (!share) {
    return noStoreJson(c, { error: "分享不存在", code: "SHARE_NOT_FOUND" }, 404);
  }
  if (!share.isActive) {
    return noStoreJson(c, { error: "分享已被撤销", code: "SHARE_REVOKED" }, 410);
  }
  if (isExpiredDate(share.expiresAt)) {
    return noStoreJson(c, { error: "分享已过期", code: "SHARE_EXPIRED" }, 410);
  }
  // 该接口由前端在获取正文之前调用。达到次数上限后不再签发新的附件 URL；
  // 已经签发的 URL 仍会继续按分享撤销/过期状态逐请求复核。
  if (share.maxViews && share.viewCount >= share.maxViews) {
    return noStoreJson(c, { error: "分享已达到最大访问次数", code: "SHARE_VIEW_LIMIT" }, 410);
  }

  if (share.password) {
    const authHeader = c.req.header("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return noStoreJson(c, { error: "需要密码验证", code: "SHARE_PASSWORD_REQUIRED" }, 401);
    }
    const payload = verifyShareAccessToken(authHeader.slice(7), share.id);
    if (!payload) {
      return noStoreJson(c, { error: "分享访问令牌无效或已过期", code: "SHARE_ACCESS_TOKEN_INVALID" }, 401);
    }
  }

  const scope = createShareAttachmentScope(share.id, share.noteId);
  return noStoreJson(c, {
    noteId: share.noteId,
    urls: buildSignedAttachmentUrls(share.noteId, scope, requestPublicOrigin(c)),
  });
}

/**
 * Some Android document providers return an empty MIME even for an MP4. The core upload route is
 * intentionally format-agnostic and stores application/octet-stream in that case. Normalize only
 * known video extensions after a successful upload so playback and Range handling receive the
 * correct Content-Type without weakening executable-file checks.
 */
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

/**
 * Authenticated users exchange their current note read permission for short-lived,
 * re-checkable attachment URLs. This route is mounted after the global JWT middleware.
 */
attachmentsRouter.get("/access/urls", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const noteId = (c.req.query("noteId") || "").trim();
  if (!noteId) return noStoreJson(c, { error: "缺少 noteId", code: "NOTE_ID_REQUIRED" }, 400);

  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "read")) {
    console.warn("[attachment.access.denied]", { noteId, userId, reason: "note_read_forbidden" });
    return noStoreJson(c, { error: "无权访问该笔记的附件", code: "ATTACHMENT_ACCESS_DENIED" }, 403);
  }

  const scope = createUserAttachmentScope(userId, noteId);
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
  // 授权可随时撤销，禁止浏览器/CDN 把成功响应长期缓存后绕过服务端复核。
  headers.set("Cache-Control", "private, no-store, no-transform");
  headers.set("Pragma", "no-cache");
  headers.set("Vary", "Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Preserve the canonical attachment handler while allowing seekable media to answer byte-range
 * requests first. Keeping this wrapper at the original module path means index.ts, tests and every
 * existing importer automatically receive Range support without duplicating route registration.
 */
export async function handleDownloadAttachment(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (id === "share-access") return handleSharedAttachmentAccess(c);

  // Strip the untrusted pre-JWT identity header, then restore it only after Bearer verification.
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

  if (hasCompleteSignature) {
    const verification = verifyAttachmentSignature(id, exp!, sig!, scope!);
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

  return hasCompleteSignature || verifiedUserId ? hardenScopedResponse(response) : response;
}

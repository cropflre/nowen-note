import type { Context, Next } from "hono";
import { hasPermission, resolveNotePermission } from "../middleware/acl";
import { parseSingleHttpRange } from "../lib/http-range";
import { inferVideoMime } from "../lib/media-mime";
import { attachmentMediaRepository } from "../repositories";
import type { MediaAttachmentRecord } from "../repositories/attachmentMediaRepository";
import { getAttachmentSize, readAttachmentRange } from "../services/attachment-storage";

function isSeekableMediaMime(mimeType: string): boolean {
  const mime = (mimeType || "").toLowerCase();
  return mime.startsWith("video/") || mime.startsWith("audio/");
}

async function authorizeMediaRange(c: Context, row: MediaAttachmentRecord): Promise<Response | null> {
  const exp = c.req.query("exp");
  const sig = c.req.query("sig");
  const scope = c.req.query("scope");
  const userId = c.req.header("X-User-Id") || "";

  if (exp && sig && scope) {
    const { verifyAttachmentSignature } = await import("../lib/attachment-signed-url");
    const result = verifyAttachmentSignature(row.id, exp, sig, scope);
    if (!result.valid) {
      return c.json(
        { error: "签名无效或已过期", code: "INVALID_SIGNATURE", reason: result.reason },
        403,
      );
    }
    return null;
  }

  if (row.noteId && userId) {
    const { permission } = resolveNotePermission(row.noteId, userId);
    if (!hasPermission(permission, "read")) {
      return c.json({ error: "无权访问该附件" }, 403);
    }
    return null;
  }

  const { isLegacyPublicUrlEnabled } = await import("../lib/attachment-signed-url");
  if (!isLegacyPublicUrlEnabled()) {
    return c.json(
      { error: "需要签名 URL 或登录凭证", code: "SIGNATURE_REQUIRED" },
      401,
    );
  }
  return null;
}

/**
 * Range middleware registered before the legacy full-buffer attachment handler.
 *
 * It only takes over audio/video byte-range requests. Images, documents, explicit downloads and
 * ordinary full responses continue through the existing handler unchanged. This keeps ACL and
 * signed URL semantics identical while allowing HTMLVideoElement to seek without downloading the
 * whole file again.
 */
export async function handleAttachmentMediaRange(c: Context, next: Next): Promise<Response | void> {
  const id = c.req.param("id");
  const row = await attachmentMediaRepository.getByIdAsync(id);

  // Let the canonical handler produce the existing 404 shape for unknown attachments.
  if (!row) {
    await next();
    return;
  }

  // Historical Android providers sometimes stored MP4/MOV rows as application/octet-stream.
  // Repair only a known video extension, then delegate/full-serve with the corrected MIME so old
  // notes gain inline playback and seeking without a data migration or re-upload.
  if (!isSeekableMediaMime(row.mimeType)) {
    const inferred = inferVideoMime(row.filename);
    if (!inferred) {
      await next();
      return;
    }
    try {
      await attachmentMediaRepository.repairGenericMimeAsync(row.id, inferred);
      row.mimeType = inferred;
    } catch {
      // The response can still use the inferred MIME even if a read-only database blocks repair.
      row.mimeType = inferred;
    }
  }

  c.header("Accept-Ranges", "bytes");

  // `download=1` is an explicit user action and must retain forced-download semantics.
  if (c.req.query("download") === "1") {
    await next();
    return;
  }

  const rangeHeader = c.req.header("Range");
  if (!rangeHeader) {
    await next();
    return;
  }

  const denied = await authorizeMediaRange(c, row);
  if (denied) return denied;

  const measuredSize = await getAttachmentSize(row.path);
  const totalSize = measuredSize ?? (Number.isSafeInteger(row.size) ? row.size : 0);
  const parsed = parseSingleHttpRange(rangeHeader, totalSize);

  if (!parsed || !parsed.ok) {
    return new Response(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${Math.max(0, totalSize)}`,
        "Cache-Control": "no-store, no-transform",
        "Content-Encoding": "identity",
      },
    });
  }

  const chunk = await readAttachmentRange(row.path, parsed.start, parsed.end);
  if (!chunk || chunk.length !== parsed.length) {
    return c.json({ error: "attachment file missing or range unavailable" }, 404);
  }

  return new Response(new Uint8Array(chunk), {
    status: 206,
    headers: {
      "Content-Type": row.mimeType || "application/octet-stream",
      "Content-Length": String(parsed.length),
      "Content-Range": `bytes ${parsed.start}-${parsed.end}/${totalSize}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable, no-transform",
      // /api/* is wrapped by Hono compress(). Marking the representation as identity prevents
      // gzip from changing byte offsets and invalidating Content-Range / Content-Length.
      "Content-Encoding": "identity",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

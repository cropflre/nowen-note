import { Hono } from "hono";
import { getDb } from "../db/schema";
import {
  getUserWorkspaceRole,
  requireWorkspaceFeature,
} from "../middleware/acl";
import {
  resolveFileAttachmentAccess,
  type FileAttachmentAccessRow,
} from "../services/fileAttachmentAccess";
import { assetIds } from "../services/asset-organization";
import { readAttachmentObject } from "../services/attachment-storage";
import {
  imageDistance,
  imageFeatures,
  SIMILAR_IMAGE_MAX_BYTES,
  SIMILAR_IMAGE_MIMES,
} from "../services/image-similarity";
import { createUserAttachmentAccessUrls } from "../lib/attachment-signed-url";

const app = new Hono();
type Row = FileAttachmentAccessRow & {
  id: string;
  filename: string;
  mimeType: string;
  path: string;
  size: number;
  folderId: string | null;
  trashedAt: string | null;
};
class ToolError extends Error {
  constructor(
    public code: string,
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 429,
    message: string,
  ) {
    super(message);
  }
}
function scope(userId: string, workspaceId: string | null) {
  if (workspaceId && !getUserWorkspaceRole(workspaceId, userId))
    throw new ToolError("FORBIDDEN", 403, "You cannot access this workspace.");
}
function read(id: string): Row | undefined {
  return getDb()
    .prepare("SELECT * FROM attachments WHERE id=? AND trashedAt IS NULL")
    .get(id) as Row | undefined;
}
app.onError((error, c) => {
  if (error instanceof ToolError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error.message === "INVALID_ASSET_IDS")
    return c.json(
      { error: "Choose up to 200 files.", code: error.message },
      400,
    );
  console.error("[asset-visual-tools] failed", { name: error.name });
  return c.json(
    {
      error: "File operation failed. Refresh and try again.",
      code: "FILE_TOOL_FAILED",
    },
    500,
  );
});
app.use("*", async (c, next) => {
  const userId = c.req.header("X-User-Id");
  if (!userId)
    throw new ToolError("UNAUTHORIZED", 401, "Sign in to use file tools.");
  scope(
    userId,
    c.req.query("workspaceId") && c.req.query("workspaceId") !== "personal"
      ? c.req.query("workspaceId")!
      : null,
  );
  c.header("Cache-Control", "private, no-store");
  await next();
});
app.use("*", requireWorkspaceFeature("files"));
let activeScans = 0;
app.get("/similar/:id", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const workspaceId =
    c.req.query("workspaceId") && c.req.query("workspaceId") !== "personal"
      ? c.req.query("workspaceId")!
      : null;
  const anchor = read(c.req.param("id"));
  if (!anchor || !resolveFileAttachmentAccess(anchor, userId).canDownload)
    throw new ToolError("FILE_NOT_FOUND", 404, "Image not found.");
  if (anchor.workspaceId !== workspaceId)
    throw new ToolError(
      "FILE_SCOPE_MISMATCH",
      409,
      "Choose an image in the current space.",
    );
  if (
    !SIMILAR_IMAGE_MIMES.includes(anchor.mimeType) ||
    anchor.size > SIMILAR_IMAGE_MAX_BYTES
  )
    throw new ToolError(
      "IMAGE_UNSUPPORTED",
      422,
      "Choose a PNG, JPEG, WebP, GIF or BMP image up to 20 MiB.",
    );
  const after = c.req.query("after") || "";
  if (after && !/^[\w-]{1,100}$/.test(after))
    throw new ToolError("INVALID_CURSOR", 400, "Refresh the image search.");
  if (activeScans >= 2)
    throw new ToolError(
      "IMAGE_SEARCH_BUSY",
      429,
      "Image search is busy. Please try again shortly.",
    );
  activeScans++;
  try {
    let reference: Awaited<ReturnType<typeof imageFeatures>>;
    try {
      const bytes = await readAttachmentObject(anchor.path);
      if (!bytes || bytes.length > SIMILAR_IMAGE_MAX_BYTES) throw new Error();
      reference = await imageFeatures(bytes);
    } catch {
      throw new ToolError(
        "IMAGE_UNAVAILABLE",
        422,
        "This image could not be read or decoded.",
      );
    }
    const rows = getDb()
      .prepare(
        `SELECT * FROM attachments WHERE trashedAt IS NULL AND id<>? AND id>? AND mimeType IN (${SIMILAR_IMAGE_MIMES.map(() => "?").join(",")}) AND ${workspaceId ? "workspaceId=?" : "workspaceId IS NULL AND userId=?"} ORDER BY id`,
      )
      .all(
        anchor.id,
        after,
        ...SIMILAR_IMAGE_MIMES,
        workspaceId || userId,
      ) as Row[];
    const visible = rows.filter(
      (row) => resolveFileAttachmentAccess(row, userId).canDownload,
    );
    const page = visible.slice(0, 20);
    const matches: Array<{
      id: string;
      filename: string;
      distance: number;
      size: number;
    }> = [];
    let skipped = 0;
    for (const row of page) {
      if (c.req.raw.signal.aborted) break;
      try {
        if (row.size > SIMILAR_IMAGE_MAX_BYTES) throw new Error();
        const bytes = await readAttachmentObject(row.path);
        if (!bytes || bytes.length > SIMILAR_IMAGE_MAX_BYTES) throw new Error();
        const distance = imageDistance(reference, await imageFeatures(bytes));
        if (distance !== null)
          matches.push({
            id: row.id,
            filename: row.filename,
            distance,
            size: row.size,
          });
      } catch {
        skipped++;
      }
    }
    // Re-check live ACL/trash after asynchronous storage/decoder work.
    scope(userId, workspaceId);
    const current = read(anchor.id);
    if (
      !current ||
      current.workspaceId !== workspaceId ||
      !resolveFileAttachmentAccess(current, userId).canDownload
    )
      throw new ToolError(
        "FILE_NOT_FOUND",
        404,
        "Image is no longer available.",
      );
    const allowed = matches.filter((match) => {
      const row = read(match.id);
      return (
        row?.workspaceId === workspaceId &&
        resolveFileAttachmentAccess(row, userId).canDownload
      );
    });
    allowed.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    return c.json({
      matches: allowed,
      examined: page.length,
      skipped,
      nextAfter: visible.length > page.length ? page.at(-1)!.id : null,
      accessUrls: createUserAttachmentAccessUrls(
        userId,
        allowed.map((match) => read(match.id)!),
      ),
    });
  } finally {
    activeScans--;
  }
});
const extension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
};
app.post("/batch-rename", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const workspaceId =
    c.req.query("workspaceId") && c.req.query("workspaceId") !== "personal"
      ? c.req.query("workspaceId")!
      : null;
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.items))
    throw new ToolError("INVALID_RENAME", 400, "Provide the rename preview.");
  const ids = assetIds(body.items.map((item: Row) => item?.id));
  if (ids.length !== body.items.length)
    throw new ToolError("INVALID_RENAME", 400, "Choose each file only once.");
  const items = body.items as Array<{
    id: string;
    filename: string;
    expectedFilename: string;
  }>;
  const db = getDb();
  db.transaction(() => {
    for (const item of items) {
      const row = read(item.id);
      if (!row)
        throw new ToolError(
          "FILE_NOT_FOUND",
          404,
          "A file is no longer available. Refresh the preview.",
        );
      if (
        row.userId !== userId ||
        !resolveFileAttachmentAccess(row, userId).canWrite
      )
        throw new ToolError(
          "FORBIDDEN",
          403,
          "You cannot rename every selected file.",
        );
      if (row.workspaceId !== workspaceId)
        throw new ToolError(
          "FILE_SCOPE_MISMATCH",
          409,
          "Choose files in the current space.",
        );
      if (
        typeof item.expectedFilename !== "string" ||
        item.expectedFilename !== row.filename
      )
        throw new ToolError(
          "FILE_NAME_CONFLICT",
          409,
          "A file name changed. Refresh the preview before retrying.",
        );
      // eslint-disable-next-line no-control-regex
      if (
        typeof item.filename !== "string" ||
        !item.filename.trim() ||
        item.filename !== item.filename.trim() ||
        item.filename.length > 255 ||
        /[\\/\x00-\x1f\x7f]/.test(item.filename) ||
        extension(item.filename) !== extension(row.filename)
      )
        throw new ToolError(
          "INVALID_RENAME",
          400,
          "Use valid names and keep the original extensions.",
        );
    }
    for (const item of items)
      db.prepare("UPDATE attachments SET filename=? WHERE id=?").run(
        item.filename,
        item.id,
      );
  })();
  return c.json({ success: true, renamed: items.length });
});
export default app;

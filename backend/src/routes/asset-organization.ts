import { Hono } from "hono";
import type { Context } from "hono";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema.js";
import {
  getUserWorkspaceRole,
  hasRole,
  requireWorkspaceFeature,
} from "../middleware/acl.js";
import {
  resolveFileAttachmentAccess,
  type FileAttachmentAccessRow,
} from "../services/fileAttachmentAccess.js";
import {
  assetIds,
  assetDuplicates,
  parseAssetFilters,
} from "../services/asset-organization.js";

const app = new Hono();
class AssetError extends Error {
  constructor(
    public code: string,
    public status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
function scope(c: Context) {
  const userId = c.req.header("X-User-Id")!;
  const raw = c.req.query("workspaceId");
  const workspaceId = raw && raw !== "personal" ? raw : null;
  const role = workspaceId ? getUserWorkspaceRole(workspaceId, userId) : null;
  if (workspaceId && !role)
    throw new AssetError("FORBIDDEN", 403, "You cannot access this workspace.");
  return {
    userId,
    workspaceId,
    canManageTags: !workspaceId || hasRole(role, "editor"),
  };
}
function tagScope(userId: string, workspaceId: string | null) {
  return {
    sql: workspaceId ? "workspaceId = ?" : "userId = ? AND workspaceId IS NULL",
    value: workspaceId || userId,
  };
}
function nameFields(body: Record<string, unknown>) {
  if (typeof body.name !== "string")
    throw new AssetError("INVALID_NAME", 400, "Enter a name.");
  const name = body.name.trim().normalize("NFKC");
  if (!name || name.length > 100)
    throw new AssetError(
      "INVALID_NAME",
      400,
      "Names must contain 1 to 100 characters.",
    );
  return { name, normalizedName: name.toLocaleLowerCase("en-US") };
}
async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AssetError("INVALID_BODY", 400, "Provide a valid object.");
  return body;
}
function readAsset(id: string, userId: string) {
  const row = getDb()
    .prepare(
      "SELECT id,noteId,userId,workspaceId,uploadSource,filename,hash FROM attachments WHERE id=?",
    )
    .get(id) as
    | (FileAttachmentAccessRow & {
        id: string;
        filename: string;
        hash: string | null;
      })
    | undefined;
  if (!row || !resolveFileAttachmentAccess(row, userId).canView)
    throw new AssetError("FILE_NOT_FOUND", 404, "File not found.");
  return row;
}
app.onError((error, c) => {
  if (error instanceof AssetError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof Error && error.message.startsWith("INVALID_"))
    return c.json(
      {
        error: "Check the file filters or selected items.",
        code: error.message,
      },
      400,
    );
  if (error instanceof Error && /UNIQUE constraint/.test(error.message))
    return c.json(
      {
        error: "A name already exists in this space.",
        code: "ASSET_NAME_CONFLICT",
      },
      409,
    );
  console.error("[asset-organization] operation failed", { name: error.name });
  return c.json(
    { error: "File organization failed.", code: "ASSET_OPERATION_FAILED" },
    500,
  );
});
app.use("*", async (c, next) => {
  if (!c.req.header("X-User-Id"))
    return c.json(
      { error: "Sign in to organize files.", code: "UNAUTHORIZED" },
      401,
    );
  scope(c);
  await next();
});
app.use("*", requireWorkspaceFeature("files"));
app.get("/", (c) => {
  const { userId, workspaceId, canManageTags } = scope(c);
  const where = tagScope(userId, workspaceId);
  const tagPage = Number(c.req.query("tagPage") || 1),
    smartPage = Number(c.req.query("smartPage") || 1);
  const q = (c.req.query("q") || "").trim();
  if (
    ![tagPage, smartPage].every(
      (page) => Number.isSafeInteger(page) && page > 0 && page <= 100000,
    ) ||
    q.length > 100
  )
    throw new AssetError(
      "INVALID_PAGE",
      400,
      "Check the search and page number.",
    );
  const tags = getDb()
    .prepare(
      `SELECT id,name,color FROM asset_tags WHERE ${where.sql} AND normalizedName LIKE ? ORDER BY normalizedName,id LIMIT 201 OFFSET ?`,
    )
    .all(
      where.value,
      `%${q.normalize("NFKC").toLocaleLowerCase("en-US")}%`,
      (tagPage - 1) * 200,
    );
  const smartFolders = getDb()
    .prepare(
      `SELECT id,name,filters FROM asset_smart_folders WHERE userId=? AND workspaceId IS ? ORDER BY normalizedName,id LIMIT 201 OFFSET ?`,
    )
    .all(userId, workspaceId, (smartPage - 1) * 200) as Array<{
    id: string;
    name: string;
    filters: string;
  }>;
  return c.json({
    supported: true,
    canManageTags,
    tagPage,
    smartPage,
    hasMoreTags: tags.length > 200,
    hasMoreSmartFolders: smartFolders.length > 200,
    tags: tags.slice(0, 200),
    smartFolders: smartFolders
      .slice(0, 200)
      .map((folder) => ({ ...folder, filters: JSON.parse(folder.filters) })),
  });
});
app.get("/assets/:id", (c) => {
  const { userId, workspaceId } = scope(c);
  const row = readAsset(c.req.param("id"), userId);
  if (row.workspaceId !== workspaceId)
    throw new AssetError(
      "FILE_SCOPE_MISMATCH",
      409,
      "Choose a file in the current space.",
    );
  const tags = getDb()
    .prepare(
      `SELECT t.id,t.name,t.color FROM asset_tags t JOIN asset_tag_relations r ON r.tagId=t.id WHERE r.attachmentId=? ORDER BY t.normalizedName`,
    )
    .all(row.id);
  return c.json({
    tags,
    duplicates: assetDuplicates(row, userId),
    canManage:
      row.userId === userId &&
      resolveFileAttachmentAccess(row, userId).canWrite,
  });
});
app.post("/tags", async (c) => {
  const body = await readBody(c);
  const { userId, workspaceId, canManageTags } = scope(c);
  if (!canManageTags)
    throw new AssetError(
      "FORBIDDEN",
      403,
      "Editor permission is required to manage tags.",
    );
  const { name, normalizedName } = nameFields(body);
  const color = body.color ?? "#58a6ff";
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))
    throw new AssetError("INVALID_COLOR", 400, "Choose a six digit color.");
  const id = uuid();
  getDb()
    .prepare(
      "INSERT INTO asset_tags (id,userId,workspaceId,name,normalizedName,color) VALUES (?,?,?,?,?,?)",
    )
    .run(id, userId, workspaceId, name, normalizedName, color);
  return c.json({ tag: { id, name, color } }, 201);
});
app.patch("/tags/:id", async (c) => {
  const body = await readBody(c);
  const { userId, workspaceId, canManageTags } = scope(c);
  if (!canManageTags)
    throw new AssetError(
      "FORBIDDEN",
      403,
      "Editor permission is required to manage tags.",
    );
  const { name, normalizedName } = nameFields(body);
  const color = body.color;
  if (
    color !== undefined &&
    (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))
  )
    throw new AssetError("INVALID_COLOR", 400, "Choose a six digit color.");
  const where = tagScope(userId, workspaceId);
  const result = getDb()
    .prepare(
      `UPDATE asset_tags SET name=?,normalizedName=?,color=COALESCE(?,color),updatedAt=CURRENT_TIMESTAMP WHERE id=? AND ${where.sql}`,
    )
    .run(name, normalizedName, color ?? null, c.req.param("id"), where.value);
  if (!result.changes)
    throw new AssetError("ASSET_TAG_NOT_FOUND", 404, "Tag not found.");
  return c.json({ success: true });
});
app.delete("/tags/:id", (c) => {
  const { userId, workspaceId, canManageTags } = scope(c);
  if (!canManageTags)
    throw new AssetError(
      "FORBIDDEN",
      403,
      "Editor permission is required to manage tags.",
    );
  const where = tagScope(userId, workspaceId);
  if (
    !getDb()
      .prepare(`DELETE FROM asset_tags WHERE id=? AND ${where.sql}`)
      .run(c.req.param("id"), where.value).changes
  )
    throw new AssetError("ASSET_TAG_NOT_FOUND", 404, "Tag not found.");
  return c.json({ success: true });
});
app.post("/tag-files", async (c) => {
  const body = await readBody(c);
  const { userId, workspaceId, canManageTags } = scope(c);
  if (!canManageTags)
    throw new AssetError(
      "FORBIDDEN",
      403,
      "Editor permission is required to organize files.",
    );
  const ids = assetIds(body.ids);
  const tagIds = assetIds(body.tagIds, 50);
  if (!["add", "remove"].includes(String(body.operation)))
    throw new AssetError(
      "INVALID_OPERATION",
      400,
      "Choose add or remove tags.",
    );
  getDb().transaction(() => {
    const where = tagScope(userId, workspaceId);
    for (const id of tagIds)
      if (
        !getDb()
          .prepare(`SELECT 1 FROM asset_tags WHERE id=? AND ${where.sql}`)
          .get(id, where.value)
      )
        throw new AssetError(
          "ASSET_TAG_NOT_FOUND",
          404,
          "Tag not found in this space.",
        );
    for (const id of ids) {
      const row = getDb()
        .prepare(
          "SELECT id,noteId,userId,workspaceId,uploadSource FROM attachments WHERE id=?",
        )
        .get(id) as FileAttachmentAccessRow | undefined;
      if (
        !row ||
        row.userId !== userId ||
        !resolveFileAttachmentAccess(row, userId).canWrite
      )
        throw new AssetError(
          "FORBIDDEN",
          403,
          "You cannot organize one or more selected files.",
        );
      if (row.workspaceId !== workspaceId)
        throw new AssetError(
          "FILE_SCOPE_MISMATCH",
          409,
          "All files must belong to the current space.",
        );
    }
    const statement = getDb().prepare(
      body.operation === "add"
        ? "INSERT OR IGNORE INTO asset_tag_relations (attachmentId,tagId) VALUES (?,?)"
        : "DELETE FROM asset_tag_relations WHERE attachmentId=? AND tagId=?",
    );
    for (const id of ids) for (const tagId of tagIds) statement.run(id, tagId);
  })();
  return c.json({ success: true, updated: ids.length });
});
for (const method of ["post", "patch"] as const)
  app[method](
    method === "post" ? "/smart-folders" : "/smart-folders/:id",
    async (c) => {
      const body = await readBody(c);
      const { userId, workspaceId } = scope(c);
      const { name, normalizedName } = nameFields(body);
      const filters = parseAssetFilters(
        body.filters as Record<string, unknown>,
        true,
      );
      const id = method === "post" ? uuid() : c.req.param("id")!;
      const where = tagScope(userId, workspaceId);
      for (const tagId of filters.tagIds || [])
        if (
          !getDb()
            .prepare(`SELECT 1 FROM asset_tags WHERE id=? AND ${where.sql}`)
            .get(tagId, where.value)
        )
          throw new AssetError(
            "ASSET_TAG_NOT_FOUND",
            404,
            "A filter tag no longer exists in this space.",
          );
      if (method === "post")
        getDb()
          .prepare(
            "INSERT INTO asset_smart_folders (id,userId,workspaceId,name,normalizedName,filters) VALUES (?,?,?,?,?,?)",
          )
          .run(
            id,
            userId,
            workspaceId,
            name,
            normalizedName,
            JSON.stringify(filters),
          );
      else if (
        !getDb()
          .prepare(
            "UPDATE asset_smart_folders SET name=?,normalizedName=?,filters=?,updatedAt=CURRENT_TIMESTAMP WHERE id=? AND userId=? AND workspaceId IS ?",
          )
          .run(
            name,
            normalizedName,
            JSON.stringify(filters),
            id,
            userId,
            workspaceId,
          ).changes
      )
        throw new AssetError(
          "SMART_FOLDER_NOT_FOUND",
          404,
          "Smart folder not found.",
        );
      return c.json(
        { smartFolder: { id, name, filters } },
        method === "post" ? 201 : 200,
      );
    },
  );
app.delete("/smart-folders/:id", (c) => {
  const { userId, workspaceId } = scope(c);
  if (
    !getDb()
      .prepare(
        "DELETE FROM asset_smart_folders WHERE id=? AND userId=? AND workspaceId IS ?",
      )
      .run(c.req.param("id"), userId, workspaceId).changes
  )
    throw new AssetError(
      "SMART_FOLDER_NOT_FOUND",
      404,
      "Smart folder not found.",
    );
  return c.json({ success: true });
});
export default app;

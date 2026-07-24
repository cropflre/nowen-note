import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { getUserWorkspaceRole, hasRole } from "../middleware/acl";
import {
  noteTagsRepository,
  tagOperationsRepository,
  tagsRepository,
} from "../repositories";

const app = new Hono();

function normalizeWorkspaceId(raw: string | null | undefined): string | null {
  if (!raw || raw === "personal") return null;
  return raw;
}

function normalizeTagName(raw: unknown): string {
  return String(raw ?? "").trim();
}

function isTagUniqueConstraintError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = error instanceof Error ? error.message : String(error ?? "");
  return code === "23505"
    || /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT/i.test(message);
}

async function getTagOwner(
  tagId: string,
): Promise<{ userId: string; workspaceId: string | null } | undefined> {
  return tagsRepository.getOwnerAsync(tagId);
}

function canWriteTag(
  tag: { userId: string; workspaceId: string | null },
  userId: string,
): boolean {
  if (!tag.workspaceId) return tag.userId === userId;
  return hasRole(getUserWorkspaceRole(tag.workspaceId, userId), "editor");
}

app.get("/", async (c) => {
  const userId = c.req.header("X-User-Id") || "demo";
  const workspaceId = normalizeWorkspaceId(c.req.query("workspaceId"));
  const includeEmpty = c.req.query("includeEmpty") === "true";

  if (workspaceId && !getUserWorkspaceRole(workspaceId, userId)) {
    return c.json({ error: "无权访问该工作区" }, 403);
  }

  return c.json(await tagsRepository.listByUserAsync(userId, workspaceId, includeEmpty));
});

app.post("/", async (c) => {
  const userId = c.req.header("X-User-Id") || "demo";
  const body = await c.req.json<Record<string, unknown>>();
  const name = normalizeTagName(body.name);
  if (!name) return c.json({ error: "标签名称不能为空" }, 400);
  if (name.length > 30) return c.json({ error: "标签最多 30 个字符" }, 400);

  const workspaceId = normalizeWorkspaceId(
    typeof body.workspaceId === "string" ? body.workspaceId : null,
  );
  if (workspaceId && !hasRole(getUserWorkspaceRole(workspaceId, userId), "editor")) {
    return c.json({ error: "您在该工作区无创建标签的权限" }, 403);
  }

  const existing = await tagsRepository.findByScopedNameAsync(userId, workspaceId, name);
  if (existing) return c.json(existing, 200);

  const id = uuid();
  try {
    await tagsRepository.createAsync({
      id,
      userId,
      workspaceId,
      name,
      color: typeof body.color === "string" && body.color ? body.color : "#58a6ff",
    });
  } catch (error) {
    if (isTagUniqueConstraintError(error)) {
      const raced = await tagsRepository.findByScopedNameAsync(userId, workspaceId, name);
      if (raced) return c.json(raced, 200);
    }
    throw error;
  }

  const tag = await tagsRepository.getByIdAsync(id);
  if (!tag) return c.json({ error: "标签创建后未能读取记录" }, 500);
  return c.json(tag, 201);
});

app.put("/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>();

  const patch: { name?: string; color?: string } = {};
  if (body.name !== undefined) {
    const name = normalizeTagName(body.name);
    if (!name) return c.json({ error: "标签名称不能为空" }, 400);
    if (name.length > 30) return c.json({ error: "标签最多 30 个字符" }, 400);
    patch.name = name;
  }
  if (body.color !== undefined) patch.color = String(body.color);
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const owner = await getTagOwner(id);
  if (!owner) return c.json({ error: "tag not found" }, 404);
  if (!canWriteTag(owner, userId)) return c.json({ error: "forbidden" }, 403);

  try {
    await tagsRepository.updateByIdAsync(id, patch);
  } catch (error) {
    if (isTagUniqueConstraintError(error)) {
      return c.json({ error: "当前空间已存在同名标签，请直接使用该标签" }, 409);
    }
    throw error;
  }

  return c.json(await tagsRepository.getByIdWithCountAsync(id));
});

app.delete("/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const owner = await getTagOwner(id);
  if (!owner) return c.json({ error: "tag not found" }, 404);
  if (!canWriteTag(owner, userId)) return c.json({ error: "forbidden" }, 403);

  await tagOperationsRepository.deleteTagWithLinksAsync(id);
  return c.json({ success: true });
});

app.post("/note/:noteId/tag/:tagId", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const { noteId, tagId } = c.req.param();
  const owner = await getTagOwner(tagId);
  if (!owner) return c.json({ error: "tag not found" }, 404);
  if (!canWriteTag(owner, userId)) return c.json({ error: "forbidden" }, 403);

  const note = await tagOperationsRepository.getNoteWorkspaceByIdAsync(noteId);
  if (!note) return c.json({ error: "note not found" }, 404);
  if ((note.workspaceId || null) !== (owner.workspaceId || null)) {
    return c.json({ error: "tag and note must belong to the same workspace" }, 400);
  }

  await noteTagsRepository.addTagToNoteAsync(noteId, tagId);
  return c.json({ success: true });
});

app.delete("/note/:noteId/tag/:tagId", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const { noteId, tagId } = c.req.param();
  const owner = await getTagOwner(tagId);
  if (!owner) return c.json({ error: "tag not found" }, 404);
  if (!canWriteTag(owner, userId)) return c.json({ error: "forbidden" }, 403);

  await noteTagsRepository.removeTagFromNoteAsync(noteId, tagId);
  return c.json({ success: true });
});

export default app;

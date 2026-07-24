import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import { getUserWorkspaceRole, hasRole } from "../middleware/acl";
import { tagsRepository, noteTagsRepository } from "../repositories";
import {
  ensureScopedTag,
  isTagUniqueConstraintError,
  normalizeTagName,
} from "../services/tagScope.js";

/**
 * Tags 路由 —— 支持工作区隔离
 * --------------------------------------------------------------------
 * 与 notebooks / notes 一致的工作区语义：
 *   - 查询 query `?workspaceId=`：
 *       未传 / 'personal'         → 个人空间（tags.workspaceId IS NULL，按 userId 过滤）
 *       <workspaceUuid>           → 指定工作区（tags.workspaceId = ?，需是该工作区成员）
 *   - 创建 body `{ workspaceId: string | null }`：
 *       未传 / null / 'personal'  → 落到个人空间（NULL）
 *       <workspaceUuid>           → 落到该工作区（要求 editor 以上角色）
 *   - 更新 / 删除 / 给笔记打标签：通过 tag.id 反查 owner & workspace 后再做 ACL 校验
 *
 * 标签名称唯一性：
 *   - 个人空间：同一 userId 内唯一；
 *   - 工作区：同一 workspaceId 内唯一，与创建者 userId 无关；
 *   - 创建接口是幂等的：同名标签已存在时直接返回已有记录，不向调用方暴露 409。
 */

const app = new Hono();

/** 把传入的 raw workspaceId 归一化为：null（=个人空间）| string（具体工作区） */
function normalizeWorkspaceId(raw: string | null | undefined): string | null {
  if (!raw || raw === "personal") return null;
  return raw;
}

/** 查标签 owner + workspace（用于 update/delete/attach 的 ACL 校验） */
function getTagOwner(
  tagId: string,
): { userId: string; workspaceId: string | null } | undefined {
  return tagsRepository.getOwner(tagId);
}

/**
 * 校验当前用户对某标签是否有"写"权限：
 *   - 个人空间标签：必须是 owner
 *   - 工作区标签：必须是该工作区的 editor 以上成员
 */
function canWriteTag(
  tag: { userId: string; workspaceId: string | null },
  userId: string,
): boolean {
  if (!tag.workspaceId) return tag.userId === userId;
  const role = getUserWorkspaceRole(tag.workspaceId, userId);
  return hasRole(role, "editor");
}

/**
 * GET /tags
 * 列出当前空间的标签 + 笔记数。
 * 笔记数采用空间内口径：只统计与该 tag 关联、且笔记同样落在该空间的笔记。
 *
 * TAG-PRUNE-UNUSED-ON-NOTE-DELETE-01:
 *   默认只返回 noteCount > 0 的标签（隐藏未使用的标签）。
 *   传 includeEmpty=true 可返回所有标签（用于标签管理页）。
 */
app.get("/", (c) => {
  const userId = c.req.header("X-User-Id") || "demo";
  const ws = normalizeWorkspaceId(c.req.query("workspaceId"));
  const includeEmpty = c.req.query("includeEmpty") === "true";

  // 工作区视角：成员校验
  if (ws) {
    const role = getUserWorkspaceRole(ws, userId);
    if (!role) return c.json({ error: "无权访问该工作区" }, 403);
  }

  const rows = tagsRepository.listByUser(userId, ws, includeEmpty);
  return c.json(rows);
});

/**
 * POST /tags
 * body: { name, color?, workspaceId? }
 *   workspaceId 为 'personal'/缺省 → 个人空间；为 uuid → 工作区（要求 editor+）
 *
 * 同一作用域重复创建时返回已有标签（200）；首次创建返回 201。
 */
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const body = await c.req.json();

  const name = normalizeTagName(body.name);
  if (!name) {
    return c.json({ error: "标签名称不能为空" }, 400);
  }
  if (name.length > 30) {
    return c.json({ error: "标签最多 30 个字符" }, 400);
  }

  const ws = normalizeWorkspaceId(body.workspaceId);
  if (ws) {
    const role = getUserWorkspaceRole(ws, userId);
    if (!hasRole(role, "editor")) {
      return c.json({ error: "您在该工作区无创建标签的权限" }, 403);
    }
  }

  const result = ensureScopedTag(db, {
    id: uuid(),
    userId,
    workspaceId: ws,
    name,
    color: body.color || "#58a6ff",
  });

  return c.json(result.tag, result.created ? 201 : 200);
});

// 更新标签（名称/颜色）
app.put("/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();

  if (body.name !== undefined) {
    const name = normalizeTagName(body.name);
    if (!name) {
      return c.json({ error: "标签名称不能为空" }, 400);
    }
    if (name.length > 30) {
      return c.json({ error: "标签最多 30 个字符" }, 400);
    }
    body.name = name;
  }

  const owner = getTagOwner(id);
  if (!owner) return c.json({ error: "tag not found" }, 404);
  if (!canWriteTag(owner, userId)) return c.json({ error: "forbidden" }, 403);

  const patch: { name?: string; color?: string } = {};
  if (body.name !== undefined) {
    patch.name = body.name;
  }
  if (body.color !== undefined) {
    patch.color = body.color;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "No fields to update" }, 400);

  try {
    tagsRepository.updateById(id, patch);
  } catch (error) {
    if (isTagUniqueConstraintError(error)) {
      return c.json({ error: "当前空间已存在同名标签，请直接使用该标签" }, 409);
    }
    throw error;
  }

  const tag = tagsRepository.getByIdWithCount(id);
  return c.json(tag);
});

app.delete("/:id", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const owner = getTagOwner(id);
  if (!owner) return c.json({ error: "tag not found" }, 404);
  if (!canWriteTag(owner, userId)) return c.json({ error: "forbidden" }, 403);

  tagsRepository.deleteTagLinks(id);
  tagsRepository.deleteById(id);
  return c.json({ success: true });
});

// 给笔记添加标签
// 校验：标签必须与笔记处于同一空间，且当前用户对标签有写权限
app.post("/note/:noteId/tag/:tagId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const { noteId, tagId } = c.req.param();

  const owner = getTagOwner(tagId);
  if (!owner) return c.json({ error: "tag not found" }, 404);
  if (!canWriteTag(owner, userId)) return c.json({ error: "forbidden" }, 403);

  // 笔记的 workspaceId 必须与标签一致，避免跨空间挂标签
  const note = db
    .prepare("SELECT workspaceId FROM notes WHERE id = ?")
    .get(noteId) as { workspaceId: string | null } | undefined;
  if (!note) return c.json({ error: "note not found" }, 404);
  if ((note.workspaceId || null) !== (owner.workspaceId || null)) {
    return c.json({ error: "tag and note must belong to the same workspace" }, 400);
  }

  noteTagsRepository.addTagToNote(noteId, tagId);
  return c.json({ success: true });
});

// 移除笔记标签
app.delete("/note/:noteId/tag/:tagId", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const { noteId, tagId } = c.req.param();

  const owner = getTagOwner(tagId);
  if (!owner) return c.json({ error: "tag not found" }, 404);
  if (!canWriteTag(owner, userId)) return c.json({ error: "forbidden" }, 403);

  noteTagsRepository.removeTagFromNote(noteId, tagId);
  return c.json({ success: true });
});

export default app;

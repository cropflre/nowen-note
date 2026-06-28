import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import { getUserWorkspaceRole, hasRole } from "../middleware/acl";
import { tagsRepository } from "../repositories";

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
 * 注意：
 *   - 标签的 UNIQUE(userId, name) 约束未变，仍然是"同用户名全局唯一"；
 *     workspaceId 只是限定可见范围，不参与唯一性。这是为了避免重建表
 *     （详见 schema.ts 中的注释），同时保持标签作为用户分类体系的语义简单。
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
 */
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const body = await c.req.json();

  // 标签名称校验
  const name = (body.name || "").trim();
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

  const id = uuid();
  try {
    db.prepare(
      `INSERT INTO tags (id, userId, workspaceId, name, color) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, userId, ws, name, body.color || "#58a6ff");
  } catch (err: any) {
    // UNIQUE(userId, name) 冲突 → 当前账号已有同名标签（可能在其他空间）
    if (String(err?.message || err).includes("UNIQUE")) {
      return c.json(
        {
          error:
            "您已经有一个同名标签（标签名在账号内全局唯一），请换一个名字",
        },
        409,
      );
    }
    throw err;
  }
  const tag = tagsRepository.getById(id);
  return c.json(tag, 201);
});

// 更新标签（名称/颜色）
app.put("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();

  // 标签名称校验
  if (body.name !== undefined) {
    const name = (body.name || "").trim();
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

  const fields: string[] = [];
  const values: any[] = [];
  if (body.name !== undefined) {
    fields.push("name = ?");
    values.push(body.name);
  }
  if (body.color !== undefined) {
    fields.push("color = ?");
    values.push(body.color);
  }
  if (fields.length === 0) return c.json({ error: "No fields to update" }, 400);
  values.push(id);
  db.prepare(`UPDATE tags SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const tag = tagsRepository.getByIdWithCount(id);
  return c.json(tag);
});

app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const owner = getTagOwner(id);
  if (!owner) return c.json({ error: "tag not found" }, 404);
  if (!canWriteTag(owner, userId)) return c.json({ error: "forbidden" }, 403);

  db.prepare("DELETE FROM note_tags WHERE tagId = ?").run(id);
  db.prepare("DELETE FROM tags WHERE id = ?").run(id);
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

  db.prepare(`INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)`).run(
    noteId,
    tagId,
  );
  return c.json({ success: true });
});

// 移除笔记标签
app.delete("/note/:noteId/tag/:tagId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const { noteId, tagId } = c.req.param();

  const owner = getTagOwner(tagId);
  if (!owner) return c.json({ error: "tag not found" }, 404);
  if (!canWriteTag(owner, userId)) return c.json({ error: "forbidden" }, 403);

  db.prepare("DELETE FROM note_tags WHERE noteId = ? AND tagId = ?").run(
    noteId,
    tagId,
  );
  return c.json({ success: true });
});

export default app;

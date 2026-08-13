import { Hono } from "hono";
import { v4 as uuid } from "uuid";

import type { DatabaseAdapter } from "../db/adapters/types";
import { createNoteTagsRepository } from "../repositories/noteTagsRepository";
import { createTagsRepository } from "../repositories/tagsRepository";

type WorkspaceRole = "owner" | "admin" | "editor" | "commenter" | "viewer";

const ROLE_LEVEL: Record<WorkspaceRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  admin: 4,
  owner: 5,
};

function normalizeWorkspaceId(raw: string | undefined | null): string | null {
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

function hasRole(role: string | null | undefined, minimum: WorkspaceRole): boolean {
  if (!role || !(role in ROLE_LEVEL)) return false;
  return ROLE_LEVEL[role as WorkspaceRole] >= ROLE_LEVEL[minimum];
}

export function createTagsRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();
  const tagsRepository = createTagsRepository(adapter);
  const noteTagsRepository = createNoteTagsRepository(
    adapter,
    "INSERT",
    'ON CONFLICT ("noteId", "tagId") DO NOTHING',
  );

  async function workspaceRole(workspaceId: string, userId: string): Promise<string | null> {
    const row = await adapter.queryOne<{ role: string }>(
      `SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
      [workspaceId, userId],
    );
    return row?.role ?? null;
  }

  async function canWriteTag(
    tag: { userId: string; workspaceId: string | null },
    userId: string,
  ): Promise<boolean> {
    if (!tag.workspaceId) return tag.userId === userId;
    return hasRole(await workspaceRole(tag.workspaceId, userId), "editor");
  }

  async function readJsonBody(c: Parameters<Parameters<typeof app.post>[1]>[0]): Promise<Record<string, unknown>> {
    return c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  }

  app.get("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const workspaceId = normalizeWorkspaceId(c.req.query("workspaceId"));
    const includeEmpty = c.req.query("includeEmpty") === "true";

    if (workspaceId && !(await workspaceRole(workspaceId, userId))) {
      return c.json({ error: "无权访问该工作区" }, 403);
    }

    const rows = await tagsRepository.listByUserAsync(userId, workspaceId, includeEmpty);
    return c.json(rows.map((row) => ({ ...row, noteCount: Number(row.noteCount ?? 0) })));
  });

  app.post("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const body = await readJsonBody(c);
    const name = normalizeTagName(body.name);
    if (!name) return c.json({ error: "标签名称不能为空" }, 400);
    if (name.length > 30) return c.json({ error: "标签最多 30 个字符" }, 400);

    const workspaceId = normalizeWorkspaceId(
      typeof body.workspaceId === "string" ? body.workspaceId : null,
    );
    if (workspaceId && !hasRole(await workspaceRole(workspaceId, userId), "editor")) {
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
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const id = c.req.param("id");
    const body = await readJsonBody(c);
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

    const owner = await tagsRepository.getOwnerAsync(id);
    if (!owner) return c.json({ error: "tag not found" }, 404);
    if (!(await canWriteTag(owner, userId))) return c.json({ error: "forbidden" }, 403);

    if (patch.name !== undefined) {
      const sameScope = await tagsRepository.findByScopedNameAsync(
        owner.userId,
        owner.workspaceId,
        patch.name,
      );
      if (sameScope && sameScope.id !== id) {
        return c.json({ error: "当前空间已存在同名标签，请直接使用该标签" }, 409);
      }
    }

    try {
      await tagsRepository.updateByIdAsync(id, patch);
    } catch (error) {
      if (isTagUniqueConstraintError(error)) {
        return c.json({ error: "当前空间已存在同名标签，请直接使用该标签" }, 409);
      }
      throw error;
    }

    const updated = await tagsRepository.getByIdWithCountAsync(id);
    return c.json(updated ? { ...updated, noteCount: Number(updated.noteCount ?? 0) } : null);
  });

  app.delete("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const id = c.req.param("id");
    const owner = await tagsRepository.getOwnerAsync(id);
    if (!owner) return c.json({ error: "tag not found" }, 404);
    if (!(await canWriteTag(owner, userId))) return c.json({ error: "forbidden" }, 403);

    await adapter.executeStatements([
      { sql: 'DELETE FROM note_tags WHERE "tagId" = ?', params: [id] },
      { sql: "DELETE FROM tags WHERE id = ?", params: [id], requireChanges: 1 },
    ]);
    return c.json({ success: true });
  });

  app.post("/note/:noteId/tag/:tagId", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const { noteId, tagId } = c.req.param();
    const owner = await tagsRepository.getOwnerAsync(tagId);
    if (!owner) return c.json({ error: "tag not found" }, 404);
    if (!(await canWriteTag(owner, userId))) return c.json({ error: "forbidden" }, 403);

    const note = await adapter.queryOne<{ workspaceId: string | null }>(
      'SELECT "workspaceId" AS "workspaceId" FROM notes WHERE id = ? AND "isTrashed" = false',
      [noteId],
    );
    if (!note) return c.json({ error: "note not found" }, 404);
    if ((note.workspaceId || null) !== (owner.workspaceId || null)) {
      return c.json({ error: "tag and note must belong to the same workspace" }, 400);
    }

    await noteTagsRepository.addTagToNoteAsync(noteId, tagId);
    return c.json({ success: true });
  });

  app.delete("/note/:noteId/tag/:tagId", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const { noteId, tagId } = c.req.param();
    const owner = await tagsRepository.getOwnerAsync(tagId);
    if (!owner) return c.json({ error: "tag not found" }, 404);
    if (!(await canWriteTag(owner, userId))) return c.json({ error: "forbidden" }, 403);

    const note = await adapter.queryOne<{ workspaceId: string | null }>(
      'SELECT "workspaceId" AS "workspaceId" FROM notes WHERE id = ?',
      [noteId],
    );
    if (!note) return c.json({ error: "note not found" }, 404);
    if ((note.workspaceId || null) !== (owner.workspaceId || null)) {
      return c.json({ error: "tag and note must belong to the same workspace" }, 400);
    }

    await noteTagsRepository.removeTagFromNoteAsync(noteId, tagId);
    return c.json({ success: true });
  });

  return app;
}

export default createTagsRuntimeRouter;

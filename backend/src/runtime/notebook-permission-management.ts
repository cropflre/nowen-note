import notebooksRouter from "../routes/notebooks.js";
import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotebookPermission } from "../middleware/acl.js";
import { notebookMembersRepository } from "../repositories/index.js";
import {
  NotebookOwnershipTransferError,
  transferNotebookOwnership,
} from "../services/notebookOwnershipTransfer.js";

const INSTALL_KEY = Symbol.for("nowen.notebookPermissionManagement.installed");
const runtime = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean };

function memberId(notebookId: string, userId: string): string {
  return `${notebookId}:${userId}`;
}

if (!runtime[INSTALL_KEY]) {
  runtime[INSTALL_KEY] = true;

  notebooksRouter.get("/:id/permission-summary", (c) => {
    const userId = c.req.header("X-User-Id") || "";
    const notebookId = c.req.param("id");
    const { permission } = resolveNotebookPermission(notebookId, userId);
    if (!hasPermission(permission, "manage")) {
      return c.json({ error: "无权管理该目录", code: "FORBIDDEN" }, 403);
    }

    const notebook = getDb().prepare(`
      SELECT nb.id, nb.userId, nb.workspaceId, nb.createdAt, nb.updatedAt,
             u.username, u.email, u.displayName, u.avatarUrl
        FROM notebooks nb
        JOIN users u ON u.id = nb.userId
       WHERE nb.id = ? AND nb.isDeleted = 0
    `).get(notebookId) as {
      id: string;
      userId: string;
      workspaceId: string | null;
      createdAt: string;
      updatedAt: string;
      username: string;
      email: string | null;
      displayName: string | null;
      avatarUrl: string | null;
    } | undefined;

    if (!notebook) return c.json({ error: "目录不存在", code: "NOTEBOOK_NOT_FOUND" }, 404);

    const directMembers = notebookMembersRepository
      .listByNotebook(notebookId)
      .filter((member) => member.userId !== notebook.userId);
    const owner = {
      id: memberId(notebookId, notebook.userId),
      notebookId,
      userId: notebook.userId,
      role: "owner" as const,
      status: "active" as const,
      allowDownload: 1,
      allowReshare: 1,
      source: "manual" as const,
      sourceId: null,
      invitedBy: null,
      createdAt: notebook.createdAt,
      updatedAt: notebook.updatedAt,
      username: notebook.username,
      email: notebook.email,
      displayName: notebook.displayName,
      avatarUrl: notebook.avatarUrl,
    };

    return c.json({
      notebookId,
      workspaceId: notebook.workspaceId,
      ownerId: notebook.userId,
      members: [owner, ...directMembers],
    });
  });

  notebooksRouter.post("/:id/transfer-owner", async (c) => {
    const actorUserId = c.req.header("X-User-Id") || "";
    const notebookId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));

    try {
      return c.json(transferNotebookOwnership({
        notebookId,
        actorUserId,
        targetUserId: String(body.targetUserId || ""),
      }));
    } catch (error) {
      if (error instanceof NotebookOwnershipTransferError) {
        return c.json({ error: error.message, code: error.code }, error.status as any);
      }
      console.error("[notebook-permission-management] transfer failed:", error);
      return c.json({ error: "转交所有者失败", code: "TRANSFER_OWNER_FAILED" }, 500);
    }
  });
}

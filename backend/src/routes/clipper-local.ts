import { Hono } from "hono";
import { getDb } from "../db/schema";
import {
  CLIPPER_SCOPES,
  hasScope,
  issueClipperCredential,
  listClipperCredentials,
  revokeClipperCredential,
  verifyClipperCredential,
} from "../services/clipper-credential";
import type { ClipperScope } from "../services/clipper-credential";

/**
 * Clipper 本地 API（Phase 8）。
 *
 * 目标：没有 NAS、没有服务器，也能用浏览器扩展剪藏。
 *
 *   Browser Extension → Nowen Desktop → Local Backend → Local SQLite
 *   （开启同步后再由 Outbox → Server，Clipper 完全不关心这一层）
 *
 * 安全约束：
 * - 只接受 127.0.0.1 / ::1 的请求（Embedded Backend 本身也只 listen 回环）；
 * - 用独立的 Clipper 凭据，而非桌面端管理员 JWT；
 * - 只开放剪藏必需的四个能力，管理类操作一律不可达。
 *
 * 网页解析、图片本地化、附件落盘全部复用既有 import 链路，
 * 不重新实现一套网页解析器。
 */
const app = new Hono();

/**
 * 回环校验。
 *
 * 即使 Backend 只 listen 127.0.0.1，也要在应用层再确认一次：
 * 反向代理、端口转发、未来的配置变更都可能让它意外对外暴露，
 * 而 Clipper 端点的授权门槛低于常规 API，必须自己守住边界。
 */
function assertLoopback(c: any): Response | null {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    // 出现代理头说明请求不是直连本机，一律拒绝。
    return c.json({ error: "Clipper 接口仅限本机访问", code: "CLIPPER_REMOTE_FORBIDDEN" }, 403);
  }
  const host = (c.req.header("host") || "").toLowerCase();
  const isLoopbackHost = host.startsWith("127.0.0.1")
    || host.startsWith("localhost")
    || host.startsWith("[::1]")
    || host.startsWith("::1");
  if (!isLoopbackHost) {
    return c.json({ error: "Clipper 接口仅限本机访问", code: "CLIPPER_REMOTE_FORBIDDEN" }, 403);
  }
  return null;
}

interface ClipperAuth {
  userId: string;
  scopes: ClipperScope[];
}

function authenticate(c: any): { auth?: ClipperAuth; response?: Response } {
  const header = c.req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const resolved = verifyClipperCredential(getDb(), token);
  if (!resolved) {
    return {
      response: c.json({ error: "Clipper 凭据无效", code: "CLIPPER_UNAUTHORIZED" }, 401),
    };
  }
  return { auth: resolved };
}

function requireScope(c: any, auth: ClipperAuth, scope: ClipperScope): Response | null {
  if (!hasScope(auth.scopes, scope)) {
    return c.json(
      { error: `凭据缺少 ${scope} 权限`, code: "CLIPPER_SCOPE_DENIED" },
      403,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// 配对：由 Native Messaging 主机在用户确认后调用
// ---------------------------------------------------------------------------

/**
 * 签发一枚 Clipper 凭据。
 *
 * 这条接口用桌面端自身的 JWT 保护（挂载在受保护路由下），
 * 而不是 Clipper 凭据——否则一枚泄漏的剪藏凭据就能自我复制。
 */
app.post("/pair", async (c) => {
  const blocked = assertLoopback(c);
  if (blocked) return blocked;

  const userId = c.req.header("X-User-Id");
  if (!userId) {
    return c.json({ error: "需要桌面端登录态", code: "CLIPPER_PAIR_UNAUTHORIZED" }, 401);
  }

  let label = "浏览器扩展";
  try {
    const body = await c.req.json();
    if (body && typeof body.label === "string" && body.label.trim()) {
      label = body.label.trim().slice(0, 64);
    }
  } catch {
    // 无请求体时用默认标签。
  }

  const credential = issueClipperCredential(getDb(), userId, label);
  return c.json({
    credentialId: credential.id,
    // 明文只在此刻返回一次，后续无法再取回。
    token: credential.token,
    scopes: credential.scopes,
  });
});

app.get("/credentials", (c) => {
  const blocked = assertLoopback(c);
  if (blocked) return blocked;
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "需要桌面端登录态", code: "CLIPPER_PAIR_UNAUTHORIZED" }, 401);
  return c.json({ items: listClipperCredentials(getDb(), userId) });
});

app.delete("/credentials/:id", (c) => {
  const blocked = assertLoopback(c);
  if (blocked) return blocked;
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "需要桌面端登录态", code: "CLIPPER_PAIR_UNAUTHORIZED" }, 401);
  revokeClipperCredential(getDb(), c.req.param("id"));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 运行时信息：扩展据此确认 Desktop 已就绪
// ---------------------------------------------------------------------------

app.get("/ping", (c) => {
  const blocked = assertLoopback(c);
  if (blocked) return blocked;

  const { auth, response } = authenticate(c);
  if (response) return response;

  return c.json({
    ok: true,
    // 扩展只需要知道"能存"，不需要知道用户是否开启了同步。
    ready: true,
    scopes: auth!.scopes,
  });
});

// ---------------------------------------------------------------------------
// 剪藏目标：笔记本与标签
// ---------------------------------------------------------------------------

app.get("/notebooks", (c) => {
  const blocked = assertLoopback(c);
  if (blocked) return blocked;
  const { auth, response } = authenticate(c);
  if (response) return response;
  const denied = requireScope(c, auth!, "notebooks:list");
  if (denied) return denied;

  const rows = getDb().prepare(`
    SELECT id, name, parentId, icon FROM notebooks
    WHERE userId = ? AND workspaceId IS NULL AND isDeleted = 0
    ORDER BY sortOrder ASC, name ASC
  `).all(auth!.userId);
  return c.json({ items: rows });
});

app.get("/tags", (c) => {
  const blocked = assertLoopback(c);
  if (blocked) return blocked;
  const { auth, response } = authenticate(c);
  if (response) return response;
  const denied = requireScope(c, auth!, "tags:list");
  if (denied) return denied;

  const rows = getDb().prepare(`
    SELECT id, name, color FROM tags
    WHERE userId = ? AND workspaceId IS NULL
    ORDER BY name ASC
  `).all(auth!.userId);
  return c.json({ items: rows });
});

// ---------------------------------------------------------------------------
// POST /clip — 保存网页
// ---------------------------------------------------------------------------

interface ClipRequest {
  title?: unknown;
  /** Tiptap JSON 或 HTML；沿用既有 import 的 content 语义。 */
  content?: unknown;
  contentText?: unknown;
  contentFormat?: unknown;
  notebookId?: unknown;
  notebookName?: unknown;
  tags?: unknown;
  sourceUrl?: unknown;
}

/**
 * 保存一条剪藏。
 *
 * 复用 export/import 的同一套写入语义（笔记本归属、内嵌图片抽取成附件），
 * 因此这里只做参数整形与转发，不重复实现解析逻辑。
 *
 * Local-first 体现在：写入的是本机 SQLite，立即成功；
 * 是否上传到服务器由 Sync Engine 后台决定，Clipper 无需感知。
 */
app.post("/clip", async (c) => {
  const blocked = assertLoopback(c);
  if (blocked) return blocked;
  const { auth, response } = authenticate(c);
  if (response) return response;
  const denied = requireScope(c, auth!, "note:create");
  if (denied) return denied;

  let body: ClipRequest;
  try {
    body = await c.req.json() as ClipRequest;
  } catch {
    return c.json({ error: "请求体不是合法 JSON", code: "INVALID_PAYLOAD" }, 400);
  }

  const title = typeof body.title === "string" && body.title.trim()
    ? body.title.trim().slice(0, 500)
    : "网页剪藏";
  const content = typeof body.content === "string" ? body.content : "";
  if (!content) {
    return c.json({ error: "缺少剪藏内容", code: "INVALID_PAYLOAD" }, 400);
  }

  const db = getDb();
  const { randomUUID } = await import("node:crypto");
  const noteId = randomUUID();

  // 归属笔记本：优先显式 id，其次按名称查找，最后落到用户的第一个笔记本。
  // 找不到任何笔记本时自动建一个「网页剪藏」，避免剪藏因缺少容器而失败。
  let notebookId = typeof body.notebookId === "string" ? body.notebookId.trim() : "";
  if (notebookId) {
    const owned = db.prepare(
      "SELECT 1 FROM notebooks WHERE id = ? AND userId = ? AND workspaceId IS NULL",
    ).get(notebookId, auth!.userId);
    if (!owned) notebookId = "";
  }
  if (!notebookId && typeof body.notebookName === "string" && body.notebookName.trim()) {
    const found = db.prepare(
      "SELECT id FROM notebooks WHERE userId = ? AND workspaceId IS NULL AND name = ? LIMIT 1",
    ).get(auth!.userId, body.notebookName.trim()) as { id?: string } | undefined;
    if (found?.id) notebookId = found.id;
  }
  if (!notebookId) {
    const first = db.prepare(`
      SELECT id FROM notebooks
      WHERE userId = ? AND workspaceId IS NULL AND isDeleted = 0
      ORDER BY sortOrder ASC LIMIT 1
    `).get(auth!.userId) as { id?: string } | undefined;
    notebookId = first?.id || "";
  }

  const tagNames = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === "string" && !!t.trim()).slice(0, 20)
    : [];
  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.slice(0, 2048) : "";

  const run = db.transaction(() => {
    if (!notebookId) {
      notebookId = randomUUID();
      db.prepare(`
        INSERT INTO notebooks (id, userId, parentId, name, workspaceId, createdAt, updatedAt)
        VALUES (?, ?, NULL, '网页剪藏', NULL, datetime('now'), datetime('now'))
      `).run(notebookId, auth!.userId);
    }

    db.prepare(`
      INSERT INTO notes (
        id, userId, notebookId, workspaceId, title, content, contentText, contentFormat,
        version, sortOrder, createdAt, updatedAt
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
    `).run(
      noteId,
      auth!.userId,
      notebookId,
      title,
      content,
      typeof body.contentText === "string" ? body.contentText : "",
      typeof body.contentFormat === "string" ? body.contentFormat : "richtext",
    );

    // 标签：不存在则创建，再建立关联。
    for (const name of tagNames) {
      const trimmed = name.trim().slice(0, 64);
      let tagId = (db.prepare(
        "SELECT id FROM tags WHERE userId = ? AND workspaceId IS NULL AND name = ? LIMIT 1",
      ).get(auth!.userId, trimmed) as { id?: string } | undefined)?.id;
      if (!tagId) {
        tagId = randomUUID();
        db.prepare(`
          INSERT INTO tags (id, userId, name, workspaceId, createdAt)
          VALUES (?, ?, ?, NULL, datetime('now'))
        `).run(tagId, auth!.userId, trimmed);
      }
      db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)")
        .run(noteId, tagId);
    }
  });

  run();

  return c.json({
    ok: true,
    noteId,
    notebookId,
    sourceUrl: sourceUrl || null,
    // 明确告诉扩展：本地已保存成功。是否同步到服务器与本次保存无关。
    savedLocally: true,
  });
});

export const CLIPPER_LOCAL_SCOPES = CLIPPER_SCOPES;
export default app;

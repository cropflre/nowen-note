/**
 * 云端笔记导入（Yuque 网页端 cookie 模式）。
 *
 * 原理：与 GitHub 上成熟的 Yuque 导出工具一致——使用浏览器登录 Yuque 网页版后
 * 从 F12 获取的 cookie + X-Csrf-Token，调用网页端内部接口拉取知识库/文档。
 * 该方式**不需要会员**（官方开放 API 的 Personal Access Token 需超级会员）。
 *
 * 端点（均为 www.yuque.com）：
 *   GET  /api/mine/common_used                       → 知识库列表
 *   GET  /{user}/{bookSlug}                          → 页面内嵌目录（appData）
 *   GET  /{user}/{bookSlug}/{url}/markdown?attachment=true&latexcode=true → 文档 Markdown
 *
 * 安全：cookie 只用于向 Yuque 发起的请求，不写入日志；请求带超时与大小限制。
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { sanitizeForImport } from "../lib/sanitizeHtml";
import { yuqueMarkdownToHtml } from "../lib/yuqueMarkdownToHtml";
import { parseYuquePageToc, type YuqueTocDoc } from "../lib/yuquePageToc";
import { rewriteImages } from "./url-import";

const app = new Hono();

const YUQUE_WEB_BASE = "https://www.yuque.com";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_DOCS_PER_IMPORT = 500;

interface YuqueCommonUsedBook {
  id: number;
  slug: string;
  name: string;
  user?: { login?: string } | string;
  type?: string;
  // Yuque common_used 实际响应是嵌套的：book.target.{id,name,slug,user}。
  // 兼容两种形态（平铺/嵌套），下面用 b.target ?? b 取值。
  target?: Partial<{
    id: number;
    slug: string;
    name: string;
    title: string;
    user: { login?: string } | string;
  }>;
}

/** 组装网页端请求头（cookie + X-Csrf-Token）。 */
function webHeaders(cookie: string, csrf: string, referer = YUQUE_WEB_BASE): Record<string, string> {
  return {
    Accept: "application/json, text/html, */*",
    "X-Csrf-Token": csrf,
    "X-Requested-With": "XMLHttpRequest",
    Cookie: cookie,
    Referer: referer,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  };
}

async function safeFetch(
  url: string,
  headers: Record<string, string>,
  isText: boolean,
): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
  // Yuque网页端首次建连偶发抖动（TLS 握手超时 / 401 瞬时失效），表现为
  // "第一次请求失败、重试一次就成功"。这里在代理层内部自动重试，吸收这类瞬态故障，
  // 不再把问题抛给用户手动重试。只对瞬态错误重试，确定性错误（4xx/非法 JSON）直接返回。
  const MAX_ATTEMPTS = 3;
  const RETRYABLE = new Set([0, 429, 500, 502, 503, 504]); // 0 = 网络/超时
  let last: { ok: boolean; status: number; body: string; error?: string } | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, body: "", error: "Cookie 无效或已过期" };
      }
      if (!res.ok) {
        if (attempt < MAX_ATTEMPTS && RETRYABLE.has(res.status)) {
          last = { ok: false, status: res.status, body: "", error: `服务返回 HTTP ${res.status}` };
          await new Promise((r) => setTimeout(r, 600 * attempt));
          continue;
        }
        return { ok: false, status: res.status, body: "", error: `服务返回 HTTP ${res.status}` };
      }
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        return { ok: false, status: 413, body: "", error: "响应体过大" };
      }
      if (!isText) {
        // JSON 请求：校验可解析
        try {
          JSON.parse(text);
        } catch {
          return { ok: false, status: 502, body: "", error: "响应不是合法 JSON" };
        }
      }
      return { ok: true, status: 200, body: text };
    } catch (err: any) {
      const aborted = err?.name === "AbortError";
      const status = 0;
      const error = aborted ? "请求超时" : (err?.message || "网络请求失败");
      if (attempt < MAX_ATTEMPTS && RETRYABLE.has(status)) {
        last = { ok: false, status, body: "", error };
        await new Promise((r) => setTimeout(r, 600 * attempt));
        continue;
      }
      return { ok: false, status, body: "", error };
    } finally {
      clearTimeout(timer);
    }
  }
  return last ?? { ok: false, status: 0, body: "", error: "请求失败（重试耗尽）" };
}

async function requireCreds(c: any): Promise<{ cookie: string; csrf: string } | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  const { cookie, csrf } = (body ?? {}) as { cookie?: string; csrf?: string };
  if (!cookie || typeof cookie !== "string" || !csrf || typeof csrf !== "string") {
    return null;
  }
  return { cookie: cookie.trim(), csrf: csrf.trim() };
}

/** 验证 Cookie，返回用户 login（若知识库列表里能取到）。 */
app.post("/verify", async (c) => {
  const creds = await requireCreds(c);
  if (!creds) return c.json({ valid: false, error: "请填写 Cookie 与 X-Csrf-Token" }, 400);
  const res = await safeFetch(
    `${YUQUE_WEB_BASE}/api/mine/common_used`,
    webHeaders(creds.cookie, creds.csrf),
    false,
  );
  if (!res.ok) return c.json({ valid: false, error: res.error || "验证失败" }, 200);
  try {
    const data = JSON.parse(res.body) as { data?: { books?: YuqueCommonUsedBook[] } };
    const books = data?.data?.books || [];
    // Yuque common_used 实际返回 book.target.{id,name,slug,user}（嵌套一层 target）
    const firstWithLogin = books.find((b) => {
      const t = b.target ?? b;
      const u = t.user;
      return typeof u === "string" ? !!u : !!u?.login;
    });
    const t0 = firstWithLogin ? (firstWithLogin.target ?? firstWithLogin) : null;
    const u0 = t0 ? t0.user : null;
    const login = typeof u0 === "string" ? u0 : (u0?.login ?? "");
    return c.json({ valid: true, login });
  } catch {
    return c.json({ valid: false, error: "验证失败" }, 200);
  }
});

/** 拉取知识库列表。 */
app.post("/repos", async (c) => {
  const creds = await requireCreds(c);
  if (!creds) return c.json({ error: "请填写 Cookie 与 X-Csrf-Token" }, 400);
  const res = await safeFetch(
    `${YUQUE_WEB_BASE}/api/mine/common_used`,
    webHeaders(creds.cookie, creds.csrf),
    false,
  );
  if (!res.ok) return c.json({ error: res.error || "获取知识库失败" }, 200);
  try {
    const data = JSON.parse(res.body) as { data?: { books?: YuqueCommonUsedBook[] } };
    const repos = (data?.data?.books || []).map((b) => {
      // Yuque common_used 实际返回 book.target.{id,name,slug,user}（嵌套一层 target）
      const t = (b.target ?? b) as {
        id?: number;
        slug?: string;
        name?: string;
        title?: string;
        user?: { login?: string } | string;
      };
      const userLogin = typeof t.user === "string" ? t.user : t.user?.login ?? "";
      const name = t.name ?? t.title ?? t.slug ?? "(无名称)";
      return {
        id: t.id ?? b.id ?? 0,
        slug: t.slug ?? b.slug ?? "",
        name,
        user: userLogin,
        type: b.type ?? "",
      };
    });
    return c.json({ repos });
  } catch {
    return c.json({ error: "获取知识库失败" }, 200);
  }
});

/** 拉取知识库下的文档列表（解析页面内嵌目录）。 */
app.post("/docs", async (c) => {
  const creds = await requireCreds(c);
  if (!creds) return c.json({ error: "请填写 Cookie 与 X-Csrf-Token" }, 400);
  const { user, bookSlug } = (await c.req.json()) as { user?: string; bookSlug?: string };
  if (!user || !bookSlug) return c.json({ error: "缺少知识库标识" }, 400);

  const res = await safeFetch(
    `${YUQUE_WEB_BASE}/${encodeURIComponent(user)}/${encodeURIComponent(bookSlug)}`,
    webHeaders(creds.cookie, creds.csrf, `${YUQUE_WEB_BASE}/dashboard`),
    true,
  );
  if (!res.ok) return c.json({ error: res.error || "获取文档列表失败" }, 200);

  const docs = parseYuquePageToc(res.body).map((d: YuqueTocDoc) => ({
    id: d.id,
    url: d.url,
    title: d.title,
    parentUuid: d.parentUuid,
  }));
  return c.json({ docs });
});

/** 批量导入：逐个拉取 Markdown → 转 HTML → 图片本地化 → 写入笔记。 */
app.post("/import", async (c) => {
  const creds = await requireCreds(c);
  if (!creds) return c.json({ error: "请填写 Cookie 与 X-Csrf-Token" }, 400);
  const { user, bookSlug, docs, notebookId } = (await c.req.json()) as {
    user?: string;
    bookSlug?: string;
    docs?: Array<{ url: string; title: string }>;
    notebookId?: string;
  };
  if (!user || !bookSlug) return c.json({ error: "缺少知识库标识" }, 400);
  if (!docs || !Array.isArray(docs) || docs.length === 0) {
    return c.json({ error: "请选择要导入的文档" }, 400);
  }

  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "未登录" }, 401);
  const requestedWorkspaceId = c.req.query("workspaceId") || null;
  const db = getDb();

  // 目标笔记本：未指定 → 自动创建「Yuque 导入」
  let targetNotebookId = notebookId;
  if (!targetNotebookId) {
    const exist = db
      .prepare("SELECT id FROM notebooks WHERE userId = ? AND name = ?")
      .get(userId, "Yuque 导入") as { id: string } | undefined;
    if (exist) {
      targetNotebookId = exist.id;
    } else {
      targetNotebookId = uuid();
      if (requestedWorkspaceId) {
        db.prepare("INSERT INTO notebooks (id, userId, name, icon, workspaceId) VALUES (?, ?, ?, ?, ?)")
          .run(targetNotebookId, userId, "Yuque 导入", "📥", requestedWorkspaceId);
      } else {
        db.prepare("INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, ?, ?)")
          .run(targetNotebookId, userId, "Yuque 导入", "📥");
      }
    }
  }

  // 知识树触发器（knowledge_tree_notes_ai）要求笔记与目标笔记本处于同一 scope：
  // 笔记的 workspaceId 必须与笔记本的 workspaceId 一致，否则 ABORT
  // KNOWLEDGE_TREE_PARENT_SCOPE_MISMATCH。因此以目标笔记本自身的 workspaceId 为准，
  // 而不是用请求里的 workspaceId。
  const notebookRow = db
    .prepare("SELECT workspaceId FROM notebooks WHERE id = ? AND userId = ?")
    .get(targetNotebookId, userId) as { workspaceId: string | null } | undefined;
  const workspaceId = notebookRow ? notebookRow.workspaceId : null;

  const now = () => new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const inserted: string[] = [];
  const errors: string[] = [];
  let downloadedImages = 0;
  let failedImages = 0;

  for (const doc of docs.slice(0, MAX_DOCS_PER_IMPORT)) {
    const title = (doc.title || doc.url || "未命名文档").slice(0, 500);
    try {
      const mdUrl =
        `${YUQUE_WEB_BASE}/${encodeURIComponent(user)}/${encodeURIComponent(bookSlug)}/` +
        `${encodeURIComponent(doc.url)}/markdown?attachment=true&latexcode=true&anchor=false&linebreak=false`;
      const res = await safeFetch(mdUrl, webHeaders(creds.cookie, creds.csrf, `${YUQUE_WEB_BASE}/dashboard`), true);
      if (!res.ok) {
        errors.push(`${title}: ${res.error || "获取文档失败"}`);
        continue;
      }
      const markdown = res.body.trim();
      if (!markdown) {
        errors.push(`${title}: 正文为空`);
        continue;
      }
      // 调试：打印原始 markdown 前 1200 字符，用于排查Yuque导出格式
      // （分栏/高亮/公式块等特殊结构在 markdown 里的真实形态）
      console.log(`[yuque-import] ${title} markdown head:\n${markdown.slice(0, 1200)}`);

      const noteId = uuid();
      const createdAt = now();

      // 先插占位行（attachments 外键依赖 notes 行存在）
      try {
        db.prepare(
          `INSERT INTO notes (id, userId, notebookId, title, content, contentText, createdAt, updatedAt, workspaceId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(noteId, userId, targetNotebookId, title, "", "", createdAt, createdAt, workspaceId);
      } catch (err: any) {
        errors.push(`${title}: 写入失败 ${err?.message || err}`);
        continue;
      }

      // Markdown → 项目 HTML（公式保留）→ 入库清洗 → 图片本地化
      const normalized = yuqueMarkdownToHtml(markdown);
      const sanitized = sanitizeForImport(normalized);
      const { html: bodyHtml, downloaded, failed } = await rewriteImages(sanitized, userId, noteId, workspaceId, {
        referer: "https://www.yuque.com/",
        authCookie: creds.cookie,
      });
      downloadedImages += downloaded;
      failedImages += failed;

      const contentText = bodyHtml
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      db.prepare("UPDATE notes SET content = ?, contentText = ?, updatedAt = ? WHERE id = ?")
        .run(bodyHtml, contentText, now(), noteId);
      inserted.push(noteId);
    } catch (err: any) {
      errors.push(`${title}: ${err?.message || "处理失败"}`);
    }
  }

  return c.json({
    success: inserted.length > 0,
    count: inserted.length,
    notebookId: targetNotebookId,
    downloadedImages,
    failedImages,
    errors,
  });
});

/**
 * 重试失败图片：导入后部分图片（通常是需登录态的Yuque私有图）下载失败，
 * 正文里这些 <img> 会保留原始远程 URL（带 referrerpolicy="no-referrer"）。
 * 此端点就地更新目标笔记本里仍含远程 <img> 的笔记：重新本地化这些图片
 * （携带 cookie 以通过Yuque鉴权），不重建笔记、不产生重复。
 * 已本地化的图片（/api/attachments/）会被 rewriteImages 跳过，不会重复下载。
 */
app.post("/retry-images", async (c) => {
  const creds = await requireCreds(c);
  if (!creds) return c.json({ error: "请填写 Cookie 与 X-Csrf-Token" }, 400);
  const { notebookId } = (await c.req.json()) as { notebookId?: string };
  if (!notebookId) return c.json({ error: "缺少笔记本标识" }, 400);

  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "未登录" }, 401);
  const db = getDb();

  const notes = db
    .prepare("SELECT id, content, workspaceId FROM notes WHERE userId = ? AND notebookId = ?")
    .all(userId, notebookId) as Array<{ id: string; content: string; workspaceId: string | null }>;

  // 只处理仍含远程 <img>（非 /api/attachments/）的笔记
  const needRetry = notes.filter(
    (n) => typeof n.content === "string" && /<img\b[^>]*\bsrc=["']https?:\/\//i.test(n.content),
  );

  let downloadedImages = 0;
  let failedImages = 0;
  let notesUpdated = 0;

  for (const note of needRetry) {
    try {
      const { html: bodyHtml, downloaded, failed } = await rewriteImages(note.content, userId, note.id, note.workspaceId, {
        referer: "https://www.yuque.com/",
        authCookie: creds.cookie,
      });
      if (downloaded === 0 && failed === 0) continue; // 无远程图可重试
      downloadedImages += downloaded;
      failedImages += failed;
      notesUpdated += 1;
      const contentText = bodyHtml
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      db.prepare("UPDATE notes SET content = ?, contentText = ?, updatedAt = ? WHERE id = ?")
        .run(bodyHtml, contentText, new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""), note.id);
    } catch (err: any) {
      // 单篇失败不影响其他篇
      console.warn("[yuque-import] 重试图片失败", note.id, err?.message || err);
    }
  }

  return c.json({
    success: true,
    notebookId,
    downloadedImages,
    failedImages,
    notesUpdated,
  });
});

export default app;

import { Hono, Context } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";

const app = new Hono();

const DOCS_DIR = path.join(process.cwd(), "data/documents");
const ONLYOFFICE_JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET || "nowen-note-onlyoffice-secret";
// ONLYOFFICE Document Server 内部地址（Docker 网络中用）
const ONLYOFFICE_INTERNAL_URL = process.env.ONLYOFFICE_URL || "http://localhost:8080";
// ONLYOFFICE Document Server 外部地址（浏览器访问用）
const ONLYOFFICE_PUBLIC_URL = process.env.ONLYOFFICE_PUBLIC_URL || "http://localhost:8080";
// 本应用的回调地址（ONLYOFFICE 回调到本应用用，Docker 内用服务名）
const APP_CALLBACK_URL = process.env.APP_CALLBACK_URL || "http://localhost:3001";

// 确保文档存储目录存在
if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

// 文档类型配置
const DOC_TYPE_MAP: Record<string, { ext: string; documentType: string; mime: string }> = {
  word: { ext: "docx", documentType: "word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  cell: { ext: "xlsx", documentType: "cell", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  slide: { ext: "pptx", documentType: "slide", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};

// 确保 documents 表存在
function ensureTable() {
  const db = getDb();

  // 检查旧表兼容性
  try {
    const tableInfo = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    if (tableInfo.length > 0) {
      const cols = tableInfo.map((c) => c.name);
      if (!cols.includes("docType") || !cols.includes("fileKey")) {
        // 旧表不兼容，删除重建
        db.exec("DROP TABLE IF EXISTS documents");
      }
    }
  } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '未命名文档',
      docType TEXT NOT NULL DEFAULT 'word',
      fileKey TEXT NOT NULL,
      fileSize INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(userId);
    CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(docType);
  `);
}

ensureTable();

// 创建空白文档模板
function createEmptyDocument(docType: string): Buffer {
  const templates: Record<string, string> = {
    word: path.join(__dirname, "../../templates/empty.docx"),
    cell: path.join(__dirname, "../../templates/empty.xlsx"),
    slide: path.join(__dirname, "../../templates/empty.pptx"),
  };

  const templatePath = templates[docType];
  if (templatePath && fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath);
  }

  // 如果没有模板文件，创建最小的有效文件
  // 实际中应该使用预制的空白模板
  return Buffer.alloc(0);
}

// 签名 ONLYOFFICE JWT token
function signOOToken(payload: any): string {
  return jwt.sign(payload, ONLYOFFICE_JWT_SECRET);
}

// ========== API 路由 ==========

// 获取文档列表
app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const docType = c.req.query("docType");

  let sql = "SELECT id, userId, title, docType, fileSize, createdAt, updatedAt FROM documents WHERE userId = ?";
  const params: any[] = [userId];

  if (docType && docType !== "all") {
    sql += " AND docType = ?";
    params.push(docType);
  }

  sql += " ORDER BY updatedAt DESC";
  const rows = db.prepare(sql).all(...params);
  return c.json(rows);
});

// 获取单个文档
app.get("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");
  const row = db.prepare("SELECT * FROM documents WHERE id = ? AND userId = ?").get(id, userId);
  if (!row) return c.json({ error: "文档不存在" }, 404);
  return c.json(row);
});

// 创建文档
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const body = await c.req.json();

  const id = uuidv4();
  const docType = body.docType || "word";
  const title = body.title || (docType === "word" ? "未命名文档" : docType === "cell" ? "未命名表格" : "未命名演示");
  const typeInfo = DOC_TYPE_MAP[docType];
  if (!typeInfo) return c.json({ error: "不支持的文档类型" }, 400);

  const fileKey = `${id}.${typeInfo.ext}`;
  const filePath = path.join(DOCS_DIR, fileKey);

  // 创建空白文档
  const content = createEmptyDocument(docType);
  fs.writeFileSync(filePath, content);
  const fileSize = content.length;

  db.prepare(
    "INSERT INTO documents (id, userId, title, docType, fileKey, fileSize) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, userId, title, docType, fileKey, fileSize);

  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  return c.json(row, 201);
});

// 上传文档
app.post("/upload", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "请选择文件" }, 400);

  // 判断文件类型
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  let docType = "word";
  if (["xlsx", "xls", "csv"].includes(ext)) docType = "cell";
  else if (["pptx", "ppt"].includes(ext)) docType = "slide";
  else if (!["docx", "doc", "odt", "rtf", "txt"].includes(ext)) {
    return c.json({ error: "不支持的文件格式" }, 400);
  }

  const id = uuidv4();
  const fileKey = `${id}.${ext}`;
  const filePath = path.join(DOCS_DIR, fileKey);
  const title = file.name.replace(/\.[^.]+$/, "") || "未命名文档";

  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  const fileSize = buffer.length;

  db.prepare(
    "INSERT INTO documents (id, userId, title, docType, fileKey, fileSize) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, userId, title, docType, fileKey, fileSize);

  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  return c.json(row, 201);
});

// 更新文档元信息（如重命名）
app.put("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = db.prepare("SELECT id FROM documents WHERE id = ? AND userId = ?").get(id, userId);
  if (!existing) return c.json({ error: "文档不存在" }, 404);

  const updates: string[] = [];
  const values: any[] = [];

  if (body.title !== undefined) {
    updates.push("title = ?");
    values.push(body.title);
  }

  if (updates.length > 0) {
    updates.push("updatedAt = datetime('now')");
    values.push(id, userId);
    db.prepare(`UPDATE documents SET ${updates.join(", ")} WHERE id = ? AND userId = ?`).run(...values);
  }

  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  return c.json(row);
});

// 删除文档
app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");

  const doc = db.prepare("SELECT id, fileKey FROM documents WHERE id = ? AND userId = ?").get(id, userId) as any;
  if (!doc) return c.json({ error: "文档不存在" }, 404);

  // 删除文件
  const filePath = path.join(DOCS_DIR, doc.fileKey);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  db.prepare("DELETE FROM documents WHERE id = ? AND userId = ?").run(id, userId);
  return c.json({ success: true });
});

// 批量删除
app.post("/batch-delete", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const body = await c.req.json();
  const ids: string[] = body.ids;
  if (!ids || ids.length === 0) return c.json({ error: "请选择要删除的文档" }, 400);

  const placeholders = ids.map(() => "?").join(",");
  const docs = db.prepare(
    `SELECT id, fileKey FROM documents WHERE id IN (${placeholders}) AND userId = ?`
  ).all(...ids, userId) as any[];

  // 删除文件
  for (const doc of docs) {
    const filePath = path.join(DOCS_DIR, doc.fileKey);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  db.prepare(
    `DELETE FROM documents WHERE id IN (${placeholders}) AND userId = ?`
  ).run(...ids, userId);

  return c.json({ success: true, count: docs.length });
});

// 下载文档文件（供 ONLYOFFICE 拉取）
app.get("/:id/file", (c) => {
  const db = getDb();
  const id = c.req.param("id");

  // 这个接口需要对 ONLYOFFICE 服务器开放，但也需要基本安全
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as any;
  if (!doc) return c.json({ error: "文档不存在" }, 404);

  const filePath = path.join(DOCS_DIR, doc.fileKey);
  if (!fs.existsSync(filePath)) return c.json({ error: "文件不存在" }, 404);

  const ext = doc.fileKey.split(".").pop()?.toLowerCase() || "docx";
  const typeInfo = DOC_TYPE_MAP[doc.docType] || DOC_TYPE_MAP.word;

  const buffer = fs.readFileSync(filePath);
  return new Response(buffer, {
    headers: {
      "Content-Type": typeInfo.mime,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(doc.title)}.${ext}"`,
      "Content-Length": String(buffer.length),
    },
  });
});

// ONLYOFFICE 编辑器配置（前端请求获取完整的编辑器配置）
app.get("/:id/editor-config", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");

  const doc = db.prepare("SELECT * FROM documents WHERE id = ? AND userId = ?").get(id, userId) as any;
  if (!doc) return c.json({ error: "文档不存在" }, 404);

  const user = db.prepare("SELECT id, username FROM users WHERE id = ?").get(userId) as any;
  const typeInfo = DOC_TYPE_MAP[doc.docType] || DOC_TYPE_MAP.word;
  const ext = doc.fileKey.split(".").pop() || typeInfo.ext;

  // 文件下载 URL（ONLYOFFICE 服务端拉取用）
  const fileUrl = `${APP_CALLBACK_URL}/api/documents/${id}/file`;
  // 回调 URL
  const callbackUrl = `${APP_CALLBACK_URL}/api/documents/callback`;

  const editorConfig = {
    document: {
      fileType: ext,
      key: `${doc.id}_${new Date(doc.updatedAt).getTime()}`,
      title: `${doc.title}.${ext}`,
      url: fileUrl,
      permissions: {
        chat: false,
        comment: false,
        download: true,
        edit: true,
        print: true,
        review: false,
      },
    },
    documentType: typeInfo.documentType,
    editorConfig: {
      callbackUrl: callbackUrl,
      lang: "zh-CN",
      mode: "edit",
      user: {
        id: userId,
        name: user?.username || "用户",
      },
      customization: {
        autosave: true,
        compactHeader: true,
        compactToolbar: false,
        feedback: false,
        forcesave: true,
        help: false,
        hideRightMenu: false,
        hideRulers: false,
        submitForm: false,
        about: false,
      },
    },
    token: "",
  };

  // 签名 token
  editorConfig.token = signOOToken(editorConfig);

  return c.json({
    editorConfig,
    onlyofficeUrl: ONLYOFFICE_PUBLIC_URL,
  });
});

// ONLYOFFICE 回调接口（保存文档）
app.post("/callback", async (c) => {
  try {
    const body = await c.req.json();
    const { status, url, key } = body;

    // status:
    // 0 - 无操作
    // 1 - 正在编辑
    // 2 - 已准备好保存（文档关闭后）
    // 4 - 关闭但无修改
    // 6 - 强制保存

    if (status === 2 || status === 6) {
      // 从 key 中提取文档 ID
      const docId = key?.split("_")[0];
      if (!docId) {
        return c.json({ error: 0 });
      }

      const db = getDb();
      const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(docId) as any;
      if (!doc) {
        return c.json({ error: 0 });
      }

      // 从 ONLYOFFICE 下载已修改的文档
      if (url) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
            const filePath = path.join(DOCS_DIR, doc.fileKey);
            fs.writeFileSync(filePath, buffer);

            // 更新数据库
            db.prepare(
              "UPDATE documents SET fileSize = ?, updatedAt = datetime('now') WHERE id = ?"
            ).run(buffer.length, docId);
          }
        } catch (err) {
          console.error("Failed to download document from ONLYOFFICE:", err);
        }
      }
    }

    // 必须返回 { error: 0 } 表示成功
    return c.json({ error: 0 });
  } catch (err) {
    console.error("ONLYOFFICE callback error:", err);
    return c.json({ error: 0 });
  }
});

// 获取 ONLYOFFICE 服务状态
app.get("/onlyoffice/status", async (c) => {
  try {
    const response = await fetch(`${ONLYOFFICE_INTERNAL_URL}/healthcheck`, {
      signal: AbortSignal.timeout(5000),
    });
    const isHealthy = response.ok && (await response.text()) === "true";
    return c.json({ available: isHealthy, url: ONLYOFFICE_PUBLIC_URL });
  } catch {
    return c.json({ available: false, url: ONLYOFFICE_PUBLIC_URL });
  }
});

// 导出的独立处理函数（供 index.ts 在 JWT 中间件之前注册使用）
export async function handleCallback(c: Context) {
  try {
    const body = await c.req.json();
    const { status, url, key } = body;

    if (status === 2 || status === 6) {
      const docId = key?.split("_")[0];
      if (!docId) return c.json({ error: 0 });

      const db = getDb();
      const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(docId) as any;
      if (!doc) return c.json({ error: 0 });

      if (url) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
            const filePath = path.join(DOCS_DIR, doc.fileKey);
            fs.writeFileSync(filePath, buffer);
            db.prepare(
              "UPDATE documents SET fileSize = ?, updatedAt = datetime('now') WHERE id = ?"
            ).run(buffer.length, docId);
          }
        } catch (err) {
          console.error("Failed to download document from ONLYOFFICE:", err);
        }
      }
    }

    return c.json({ error: 0 });
  } catch (err) {
    console.error("ONLYOFFICE callback error:", err);
    return c.json({ error: 0 });
  }
}

export function handleFileDownload(c: Context) {
  const db = getDb();
  const id = c.req.param("id");

  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as any;
  if (!doc) return c.json({ error: "文档不存在" }, 404);

  const filePath = path.join(DOCS_DIR, doc.fileKey);
  if (!fs.existsSync(filePath)) return c.json({ error: "文件不存在" }, 404);

  const ext = doc.fileKey.split(".").pop()?.toLowerCase() || "docx";
  const typeInfo = DOC_TYPE_MAP[doc.docType] || DOC_TYPE_MAP.word;

  const buffer = fs.readFileSync(filePath);
  return new Response(buffer, {
    headers: {
      "Content-Type": typeInfo.mime,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(doc.title)}.${ext}"`,
      "Content-Length": String(buffer.length),
    },
  });
}

export default app;

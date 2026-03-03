import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

const app = new Hono();

const DOCS_DIR = path.join(process.cwd(), "data/documents");

// 确保文档存储目录存在
if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

// 文档类型配置
const DOC_TYPE_MAP: Record<string, { ext: string; mime: string }> = {
  word: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  cell: { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
};

// 确保 documents 表存在
function ensureTable() {
  const db = getDb();

  try {
    const tableInfo = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    if (tableInfo.length > 0) {
      const cols = tableInfo.map((c) => c.name);
      if (!cols.includes("docType") || !cols.includes("fileKey")) {
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
  };

  const templatePath = templates[docType];
  if (templatePath && fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath);
  }

  return Buffer.alloc(0);
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
  if (!DOC_TYPE_MAP[docType]) return c.json({ error: "不支持的文档类型" }, 400);

  const title = body.title || (docType === "word" ? "未命名文档" : "未命名表格");
  const typeInfo = DOC_TYPE_MAP[docType];
  const fileKey = `${id}.${typeInfo.ext}`;
  const filePath = path.join(DOCS_DIR, fileKey);

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

  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  let docType = "word";
  if (["xlsx", "xls", "csv"].includes(ext)) docType = "cell";
  else if (!["docx", "doc", "odt", "rtf", "txt"].includes(ext)) {
    return c.json({ error: "不支持的文件格式，仅支持 Word 和 Excel 文件" }, 400);
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

// 下载文档文件（需 JWT）
app.get("/:id/file", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");

  const doc = db.prepare("SELECT * FROM documents WHERE id = ? AND userId = ?").get(id, userId) as any;
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

// 获取文档文件的原始二进制（供前端预览/编辑读取）
app.get("/:id/content", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");

  const doc = db.prepare("SELECT * FROM documents WHERE id = ? AND userId = ?").get(id, userId) as any;
  if (!doc) return c.json({ error: "文档不存在" }, 404);

  const filePath = path.join(DOCS_DIR, doc.fileKey);
  if (!fs.existsSync(filePath)) return c.json({ error: "文件不存在" }, 404);

  const typeInfo = DOC_TYPE_MAP[doc.docType] || DOC_TYPE_MAP.word;
  const buffer = fs.readFileSync(filePath);

  return new Response(buffer, {
    headers: {
      "Content-Type": typeInfo.mime,
      "Content-Length": String(buffer.length),
    },
  });
});

// 保存文档文件（前端编辑后回传）
app.put("/:id/content", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");

  const doc = db.prepare("SELECT * FROM documents WHERE id = ? AND userId = ?").get(id, userId) as any;
  if (!doc) return c.json({ error: "文档不存在" }, 404);

  const filePath = path.join(DOCS_DIR, doc.fileKey);
  const buffer = Buffer.from(await c.req.arrayBuffer());
  fs.writeFileSync(filePath, buffer);

  db.prepare(
    "UPDATE documents SET fileSize = ?, updatedAt = datetime('now') WHERE id = ?"
  ).run(buffer.length, id);

  return c.json({ success: true, fileSize: buffer.length });
});

export default app;

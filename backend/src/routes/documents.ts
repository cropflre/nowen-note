import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";

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

// 创建最小有效的空白 docx（PK zip 结构）
function createEmptyDocx() {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t></w:t></w:r></w:p>
  </w:body>
</w:document>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("word/document.xml", document);
  return zip;
}

function createEmptyXlsx() {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData/>
</worksheet>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("xl/workbook.xml", workbook);
  zip.file("xl/_rels/workbook.xml.rels", wbRels);
  zip.file("xl/worksheets/sheet1.xml", sheet1);
  return zip;
}

// 创建空白文档模板
async function createEmptyDocument(docType: string): Promise<Buffer> {
  const templates: Record<string, string> = {
    word: path.join(__dirname, "../../templates/empty.docx"),
    cell: path.join(__dirname, "../../templates/empty.xlsx"),
  };

  const templatePath = templates[docType];
  if (templatePath && fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath);
  }

  // 动态生成最小有效文档
  if (docType === "word") {
    const zip = createEmptyDocx();
    return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  }
  if (docType === "cell") {
    const zip = createEmptyXlsx();
    return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
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

  const content = await createEmptyDocument(docType);
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
  const title = file.name.replace(/\.[^.]+$/, "") || "未命名文档";
  let buffer: Buffer = Buffer.from(await file.arrayBuffer());

  // 对非 docx 的 word 类文件，尝试转换为 docx
  let finalExt = ext;
  if (docType === "word" && ext !== "docx") {
    try {
      buffer = await convertToDocx(buffer, ext) as any;
      finalExt = "docx";
    } catch (err) {
      console.error(`Failed to convert .${ext} to .docx:`, err);
      // 转换失败，保留原格式
    }
  }

  const fileKey = `${id}.${finalExt}`;
  const filePath = path.join(DOCS_DIR, fileKey);

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
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": typeInfo.mime,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(doc.title)}.${ext}"`,
      "Content-Length": String(buffer.length),
    },
  });
});

// 获取文档文件的原始二进制（供前端预览/编辑读取）
app.get("/:id/content", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");

  const doc = db.prepare("SELECT * FROM documents WHERE id = ? AND userId = ?").get(id, userId) as any;
  if (!doc) return c.json({ error: "文档不存在" }, 404);

  const filePath = path.join(DOCS_DIR, doc.fileKey);
  if (!fs.existsSync(filePath)) return c.json({ error: "文件不存在" }, 404);

  const typeInfo = DOC_TYPE_MAP[doc.docType] || DOC_TYPE_MAP.word;
  let buffer: Buffer = fs.readFileSync(filePath);

  // 如果是旧格式的 word 文件（.doc/.txt/.rtf/.odt），在读取时转换为 docx
  if (doc.docType === "word") {
    const fileExt = doc.fileKey.split(".").pop()?.toLowerCase() || "";
    if (fileExt !== "docx") {
      try {
        const converted = await convertToDocx(buffer, fileExt);
        // 转换成功后，替换磁盘文件为 docx 格式
        const newFileKey = doc.fileKey.replace(/\.[^.]+$/, ".docx");
        const newFilePath = path.join(DOCS_DIR, newFileKey);
        fs.writeFileSync(newFilePath, converted);
        // 更新数据库记录
        db.prepare("UPDATE documents SET fileKey = ?, fileSize = ? WHERE id = ?")
          .run(newFileKey, converted.length, id);
        // 删除旧文件
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        buffer = converted as any;
      } catch (err) {
        console.error(`Failed to convert .${fileExt} on read:`, err);
        // 转换失败，返回原始内容
      }
    }
  }

  return new Response(new Uint8Array(buffer), {
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

/**
 * 将非 docx 格式的文件转换为 docx
 * 支持 .doc (OLE2), .txt, .rtf
 */
async function convertToDocx(buffer: Buffer, ext: string): Promise<Buffer> {
  if (ext === "doc") {
    // 先尝试 mammoth（支持 .docx 格式的 .doc 文件），转 HTML 保留图片
    try {
      const result = await (mammoth as any).convertToHtml({
        buffer,
        convertImage: mammoth.images.imgElement(async (image: any) => {
          const buf = await image.read();
          const base64 = buf.toString("base64");
          const contentType = image.contentType || "image/png";
          return { src: `data:${contentType};base64,${base64}` };
        }),
      });
      if (result.value && result.value.trim().length > 0) {
        return htmlToDocx(result.value);
      }
    } catch { /* mammoth 不支持此格式，fallback */ }

    // 使用 word-extractor 处理旧版 OLE2 .doc 文件（仅文本）
    const extractor = new WordExtractor();
    const tmpPath = path.join(DOCS_DIR, `_tmp_${Date.now()}.doc`);
    try {
      fs.writeFileSync(tmpPath, buffer);
      const doc = await extractor.extract(tmpPath);
      const text = doc.getBody();
      if (!text || text.trim().length === 0) {
        throw new Error("Extracted empty content from .doc file");
      }
      return textToDocx(text);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  if (ext === "txt") {
    let text = buffer.toString("utf-8");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return textToDocx(text);
  }

  if (ext === "rtf") {
    let text = buffer.toString("utf-8");
    text = text.replace(/\{\\[^{}]*\}/g, "")
      .replace(/\\[a-z]+[\d]*\s?/gi, "")
      .replace(/[{}]/g, "")
      .trim();
    return textToDocx(text);
  }

  if (ext === "odt") {
    const zip = await JSZip.loadAsync(buffer);
    const contentXml = await zip.file("content.xml")?.async("string");
    if (!contentXml) throw new Error("ODT file missing content.xml");
    const text = contentXml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return textToDocx(text);
  }

  throw new Error(`Unsupported format: .${ext}`);
}

/** 将 HTML（含 base64 图片）转为有效的 docx 格式 */
async function htmlToDocx(html: string): Promise<Buffer> {
  // 解析 HTML 提取文本段落和图片
  const paragraphs: Array<{ type: "text"; content: string; bold?: boolean; italic?: boolean; heading?: number } | { type: "image"; base64: string; contentType: string }> = [];

  // 简单 HTML 解析：按标签分段
  const parts = html.split(/(<[^>]+>)/);
  let currentText = "";
  let inBold = false;
  let inItalic = false;
  let headingLevel = 0;

  const flushText = () => {
    if (currentText.trim()) {
      paragraphs.push({ type: "text", content: currentText, bold: inBold, italic: inItalic, heading: headingLevel });
    }
    currentText = "";
  };

  for (const part of parts) {
    if (part.startsWith("<")) {
      const tag = part.toLowerCase();
      if (tag.startsWith("<p") || tag.startsWith("<br") || tag.startsWith("<div")) {
        flushText();
      } else if (tag === "</p>" || tag === "</div>") {
        flushText();
        headingLevel = 0;
      } else if (tag.match(/^<h(\d)/)) {
        flushText();
        headingLevel = parseInt(tag.match(/^<h(\d)/)![1]);
      } else if (tag.match(/^<\/h\d/)) {
        flushText();
        headingLevel = 0;
      } else if (tag === "<strong>" || tag === "<b>") {
        inBold = true;
      } else if (tag === "</strong>" || tag === "</b>") {
        inBold = false;
      } else if (tag === "<em>" || tag === "<i>") {
        inItalic = true;
      } else if (tag === "</em>" || tag === "</i>") {
        inItalic = false;
      } else if (tag.startsWith("<img ")) {
        flushText();
        const srcMatch = part.match(/src="([^"]+)"/);
        if (srcMatch && srcMatch[1].startsWith("data:")) {
          const dataUrl = srcMatch[1];
          const m = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (m) {
            paragraphs.push({ type: "image", base64: m[2], contentType: m[1] });
          }
        }
      }
    } else {
      // 解码 HTML entities
      const decoded = part.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      currentText += decoded;
    }
  }
  flushText();

  // 构建 docx
  const zip = new JSZip();
  const imageFiles: Array<{ rId: string; filename: string; ext: string; base64: string; contentType: string }> = [];
  let rIdCounter = 10;
  let bodyXml = "";

  for (const p of paragraphs) {
    if (p.type === "text") {
      const escaped = p.content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      let rPr = "";
      const fontSize = p.heading && p.heading <= 3 ? (36 - (p.heading - 1) * 4) : 14;
      rPr += `<w:sz w:val="${fontSize * 2}"/><w:szCs w:val="${fontSize * 2}"/>`;
      if (p.bold || (p.heading && p.heading <= 3)) rPr += "<w:b/>";
      if (p.italic) rPr += "<w:i/>";

      bodyXml += `<w:p><w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>\n`;
    } else if (p.type === "image") {
      const rId = `rId${rIdCounter++}`;
      const extMap: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/bmp": "bmp", "image/webp": "webp" };
      const imgExt = extMap[p.contentType] || "png";
      const filename = `image${imageFiles.length + 1}.${imgExt}`;
      imageFiles.push({ rId, filename, ext: imgExt, base64: p.base64, contentType: p.contentType });

      // 尝试获取图片尺寸，默认 400x300 pt → EMU
      const widthEmu = 5000000; // ~394pt
      const heightEmu = 3750000; // ~295pt

      bodyXml += `<w:p><w:r><w:rPr/><w:drawing>
        <wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
          <wp:extent cx="${widthEmu}" cy="${heightEmu}"/>
          <wp:docPr id="${rIdCounter}" name="${filename}"/>
          <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:nvPicPr><pic:cNvPr id="0" name="${filename}"/><pic:cNvPicPr/></pic:nvPicPr>
                <pic:blipFill><a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
                <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
              </pic:pic>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing></w:r></w:p>\n`;
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  // Content Types - 包含图片扩展名
  const imgExts = new Set(imageFiles.map(f => f.ext));
  const extMime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" };
  let ctXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>`;
  for (const ext of imgExts) {
    ctXml += `\n  <Default Extension="${ext}" ContentType="${extMime[ext] || "application/octet-stream"}"/>`;
  }
  ctXml += `\n  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  let docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
  for (const img of imageFiles) {
    docRels += `\n  <Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.filename}"/>`;
  }
  docRels += `\n</Relationships>`;

  zip.file("[Content_Types].xml", ctXml);
  zip.folder("_rels")!.file(".rels", rels);
  zip.folder("word")!.file("document.xml", documentXml);
  zip.folder("word")!.folder("_rels")!.file("document.xml.rels", docRels);

  // 写入图片文件
  for (const img of imageFiles) {
    zip.folder("word")!.folder("media")!.file(img.filename, img.base64, { base64: true });
  }

  return await zip.generateAsync({ type: "nodebuffer" });
}

/** 将纯文本转为有效的 docx 格式 (Buffer) */
async function textToDocx(text: string): Promise<Buffer> {
  const lines = text.split(/\r?\n/);
  let bodyXml = "";
  for (const line of lines) {
    const escaped = line
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    bodyXml += `<w:p><w:r><w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>\n`;
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.folder("_rels")!.file(".rels", rels);
  zip.folder("word")!.file("document.xml", documentXml);
  zip.folder("word")!.folder("_rels")!.file("document.xml.rels", docRels);

  return await zip.generateAsync({ type: "nodebuffer" });
}

export default app;

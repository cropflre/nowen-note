import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";

const fonts = new Hono();

const FONTS_DIR = path.join(process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"), "fonts");

// 确保字体目录存在
function ensureFontsDir() {
  if (!fs.existsSync(FONTS_DIR)) {
    fs.mkdirSync(FONTS_DIR, { recursive: true });
  }
}

// 从字体文件名中提取可读名称
function extractFontName(filename: string): string {
  return filename
    .replace(/\.(otf|otc|ttc|ttf|woff|woff2)$/i, "")
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

// 获取字体列表
fonts.get("/", (c) => {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, name, fileName, format, createdAt FROM custom_fonts ORDER BY createdAt DESC"
  ).all();
  return c.json(rows);
});

// 上传字体（支持多文件批量上传）
fonts.post("/upload", async (c) => {
  ensureFontsDir();

  const body = await c.req.parseBody({ all: true });
  const files = body["files"];

  if (!files) {
    return c.json({ error: "未选择字体文件" }, 400);
  }

  // 统一为数组处理
  const fileList = Array.isArray(files) ? files : [files];
  const ALLOWED_EXT = [".otf", ".otc", ".ttc", ".ttf", ".woff", ".woff2"];
  const MAX_SIZE = 20 * 1024 * 1024; // 单个文件 20MB

  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO custom_fonts (id, name, fileName, format, fileSize, createdAt) VALUES (?, ?, ?, ?, ?, datetime('now'))"
  );

  const results: any[] = [];
  const errors: string[] = [];

  for (const file of fileList) {
    if (!(file instanceof File)) {
      errors.push("无效的文件对象");
      continue;
    }

    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      errors.push(`${file.name}: 不支持的格式 (仅支持 ${ALLOWED_EXT.join(", ")})`);
      continue;
    }

    if (file.size > MAX_SIZE) {
      errors.push(`${file.name}: 文件过大 (最大 20MB)`);
      continue;
    }

    // 检查文件名是否已存在
    const existing = db.prepare("SELECT id FROM custom_fonts WHERE fileName = ?").get(file.name) as any;
    if (existing) {
      errors.push(`${file.name}: 字体已存在`);
      continue;
    }

    try {
      const id = uuid();
      const buffer = Buffer.from(await file.arrayBuffer());
      const savePath = path.join(FONTS_DIR, `${id}${ext}`);

      fs.writeFileSync(savePath, buffer);

      const name = extractFontName(file.name);
      const format = ext.slice(1); // remove dot

      insert.run(id, name, file.name, format, file.size);

      results.push({ id, name, fileName: file.name, format });
    } catch (err: any) {
      errors.push(`${file.name}: 上传失败 (${err.message})`);
    }
  }

  return c.json({ uploaded: results, errors });
});

// 获取字体文件（用于 @font-face src）
fonts.get("/file/:id", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db.prepare("SELECT id, fileName, format FROM custom_fonts WHERE id = ?").get(id) as any;

  if (!row) {
    return c.json({ error: "字体不存在" }, 404);
  }

  const filePath = path.join(FONTS_DIR, `${row.id}.${row.format}`);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: "字体文件丢失" }, 404);
  }

  const mimeMap: Record<string, string> = {
    otf: "font/otf",
    ttf: "font/ttf",
    otc: "font/collection",
    ttc: "font/collection",
    woff: "font/woff",
    woff2: "font/woff2",
  };

  const buffer = fs.readFileSync(filePath);
  return new Response(buffer, {
    headers: {
      "Content-Type": mimeMap[row.format] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

// 删除字体
fonts.delete("/:id", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db.prepare("SELECT id, format FROM custom_fonts WHERE id = ?").get(id) as any;

  if (!row) {
    return c.json({ error: "字体不存在" }, 404);
  }

  // 删除文件
  const filePath = path.join(FONTS_DIR, `${row.id}.${row.format}`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  // 删除数据库记录
  db.prepare("DELETE FROM custom_fonts WHERE id = ?").run(id);

  // 如果当前设置使用了该字体，重置为默认
  db.prepare(
    "DELETE FROM system_settings WHERE key = 'editor_font_family' AND value = ?"
  ).run(id);

  return c.json({ success: true });
});

export default fonts;

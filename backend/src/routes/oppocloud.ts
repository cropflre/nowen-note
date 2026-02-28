import { Hono } from "hono";

const app = new Hono();

interface OppoNoteData {
  id: string;
  title: string;
  content: string;
  createTime?: number;
  modifyTime?: number;
  folderId?: string;
  folderName?: string;
}

// 从 OPPO 便签内容提取标题
function extractTitle(note: OppoNoteData): string {
  if (note.title && note.title.trim()) return note.title.trim();

  const content = note.content || "";
  if (content) {
    const firstLine = content.split("\n")[0] || "";
    const plainText = firstLine
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (plainText) return plainText.substring(0, 50);
  }

  return "未命名便签";
}

// 将 OPPO 便签内容转换为 HTML（兼容 Tiptap 编辑器）
function convertOppoNoteToHtml(content: string): string {
  if (!content) return "<p></p>";

  let html = content;

  // OPPO 便签富文本内容处理
  // 粗体
  html = html.replace(/<b>([\s\S]*?)<\/b>/gi, "<strong>$1</strong>");
  // 斜体
  html = html.replace(/<i>([\s\S]*?)<\/i>/gi, "<em>$1</em>");
  // 下划线
  html = html.replace(/<u>([\s\S]*?)<\/u>/gi, "<u>$1</u>");
  // 删除线
  html = html.replace(/<strike>([\s\S]*?)<\/strike>/gi, "<s>$1</s>");
  html = html.replace(/<del>([\s\S]*?)<\/del>/gi, "<s>$1</s>");

  // 复选框（任务列表）
  html = html.replace(
    /<checkbox[^>]*checked[^>]*>([\s\S]*?)<\/checkbox>/gi,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><div>$1</div></li></ul>'
  );
  html = html.replace(
    /<checkbox[^>]*>([\s\S]*?)<\/checkbox>/gi,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div>$1</div></li></ul>'
  );

  // 移除图片（OPPO 便签图片需要额外下载，暂不支持）
  html = html.replace(/<img[^>]*>/gi, "");

  // 移除剩余自定义标签
  html = html.replace(/<\/?(?:font|color|background|span)[^>]*>/gi, "");

  // 处理换行
  const lines = html.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("<h") ||
      trimmed.startsWith("<p") ||
      trimmed.startsWith("<ul") ||
      trimmed.startsWith("<ol") ||
      trimmed.startsWith("<li") ||
      trimmed.startsWith("<blockquote") ||
      trimmed.startsWith("<hr") ||
      trimmed.startsWith("</")
    ) {
      processedLines.push(trimmed);
    } else {
      processedLines.push(`<p>${trimmed}</p>`);
    }
  }

  html = processedLines.join("\n");
  html = html.replace(/<p>\s*<\/p>/gi, "");

  if (!html.trim()) html = "<p></p>";
  return html;
}

// 提取纯文本
function extractPlainText(content: string): string {
  if (!content) return "";
  return content
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// 导入 OPPO 便签（接收前端提取的 JSON 数据）
app.post("/import", async (c) => {
  const { notes, notebookId } = await c.req.json();

  if (!notes || !Array.isArray(notes) || notes.length === 0) {
    return c.json({ error: "请提供要导入的便签数据" }, 400);
  }

  const results: { id: string; title: string; content: string; contentText: string }[] = [];
  const errors: string[] = [];

  for (const note of notes as OppoNoteData[]) {
    try {
      const title = extractTitle(note);
      const content = convertOppoNoteToHtml(note.content || "");
      const contentText = extractPlainText(note.content || "");

      results.push({
        id: note.id || String(Date.now() + Math.random()),
        title,
        content,
        contentText,
      });
    } catch (err: any) {
      errors.push(`便签处理失败: ${err.message}`);
    }
  }

  if (results.length === 0) {
    return c.json({ error: "没有成功处理任何便签", errors }, 500);
  }

  const { getDb } = await import("../db/schema");
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  // 确定目标笔记本
  let targetNotebookId = notebookId;
  if (!targetNotebookId) {
    const existing = db
      .prepare(
        "SELECT id FROM notebooks WHERE userId = ? AND name = 'OPPO云便签'"
      )
      .get(userId) as { id: string } | undefined;

    if (existing) {
      targetNotebookId = existing.id;
    } else {
      const { v4: uuid } = require("uuid");
      targetNotebookId = uuid();
      db.prepare(
        "INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, 'OPPO云便签', '📱')"
      ).run(targetNotebookId, userId);
    }
  }

  const insert = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const { v4: uuid } = require("uuid");
  const imported: any[] = [];

  const tx = db.transaction(() => {
    for (const note of results) {
      const id = uuid();
      insert.run(
        id,
        userId,
        targetNotebookId,
        note.title,
        note.content,
        note.contentText
      );
      imported.push({ id, title: note.title });
    }
  });
  tx();

  return c.json(
    {
      success: true,
      count: imported.length,
      notebookId: targetNotebookId,
      notes: imported,
      errors,
    },
    201
  );
});

export default app;

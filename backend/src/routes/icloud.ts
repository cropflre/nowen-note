import { Hono } from "hono";

const app = new Hono();

interface iCloudNoteData {
  id: string;
  title: string;
  content: string; // HTML 或纯文本
  folder?: string; // 所属文件夹
  date?: string; // 修改日期，如 "2024-01-15" 或 "2025/03/12 14:30"
  createDate?: string;
  modifyDate?: string;
  hasChecklist?: boolean;
}

// 从 iPhone 备忘录内容提取标题
function extractTitle(note: iCloudNoteData): string {
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

  return "未命名备忘录";
}

// 将 iPhone 备忘录内容转换为 HTML（兼容 Tiptap 编辑器）
function convertAppleNoteToHtml(content: string): string {
  if (!content) return "<p></p>";

  let html = content;

  // Apple Notes 使用的 HTML 标签处理

  // 标题标签（Apple Notes 使用 h1-h3 或带样式的 div）
  html = html.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "<h1>$1</h1>");
  html = html.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "<h2>$1</h2>");
  html = html.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "<h3>$1</h3>");

  // 粗体
  html = html.replace(/<b>([\s\S]*?)<\/b>/gi, "<strong>$1</strong>");
  html = html.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "<strong>$1</strong>");

  // 斜体
  html = html.replace(/<i>([\s\S]*?)<\/i>/gi, "<em>$1</em>");
  html = html.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "<em>$1</em>");

  // 下划线
  html = html.replace(/<u>([\s\S]*?)<\/u>/gi, "<u>$1</u>");

  // 删除线
  html = html.replace(/<strike>([\s\S]*?)<\/strike>/gi, "<s>$1</s>");
  html = html.replace(/<s>([\s\S]*?)<\/s>/gi, "<s>$1</s>");
  html = html.replace(/<del>([\s\S]*?)<\/del>/gi, "<s>$1</s>");

  // Apple Notes 清单（checklist）
  // 已完成的 checklist item
  html = html.replace(
    /<li[^>]*class="[^"]*checked[^"]*"[^>]*>([\s\S]*?)<\/li>/gi,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><div>$1</div></li></ul>'
  );
  // 未完成的 checklist item（去除其他 class）
  html = html.replace(
    /<li[^>]*class="[^"]*unchecked[^"]*"[^>]*>([\s\S]*?)<\/li>/gi,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div>$1</div></li></ul>'
  );

  // input[type=checkbox] 格式的 checklist
  html = html.replace(
    /<input[^>]*type="checkbox"[^>]*checked[^>]*>\s*([\s\S]*?)(?=<input|<\/li|<\/ul|$)/gi,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><div>$1</div></li></ul>'
  );
  html = html.replace(
    /<input[^>]*type="checkbox"[^>]*>\s*([\s\S]*?)(?=<input|<\/li|<\/ul|$)/gi,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div>$1</div></li></ul>'
  );

  // Markdown 格式的 checklist（从纯文本导出）
  html = html.replace(
    /^\s*[-*]\s*\[x\]\s*(.+)$/gim,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><div>$1</div></li></ul>'
  );
  html = html.replace(
    /^\s*[-*]\s*\[\s?\]\s*(.+)$/gim,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div>$1</div></li></ul>'
  );

  // 引用块
  html = html.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "<blockquote>$1</blockquote>");

  // 代码块
  html = html.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "<pre><code>$1</code></pre>");
  html = html.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "<code>$1</code>");

  // 分割线
  html = html.replace(/<hr[^>]*\/?>/gi, "<hr />");

  // 链接
  html = html.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '<a href="$1">$2</a>');

  // 移除图片（Apple Notes 图片需要额外下载，暂不支持）
  html = html.replace(/<img[^>]*>/gi, "");

  // 移除 Apple Notes 特有的内嵌附件标签
  html = html.replace(/<object[^>]*>[\s\S]*?<\/object>/gi, "");
  html = html.replace(/<attachment[^>]*>[\s\S]*?<\/attachment>/gi, "");

  // 移除剩余的不必要标签和属性
  html = html.replace(/<\/?(?:font|span|div)[^>]*>/gi, "");
  html = html.replace(/<br\s*\/?>/gi, "\n");

  // 处理换行：将 \n 转为段落
  const lines = html.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 如果已经是块级元素，直接保留
    if (
      trimmed.startsWith("<h") ||
      trimmed.startsWith("<p") ||
      trimmed.startsWith("<ul") ||
      trimmed.startsWith("<ol") ||
      trimmed.startsWith("<li") ||
      trimmed.startsWith("<blockquote") ||
      trimmed.startsWith("<hr") ||
      trimmed.startsWith("<pre") ||
      trimmed.startsWith("</")
    ) {
      processedLines.push(trimmed);
    } else {
      processedLines.push(`<p>${trimmed}</p>`);
    }
  }

  html = processedLines.join("\n");

  // 清理空段落
  html = html.replace(/<p>\s*<\/p>/gi, "");

  // 确保有内容
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
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// 解析日期字符串为 SQLite datetime 格式
function parseDateString(dateStr: string | undefined, fallback: string): string {
  if (!dateStr) return fallback;

  const trimmed = dateStr.trim().replace(/\//g, "-");

  // 尝试直接解析
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  }

  // 尝试 YYYY-MM-DD 格式
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed + "T00:00:00");
    if (!isNaN(d.getTime())) {
      return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }
  }

  // 尝试 MM-DD 格式（使用当前年份）
  if (/^\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${new Date().getFullYear()}-${trimmed}T00:00:00`);
    if (!isNaN(d.getTime())) {
      return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }
  }

  // 尝试时间戳（秒或毫秒）
  const num = parseInt(trimmed, 10);
  if (!isNaN(num)) {
    const ms = num < 10000000000 ? num * 1000 : num;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }
  }

  return fallback;
}

// 导入 iPhone 备忘录（接收前端提取的 JSON 数据）
app.post("/import", async (c) => {
  const { notes, notebookId } = await c.req.json();

  if (!notes || !Array.isArray(notes) || notes.length === 0) {
    return c.json({ error: "请提供要导入的备忘录数据" }, 400);
  }

  const results: {
    id: string;
    title: string;
    content: string;
    contentText: string;
    folder?: string;
    createDate?: string;
    modifyDate?: string;
  }[] = [];
  const errors: string[] = [];

  for (const note of notes as iCloudNoteData[]) {
    try {
      const title = extractTitle(note);
      const content = convertAppleNoteToHtml(note.content || "");
      const contentText = extractPlainText(note.content || "");

      results.push({
        id: note.id || String(Date.now() + Math.random()),
        title,
        content,
        contentText,
        folder: note.folder,
        createDate: note.createDate || note.date,
        modifyDate: note.modifyDate || note.date,
      });
    } catch (err: any) {
      errors.push(`备忘录处理失败: ${err.message}`);
    }
  }

  if (results.length === 0) {
    return c.json({ error: "没有成功处理任何备忘录", errors }, 500);
  }

  const { getDb } = await import("../db/schema");
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  // 确定目标笔记本
  let targetNotebookId = notebookId;
  if (!targetNotebookId) {
    const existing = db
      .prepare(
        "SELECT id FROM notebooks WHERE userId = ? AND name = 'iPhone备忘录'"
      )
      .get(userId) as { id: string } | undefined;

    if (existing) {
      targetNotebookId = existing.id;
    } else {
      const { v4: uuid } = require("uuid");
      targetNotebookId = uuid();
      db.prepare(
        "INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, 'iPhone备忘录', '📱')"
      ).run(targetNotebookId, userId);
    }
  }

  const insert = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const { v4: uuid } = require("uuid");
  const imported: any[] = [];

  const now = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

  const tx = db.transaction(() => {
    for (const note of results) {
      const id = uuid();
      const createdAt = parseDateString(note.createDate, now);
      const updatedAt = parseDateString(note.modifyDate, createdAt);

      insert.run(
        id,
        userId,
        targetNotebookId,
        note.title,
        note.content,
        note.contentText,
        createdAt,
        updatedAt
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

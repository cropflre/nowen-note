import { Hono } from "hono";

const app = new Hono();

const MI_NOTE_BASE = "https://i.mi.com";
const MI_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://i.mi.com/note/h5",
  Accept: "application/json, text/plain, */*",
};

// 从小米笔记条目中提取标题
function extractTitle(entry: any): string {
  // 1. 尝试从 extraInfo.title 获取
  try {
    const extra =
      typeof entry.extraInfo === "string"
        ? JSON.parse(entry.extraInfo)
        : entry.extraInfo;
    if (extra?.title) return extra.title;
  } catch {}

  // 2. 从内容第一行提取（去除自定义标签后取纯文本）
  const content = entry.content || entry.snippet || "";
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

  // 3. 使用 subject
  if (entry.subject) return entry.subject;

  return "未命名笔记";
}

// 尝试请求小米云服务，手动处理重定向以确保 Cookie 传递
async function miCloudFetch(path: string, cookie: string): Promise<Response> {
  const baseUrl = `https://i.mi.com${path}`;
  console.log(`[miCloudFetch] requesting: ${baseUrl}`);
  
  // 第一次请求，不跟随重定向
  const res = await fetch(baseUrl, {
    headers: { ...MI_HEADERS, Cookie: cookie },
    redirect: "manual",
  });
  
  console.log(`[miCloudFetch] initial status: ${res.status}`);
  
  // 如果是重定向，手动跟随并带上 Cookie
  if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
    const location = res.headers.get("location");
    if (location) {
      console.log(`[miCloudFetch] redirected to: ${location}`);
      const redirectRes = await fetch(location, {
        headers: { ...MI_HEADERS, Cookie: cookie },
        redirect: "manual",
      });
      console.log(`[miCloudFetch] redirect status: ${redirectRes.status}`);
      
      // 如果重定向后还是 401，再重试一次（参考项目的逻辑）
      if (redirectRes.status === 401) {
        console.log(`[miCloudFetch] retrying after 401...`);
        const retryRes = await fetch(location, {
          headers: { ...MI_HEADERS, Cookie: cookie },
        });
        console.log(`[miCloudFetch] retry status: ${retryRes.status}`);
        return retryRes;
      }
      return redirectRes;
    }
  }
  
  // 如果直接 401，尝试 s010 域名
  if (res.status === 401) {
    const s010Url = baseUrl.replace("https://i.mi.com", "https://s010.i.mi.com");
    console.log(`[miCloudFetch] trying s010: ${s010Url}`);
    const s010Res = await fetch(s010Url, {
      headers: { ...MI_HEADERS, Cookie: cookie },
    });
    console.log(`[miCloudFetch] s010 status: ${s010Res.status}`);
    
    // 如果 s010 也 401，再重试一次
    if (s010Res.status === 401) {
      console.log(`[miCloudFetch] retrying s010...`);
      const retryRes = await fetch(s010Url, {
        headers: { ...MI_HEADERS, Cookie: cookie },
      });
      console.log(`[miCloudFetch] s010 retry status: ${retryRes.status}`);
      return retryRes;
    }
    return s010Res;
  }
  
  return res;
}

// 验证 Cookie 是否有效（获取第一页笔记列表测试）
app.post("/verify", async (c) => {
  const { cookie } = await c.req.json();
  if (!cookie || typeof cookie !== "string" || cookie.trim().length === 0) {
    return c.json({ error: "请提供有效的 Cookie" }, 400);
  }

  try {
    const ts = Date.now();
    const path = `/note/full/page/?ts=${ts}&limit=1`;
    const res = await miCloudFetch(path, cookie);

    console.log("[micloud/verify] status:", res.status, "url:", res.url);

    if (!res.ok) {
      return c.json(
        { valid: false, error: `小米云服务返回 ${res.status}` },
        200
      );
    }

    const data = (await res.json()) as any;
    console.log("[micloud/verify] response code:", data?.code, "has entries:", !!data?.data?.entries);
    
    // code !== 0 说明 Cookie 无效
    if (data?.code !== undefined && data?.code !== 0) {
      return c.json({ valid: false, error: "Cookie 无效或已过期" }, 200);
    }

    return c.json({ valid: true }, 200);
  } catch (err: any) {
    return c.json(
      { valid: false, error: err.message || "网络请求失败" },
      200
    );
  }
});

// 获取笔记列表（分页获取全部）
app.post("/notes", async (c) => {
  const { cookie } = await c.req.json();
  if (!cookie) return c.json({ error: "缺少 Cookie" }, 400);

  try {
    const allEntries: any[] = [];
    const allFolders: Record<string, string> = {};
    let syncTag: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const ts = Date.now();
      let path = `/note/full/page/?ts=${ts}&limit=200`;
      if (syncTag) path += `&syncTag=${encodeURIComponent(syncTag)}`;

      const res = await miCloudFetch(path, cookie);

      if (!res.ok) {
        return c.json(
          { error: `获取笔记列表失败: ${res.status}` },
          500
        );
      }

      const data = (await res.json()) as any;
      if (data?.data?.entries) {
        allEntries.push(...data.data.entries);
      }
      if (data?.data?.folders) {
        for (const f of data.data.folders) {
          allFolders[f.id] = f.subject;
        }
      }
      syncTag = data?.data?.syncTag;
      hasMore = !data?.data?.lastPage;
    }

    // 解析每条笔记的基本信息
    const notes = allEntries.map((entry: any) => {
      const title = extractTitle(entry);

      return {
        id: entry.id,
        title,
        snippet: entry.snippet || "",
        folderId: entry.folderId || "",
        folderName: allFolders[entry.folderId] || "",
        createDate: entry.createDate,
        modifyDate: entry.modifyDate,
        colorId: entry.colorId,
      };
    });

    return c.json({ notes, folders: allFolders }, 200);
  } catch (err: any) {
    return c.json({ error: err.message || "获取笔记列表失败" }, 500);
  }
});

// 获取单条笔记详情
app.post("/note/:id", async (c) => {
  const id = c.req.param("id");
  const { cookie } = await c.req.json();
  if (!cookie) return c.json({ error: "缺少 Cookie" }, 400);

  try {
    const ts = Date.now();
    const path = `/note/note/${id}/?ts=${ts}`;
    const res = await miCloudFetch(path, cookie);

    if (!res.ok) {
      return c.json({ error: `获取笔记详情失败: ${res.status}` }, 500);
    }

    const data = (await res.json()) as any;
    const entry = data?.data?.entry;
    if (!entry) {
      return c.json({ error: "笔记不存在" }, 404);
    }

    return c.json({ note: entry }, 200);
  } catch (err: any) {
    return c.json({ error: err.message || "获取笔记详情失败" }, 500);
  }
});

// 批量获取笔记详情并转换格式后导入
app.post("/import", async (c) => {
  const { cookie, noteIds, notebookId } = await c.req.json();
  if (!cookie) return c.json({ error: "缺少 Cookie" }, 400);
  if (!noteIds || !Array.isArray(noteIds) || noteIds.length === 0) {
    return c.json({ error: "请选择要导入的笔记" }, 400);
  }

  const results: { id: string; title: string; content: string; contentText: string; createDate?: number; modifyDate?: number }[] = [];
  const errors: string[] = [];

  for (const noteId of noteIds) {
    try {
      const ts = Date.now();
      const path = `/note/note/${noteId}/?ts=${ts}`;
      const res = await miCloudFetch(path, cookie);

      if (!res.ok) {
        errors.push(`笔记 ${noteId} 获取失败: ${res.status}`);
        continue;
      }

      const data = (await res.json()) as any;
      const entry = data?.data?.entry;
      if (!entry) {
        errors.push(`笔记 ${noteId} 不存在`);
        continue;
      }

      // 解析标题
      const title = extractTitle(entry);

      // 转换内容为 HTML（含图片下载）
      const content = await convertMiNoteToHtmlAsync(entry.content || "", cookie);
      const contentText = extractPlainText(entry.content || "");

      results.push({
        id: noteId,
        title,
        content,
        contentText,
        createDate: entry.createDate,
        modifyDate: entry.modifyDate,
      });
    } catch (err: any) {
      errors.push(`笔记 ${noteId} 处理失败: ${err.message}`);
    }
  }

  // 调用现有导入逻辑
  if (results.length === 0) {
    return c.json({ error: "没有成功获取任何笔记", errors }, 500);
  }

  const { getDb } = await import("../db/schema");
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  // 确定目标笔记本
  let targetNotebookId = notebookId;
  if (!targetNotebookId) {
    const existing = db
      .prepare(
        "SELECT id FROM notebooks WHERE userId = ? AND name = '小米云笔记'"
      )
      .get(userId) as { id: string } | undefined;

    if (existing) {
      targetNotebookId = existing.id;
    } else {
      const { v4: uuid } = require("uuid");
      targetNotebookId = uuid();
      db.prepare(
        "INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, '小米云笔记', '📱')"
      ).run(targetNotebookId, userId);
    }
  }

  const insert = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const { v4: uuid } = require("uuid");
  const imported: any[] = [];

  // 将时间戳转为 SQLite datetime 兼容格式：YYYY-MM-DD HH:MM:SS
  function toSqliteDatetime(ts: number | string | undefined, fallback: string): string {
    if (!ts) return fallback;
    let ms: number;
    if (typeof ts === 'number') {
      ms = ts < 10000000000 ? ts * 1000 : ts;
    } else {
      const parsed = parseInt(String(ts), 10);
      if (isNaN(parsed)) return fallback;
      ms = parsed < 10000000000 ? parsed * 1000 : parsed;
    }
    const date = new Date(ms);
    if (isNaN(date.getTime())) return fallback;
    return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  }

  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

  const tx = db.transaction(() => {
    for (const note of results) {
      const id = uuid();
      const createdAt = toSqliteDatetime(note.createDate, now);
      const updatedAt = toSqliteDatetime(note.modifyDate, createdAt);
      
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

// 从小米云服务下载图片并转为 base64 Data URL
async function downloadMiNoteImage(fileId: string, cookie: string): Promise<string | null> {
  try {
    // 小米云服务图片下载接口，可能会有多种 URL 格式
    const urls = [
      `/file/full?type=note_img&fileid=${encodeURIComponent(fileId)}`,
      `/note/file/${encodeURIComponent(fileId)}`,
    ];

    for (const urlPath of urls) {
      try {
        const res = await miCloudFetch(urlPath, cookie);
        if (!res.ok) continue;

        const contentType = res.headers.get("content-type") || "image/jpeg";
        // 确保返回的确实是图片
        if (!contentType.startsWith("image/")) continue;

        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length === 0) continue;

        const base64 = buffer.toString("base64");
        const mimeType = contentType.split(";")[0].trim();
        return `data:${mimeType};base64,${base64}`;
      } catch {
        continue;
      }
    }

    console.log(`[micloud] 图片 ${fileId} 所有下载方式均失败`);
    return null;
  } catch (err: any) {
    console.log(`[micloud] 图片 ${fileId} 下载异常: ${err.message}`);
    return null;
  }
}

// 从内容中提取所有图片 fileId
function extractImageFileIds(content: string): string[] {
  const fileIds: string[] = [];
  // 匹配 <img> 标签中的 fileid 属性（不区分大小写）
  const imgRegex = /<img[^>]*\bfileid\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = imgRegex.exec(content)) !== null) {
    fileIds.push(match[1]);
  }
  return fileIds;
}

// 将小米笔记内容转换为 HTML（兼容 Tiptap 编辑器），支持异步下载图片
async function convertMiNoteToHtmlAsync(content: string, cookie: string): Promise<string> {
  if (!content) return "<p></p>";

  let html = content;

  // 移除 fold 标签
  html = html.replace(/<\/?fold>/gi, "");

  // 分割线
  html = html.replace(/<line\s*\/?>/gi, "<hr />");

  // 标题：小米笔记使用 <size>, <mid-size>, <h3-size>
  html = html.replace(/<size>([\s\S]*?)<\/size>/gi, "<h1>$1</h1>");
  html = html.replace(/<mid-size>([\s\S]*?)<\/mid-size>/gi, "<h2>$1</h2>");
  html = html.replace(/<h3-size>([\s\S]*?)<\/h3-size>/gi, "<h3>$1</h3>");

  // 粗体
  html = html.replace(/<b>([\s\S]*?)<\/b>/gi, "<strong>$1</strong>");

  // 斜体
  html = html.replace(/<i>([\s\S]*?)<\/i>/gi, "<em>$1</em>");

  // 下划线
  html = html.replace(/<u>([\s\S]*?)<\/u>/gi, "<u>$1</u>");

  // 删除线
  html = html.replace(/<delete>([\s\S]*?)<\/delete>/gi, "<s>$1</s>");

  // 引用块
  html = html.replace(/<quote>([\s\S]*?)<\/quote>/gi, "<blockquote>$1</blockquote>");

  // 复选框（任务列表）
  html = html.replace(
    /<checkbox[^>]*checked="true"[^>]*>([\s\S]*?)<\/checkbox>/gi,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><div>$1</div></li></ul>'
  );
  html = html.replace(
    /<checkbox[^>]*checked="false"[^>]*>([\s\S]*?)<\/checkbox>/gi,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div>$1</div></li></ul>'
  );
  html = html.replace(
    /<checkbox-on>([\s\S]*?)<\/checkbox-on>/gi,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><div>$1</div></li></ul>'
  );
  html = html.replace(
    /<checkbox-off>([\s\S]*?)<\/checkbox-off>/gi,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div>$1</div></li></ul>'
  );

  // 有序列表
  html = html.replace(
    /<ol[^>]*indent="(\d+)"[^>]*>([\s\S]*?)<\/ol>/gi,
    (_match, _indent, text) => `<li>${text}</li>`
  );

  // 无序列表
  html = html.replace(
    /<ul[^>]*indent="(\d+)"[^>]*>([\s\S]*?)<\/ul>/gi,
    (_match, _indent, text) => `<li>${text}</li>`
  );

  // 对齐标签
  html = html.replace(/<center>([\s\S]*?)<\/center>/gi, '<p style="text-align: center">$1</p>');
  html = html.replace(/<left>([\s\S]*?)<\/left>/gi, "<p>$1</p>");
  html = html.replace(/<right>([\s\S]*?)<\/right>/gi, '<p style="text-align: right">$1</p>');

  // 文本缩进
  html = html.replace(/<text[^>]*indent="(\d+)"[^>]*>([\s\S]*?)<\/text>/gi, (_match, _indent, text) => `<p>${text}</p>`);

  // 背景色
  html = html.replace(
    /<background[^>]*color="([^"]*)"[^>]*>([\s\S]*?)<\/background>/gi,
    '<mark>$2</mark>'
  );

  // 处理图片：下载小米云中的图片并转为 base64 嵌入
  const imgMatches: { fullMatch: string; fileId: string }[] = [];
  const imgRegex = /<img[^>]*\bfileid\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    imgMatches.push({ fullMatch: match[0], fileId: match[1] });
  }

  if (imgMatches.length > 0) {
    console.log(`[micloud] 发现 ${imgMatches.length} 张图片，开始下载...`);
    // 并发下载所有图片（限制并发数为 5）
    const CONCURRENCY = 5;
    const imageMap = new Map<string, string | null>();

    for (let i = 0; i < imgMatches.length; i += CONCURRENCY) {
      const batch = imgMatches.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (img) => {
          const dataUrl = await downloadMiNoteImage(img.fileId, cookie);
          return { fileId: img.fileId, dataUrl };
        })
      );
      for (const r of results) {
        imageMap.set(r.fileId, r.dataUrl);
      }
    }

    // 替换 img 标签为包含 base64 的标准 img 标签
    for (const img of imgMatches) {
      const dataUrl = imageMap.get(img.fileId);
      if (dataUrl) {
        html = html.replace(img.fullMatch, `<img src="${dataUrl}" />`);
      } else {
        // 下载失败则移除该图片标签
        html = html.replace(img.fullMatch, "");
      }
    }
  }

  // 移除没有 fileid 但也不是标准 img 的残留 img 标签（无 src 的）
  html = html.replace(/<img(?![^>]*\bsrc\s*=)[^>]*>/gi, "");

  // 移除剩余的自定义标签
  html = html.replace(/<\/?(?:text|background|color)[^>]*>/gi, "");

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
      trimmed.startsWith("<img") ||
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
    .replace(/\s+/g, " ")
    .trim();
}

export default app;

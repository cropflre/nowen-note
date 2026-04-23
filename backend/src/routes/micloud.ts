import { Hono } from "hono";

const app = new Hono();

const MI_NOTE_BASE = "https://i.mi.com";
const MI_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://i.mi.com/note/h5",
  Accept: "application/json, text/plain, */*",
};

// 小米笔记图片短格式匹配：
// 形如 `123456.aBcDeF_-xyz<0/>` —— fileId 后紧跟 `<段落索引/>`。
// fileId 字符集：字母、数字、小数点、下划线、减号。索引标签可能为 <0/>、<1/>、<n/> 等。
// 这不是标准 HTML 图片标签，需要先识别并剥离/转换。
const MI_SHORT_IMG_RE = /([A-Za-z0-9][A-Za-z0-9._-]{6,})<\d+\s*\/>/g;

// 小米笔记"图片占位符"字符：
// 小米笔记在纯图片笔记里，会用 ☺（U+263A）或 ☻（U+263B，极少见）作为图片占位字符，
// 后面可能跟 `<N/>` 段落索引（对应 extraInfo.imgs[N] 的 fileId），也可能裸站。
// 以前只认 `fileId<N/>` 短格式，于是 `☺<0/>` 的纯图片笔记：
//   1) 标题提取跳不过这行 → 标题变成 "☺"
//   2) HTML 转换不识别 → 正文每张图位置原样保留 "☺"
// 所以现在把 ☺/☻ 也视为合法的图片占位。
const MI_IMG_PLACEHOLDER_CHARS = /[\u263A\u263B]/;
// ☺<0/>、☺<1/> 这种：占位符 + 索引标签
const MI_PLACEHOLDER_WITH_INDEX_RE = /([\u263A\u263B])<(\d+)\s*\/>/g;
// ☺ + 空白 + 裸 fileId 格式（老版小米便签 / 官方示例"欢迎使用小米便签"/"语音便签"）：
// content 里直接写 `☺ 119791.G81zpx4HvpA7f-p2J5jK5A`，fileId 不在 extraInfo.imgs 里，
// 而是紧跟 ☺ 后面。中间的分隔符小米实测不只有普通空格/NBSP，还可能是 U+FE0F（emoji 变体
// 选择符，让 ☺ 渲染为彩色 emoji）、U+200B 零宽空格、U+FEFF BOM 等不可见字符。
// 所以这里放宽为：☺ 后面"非字母数字"直到遇到 fileId 首字符。fileId 长度通常 15+，用 {10,}。
const MI_PLACEHOLDER_WITH_INLINE_ID_RE =
  /[\u263A\u263B][^A-Za-z0-9]{0,8}([A-Za-z0-9][A-Za-z0-9._-]{10,})/g;
// 紧邻 <img ...> 前的 ☺（中间可能是各种空白、变体选择符、<br>、&nbsp;）
const MI_PLACEHOLDER_BEFORE_IMG_RE =
  /[\u263A\u263B][^<]{0,10}?(?=<img\b)/gi;
// 裸占位符（无索引）
const MI_PLACEHOLDER_BARE_RE = /[\u263A\u263B]/g;

// 孤儿段落索引标签：`<0/>`、`<1/>`、`<12 />` 这种纯数字内容的"伪标签"，
// 本该紧跟 fileId 或 ☺，若因为小米那边格式变种导致分离，正则匹配不到，
// 最后会作为纯文本残留在正文。单独留一个在图片后面肉眼很难看，兜底清理。
// 注意：正则故意只匹配纯数字内容，避免误伤 <br/> / <hr/> / <li/>。
const MI_ORPHAN_INDEX_RE = /<\d+\s*\/>/g;

// 判断一行纯文本是否"只是"图片占位（短格式、<img> 标签、或 ☺ 占位符），用于标题提取时跳过
function isImageOnlyLine(line: string): boolean {
  const stripped = line
    .replace(/<img\b[^>]*>/gi, "")
    .replace(MI_SHORT_IMG_RE, "")
    .replace(MI_PLACEHOLDER_WITH_INDEX_RE, "")
    // "☺ fileId" 作为整体也算图片占位，不然 fileId 会被误当成标题
    .replace(MI_PLACEHOLDER_WITH_INLINE_ID_RE, "")
    .replace(MI_PLACEHOLDER_BARE_RE, "")
    .replace(/<[^>]+>/g, "")
    .trim();
  return stripped.length === 0;
}

// 从 entry 中安全提取 extraInfo.imgs（小米笔记图片附件列表，字段名按实测兼容多种）。
// 返回 fileId 数组，顺序即正文中占位符的默认匹配顺序。
function extractImgFileIds(entry: any): string[] {
  try {
    const extra =
      typeof entry?.extraInfo === "string"
        ? JSON.parse(entry.extraInfo)
        : entry?.extraInfo;
    if (!extra) return [];
    // 兼容几种可能的字段名：imgs / noteImgInfos / images / attachments
    const list =
      extra.imgs ||
      extra.noteImgInfos ||
      extra.images ||
      extra.attachments ||
      [];
    if (!Array.isArray(list)) return [];
    return list
      .map((it: any) =>
        typeof it === "string"
          ? it
          : it?.fileId || it?.fileid || it?.id || it?.url || ""
      )
      .filter((x: string) => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

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

  // 2. 从内容逐行提取（跳过纯图片行，去除自定义标签后取纯文本）
  const content = entry.content || entry.snippet || "";
  if (content) {
    const lines = content.split("\n");
    for (const rawLine of lines) {
      if (!rawLine || !rawLine.trim()) continue;
      if (isImageOnlyLine(rawLine)) continue;
      const plainText = rawLine
        .replace(/<img\b[^>]*>/gi, "")
        .replace(MI_SHORT_IMG_RE, "")
        // 去掉"占位符 + 索引"、"☺ fileId" 和裸占位符，避免标题变成 ☺ 或光秃秃的 fileId
        .replace(MI_PLACEHOLDER_WITH_INDEX_RE, "")
        .replace(MI_PLACEHOLDER_WITH_INLINE_ID_RE, "")
        .replace(MI_PLACEHOLDER_BARE_RE, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();
      if (plainText) return plainText.substring(0, 50);
    }
  }

  // 3. 使用 subject（也需过滤 ☺ 占位符，避免 subject 本身就是 ☺ 的情况）
  if (entry.subject) {
    const cleanSubject = String(entry.subject)
      .replace(MI_PLACEHOLDER_WITH_INDEX_RE, "")
      .replace(MI_PLACEHOLDER_WITH_INLINE_ID_RE, "")
      .replace(MI_PLACEHOLDER_BARE_RE, "")
      .trim();
    if (cleanSubject) return cleanSubject;
  }

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
      // snippet 也可能是 "☺" / "☺ fileId" / "图<0/>"，列表里展示成这些很奇怪，统一清理
      const snippet = String(entry.snippet || "")
        .replace(MI_PLACEHOLDER_WITH_INDEX_RE, "")
        .replace(MI_PLACEHOLDER_WITH_INLINE_ID_RE, "")
        .replace(MI_PLACEHOLDER_BARE_RE, "")
        .replace(MI_SHORT_IMG_RE, "")
        .replace(MI_ORPHAN_INDEX_RE, "")
        .trim();

      return {
        id: entry.id,
        title,
        snippet,
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

      // 转换内容为 HTML（含图片下载）——传 entry 进去以便从 extraInfo.imgs 解析 ☺ 占位符
      const content = await convertMiNoteToHtmlAsync(entry.content || "", cookie, entry);
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
// entry 是可选的原始小米笔记条目，用于从 extraInfo.imgs 解析 ☺ 占位符对应的 fileId
async function convertMiNoteToHtmlAsync(content: string, cookie: string, entry?: any): Promise<string> {
  if (!content) return "<p></p>";

  let html = content;

  // ☺ 占位符归一化：
  // 小米笔记"纯图片笔记"或正文嵌图的典型 content 形如 `☺<0/>\n☺<1/>` 或 `☺☺`，
  // 对应的 fileId 列表在 entry.extraInfo.imgs 里。顺序规则：
  //   - `☺<N/>` → imgs[N] 的 fileId
  //   - `☺ 119791.xxxxx`（空白+裸 fileId，老版/官方示例格式）→ 直接用内联的 fileId
  //   - `☺<img ...>`（小米有时在正式 <img> 前多写一个 ☺ 装饰）→ 删掉 ☺
  //   - 裸 ☺   → 按出现顺序消费 imgs 里剩余未用的 fileId
  // 解析出来后先整形成统一的 `<img fileid="xxx" />`，下面的图片下载逻辑就能兜底。
  // 如果 imgs 为空（比如 extraInfo 字段缺失或字段名不匹配），最好的策略是直接
  // 把 ☺ 从文本里删掉 —— 至少肉眼看上去不再是"笑脸满天飞"。
  if (MI_IMG_PLACEHOLDER_CHARS.test(html)) {
    const imgFileIds = entry ? extractImgFileIds(entry) : [];
    const usedIndices = new Set<number>();

    // 1) 先处理带索引的占位符：☺<0/>
    html = html.replace(MI_PLACEHOLDER_WITH_INDEX_RE, (_m, _char, idx) => {
      const i = parseInt(idx, 10);
      const fid = imgFileIds[i];
      if (fid) {
        usedIndices.add(i);
        return `<img fileid="${fid}" />`;
      }
      return ""; // 拿不到就清空
    });

    // 2) 处理"☺ + 空白 + 裸 fileId"：这是老版小米便签示例笔记的格式，
    //    fileId 不在 extraInfo 里而是直接写在 content 字符串里。
    //    必须在"裸 ☺ 消费 imgs"之前处理，否则 ☺ 会被先吃掉，fileId 变孤儿残留成纯文本。
    html = html.replace(
      MI_PLACEHOLDER_WITH_INLINE_ID_RE,
      (_m, fileId: string) => `<img fileid="${fileId}" />`
    );

    // 3) 处理"紧邻 <img> 前的装饰 ☺"：小米会在 <img fileid="..."> 前多写一个 ☺，
    //    <img> 已经是合法图片标签，☺ 纯属残留装饰，直接删。
    html = html.replace(MI_PLACEHOLDER_BEFORE_IMG_RE, "");

    // 4) 再处理裸占位符：按未消费的顺序分配 fileId
    if (MI_IMG_PLACEHOLDER_CHARS.test(html)) {
      let cursor = 0;
      html = html.replace(MI_PLACEHOLDER_BARE_RE, () => {
        while (cursor < imgFileIds.length && usedIndices.has(cursor)) cursor++;
        const fid = imgFileIds[cursor];
        if (fid) {
          usedIndices.add(cursor);
          cursor++;
          return `<img fileid="${fid}" />`;
        }
        return "";
      });
    }
  }

  // 归一化小米笔记图片短格式：`{fileId}<段落索引/>` → `<img fileid="{fileId}" />`
  // 只在图片短格式前后没有构成其他属性值（如 `="abc<0/>"`) 时替换。
  // 这种短格式常见于"无标题、只有图片"的笔记，正文里直接裸写 fileId+位置标签。
  html = html.replace(MI_SHORT_IMG_RE, (_m, fileId: string) => {
    // 排除明显不是 fileId 的情况：纯数字很短、或包含空格
    if (!/[A-Za-z]/.test(fileId) && fileId.length < 10) return _m;
    return `<img fileid="${fileId}" />`;
  });

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

  // 孤儿段落索引兜底：如果前面的 `fileId<N/>` / `☺<N/>` 规则都没匹配中（比如
  // content 里 fileId 先被识别为 <img>、剩下一个裸 `<0/>` 悬浮在后面），
  // 统一清掉，避免正文出现 `<0/>` 裸文本。
  html = html.replace(MI_ORPHAN_INDEX_RE, "");

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
    .replace(/<img\b[^>]*>/gi, "")
    .replace(MI_SHORT_IMG_RE, "")
    // 小米 ☺ 占位符也要清掉，否则 contentText 里会看到一串笑脸或 "☺ fileId" 这种乱码
    .replace(MI_PLACEHOLDER_WITH_INDEX_RE, "")
    .replace(MI_PLACEHOLDER_WITH_INLINE_ID_RE, "")
    .replace(MI_PLACEHOLDER_BARE_RE, "")
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

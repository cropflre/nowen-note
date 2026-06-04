import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import crypto from "crypto";
import { getDb } from "../db/schema";
import { createDeduplicatedAttachmentRow, ensureAttachmentsDir, MIME_TO_EXT } from "./attachments";
import { deleteAttachmentObject, writeAttachmentObject } from "../services/attachment-storage";

const app = new Hono();

interface UrlImportRequest {
  url: string;
  notebookId?: string;
}

// ---------- 微信文章解析（轻量正则；不引第三方 DOM 依赖） ----------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function extractWeixinTitle(html: string): string {
  const m = html.match(/<h[12][^>]*id=["']activity-name["'][^>]*>([\s\S]*?)<\/h[12]>/i);
  if (m && m[1]) return stripTags(m[1]) || "未命名文章";
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1]) return stripTags(t[1]) || "未命名文章";
  return "未命名文章";
}

function extractWeixinAuthor(html: string): string | undefined {
  const m = html.match(/<a[^>]*id=["']js_name["'][^>]*>([\s\S]*?)<\/a>/i);
  if (m && m[1]) {
    const v = stripTags(m[1]);
    return v || undefined;
  }
  return undefined;
}

function extractWeixinPublishDate(html: string): string | undefined {
  // 新版微信：<em id="publish_time">；老版本：var ct = "1700000000"
  const m = html.match(/<em[^>]*id=["']publish_time["'][^>]*>([\s\S]*?)<\/em>/i);
  if (m && m[1]) {
    const v = stripTags(m[1]);
    if (v) return v;
  }
  const ct = html.match(/var\s+ct\s*=\s*["'](\d+)["']/);
  if (ct && ct[1]) {
    const sec = parseInt(ct[1], 10);
    if (!isNaN(sec)) return new Date(sec * 1000).toISOString().slice(0, 10);
  }
  return undefined;
}

/**
 * 抽取正文 div#js_content。
 * 微信正文嵌套很深，简单的 /<div id="js_content">(.*?)<\/div>/ 会在第一个内层 </div>
 * 处截断，必须做"匹配深度"的扫描。
 */
function extractWeixinContent(html: string): string {
  const startRe = /<div[^>]*id=["']js_content["'][^>]*>/i;
  const startMatch = startRe.exec(html);
  if (!startMatch) return "";
  const startIdx = startMatch.index + startMatch[0].length;

  // 从 startIdx 开始，按 <div> / </div> 配对，找到与 js_content 对应的关闭标签
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = startIdx;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0][1] === "/") {
      depth--;
      if (depth === 0) {
        return html.slice(startIdx, m.index);
      }
    } else {
      depth++;
    }
  }
  // 没找到闭合，兜底返回剩余
  return html.slice(startIdx);
}

// ---------- 图片下载到附件库 ----------

ensureAttachmentsDir();

const EXT_BY_BUFFER_MAGIC: Array<[RegExp, string, string]> = [
  // [前缀魔数（hex）, mime, ext]
  [/^ffd8ff/i, "image/jpeg", "jpg"],
  [/^89504e47/i, "image/png", "png"],
  [/^47494638/i, "image/gif", "gif"],
  [/^52494646.{8}57454250/i, "image/webp", "webp"],
];

function detectMimeFromBuffer(buf: Buffer, fallbackMime?: string): { mime: string; ext: string } {
  const head = buf.slice(0, 12).toString("hex");
  for (const [re, mime, ext] of EXT_BY_BUFFER_MAGIC) {
    if (re.test(head)) return { mime, ext };
  }
  if (fallbackMime) {
    const m = fallbackMime.toLowerCase().split(";")[0].trim();
    const ext = MIME_TO_EXT[m];
    if (ext) return { mime: m, ext };
  }
  return { mime: "image/jpeg", ext: "jpg" };
}

/**
 * 真正下载图片并落到 attachments 目录 & DB。
 * 复用 attachments.ts 的"按内容 hash 去重"思路，命中已有附件则直接复用。
 * 失败抛出，由调用方决定是否回退到原 URL。
 */
// 微信"此图片来自微信公众平台 未经允许不可引用"占位图的内容 hash 黑名单。
// 命中则视作下载失败，避免把占位图当真实图存进附件库。
// 列表会随微信侧调整，新发现的 hash 直接追加即可。
const WEIXIN_PLACEHOLDER_HASHES = new Set<string>([
  // 中文版 470x349 占位图（最常见）
  // 实际遇到新占位图时把 console.warn 里看到的 hash 加进来
]);

async function downloadImageToAttachment(
  imageUrl: string,
  userId: string,
  noteId: string,
  workspaceId: string | null,
): Promise<string> {
  const res = await fetch(imageUrl, {
    headers: {
      Referer: "https://mp.weixin.qq.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arr = await res.arrayBuffer();
  const buf = Buffer.from(arr);
  if (buf.length === 0) throw new Error("空图片");

  const { mime, ext } = detectMimeFromBuffer(buf, res.headers.get("content-type") || undefined);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");

  // 反盗链占位图识别：命中已知占位图 hash 直接抛错；
  // 同时对 <2KB 且尺寸明显异常（content-length 极小）的也保留怀疑——
  // 这里用纯 hash 黑名单更稳妥，避免误杀真实小图标。
  if (WEIXIN_PLACEHOLDER_HASHES.has(hash)) {
    throw new Error("命中微信反盗链占位图");
  }

  const db = getDb();
  // 同 user + 同 workspace + 同 hash 命中则复用物理文件，但为当前 note 复制新元数据行。
  const dedup = db
    .prepare(
      workspaceId
        ? `SELECT id, path, filename, mimeType, size, hash FROM attachments WHERE userId = ? AND workspaceId = ? AND hash = ? LIMIT 1`
        : `SELECT id, path, filename, mimeType, size, hash FROM attachments WHERE userId = ? AND workspaceId IS NULL AND hash = ? LIMIT 1`,
    )
    .get(...(workspaceId ? [userId, workspaceId, hash] : [userId, hash])) as
    | { id: string; path: string; filename?: string; mimeType: string; size: number; hash?: string | null }
    | undefined;

  if (dedup) {
    const clone = createDeduplicatedAttachmentRow({
      source: dedup,
      noteId,
      userId,
      workspaceId,
      filename: dedup.filename || `${uuid()}.${ext}`,
      hash,
    });
    return clone.url;
  }

  const id = uuid();
  const filename = `${id}.${ext}`;
  await writeAttachmentObject(filename, buf, mime);

  try {
    db.prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, noteId, userId, filename, mime, buf.length, filename, workspaceId, hash);
  } catch (err) {
    // DB 失败回滚磁盘
    try { await deleteAttachmentObject(filename); } catch { /* ignore */ }
    throw err;
  }

  return `/api/attachments/${id}`;
}

/**
 * 替换正文 HTML 里的微信图片 URL：
 *   <img data-src="https://mmbiz.qpic.cn/..." ...> →
 *   <img src="/api/attachments/<id>" ...>
 * 同时清掉懒加载相关的 data-* 属性，避免编辑器加载时还触发懒加载脚本。
 */
async function rewriteImages(
  html: string,
  userId: string,
  noteId: string,
  workspaceId: string | null,
): Promise<{ html: string; downloaded: number; failed: number }> {
  const imgRe = /<img\b[^>]*>/gi;
  const tags = html.match(imgRe) || [];
  // 收集 (原标签, 远端URL) 二元组并去重 URL
  const urlMap = new Map<string, string>(); // remoteUrl -> localUrl
  const tasks: Array<{ tag: string; url: string }> = [];

  for (const tag of tags) {
    // 微信图片真实地址有多个候选属性，按优先级取：
    //   data-src（懒加载主流写法）→ data-original-src（少数模板）→ src（兜底）
    const dataSrc = /data-src=["']([^"']+)["']/i.exec(tag);
    const dataOrig = /data-original-src=["']([^"']+)["']/i.exec(tag);
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag);
    let url =
      (dataSrc && dataSrc[1]) ||
      (dataOrig && dataOrig[1]) ||
      (src && src[1]);
    if (!url) continue;
    // // 协议相对路径补全为 https，否则 fetch 会报错
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//i.test(url)) continue; // 跳过 data: 等
    tasks.push({ tag, url });
    urlMap.set(url, ""); // 占位
  }

  let downloaded = 0;
  let failed = 0;

  // 并发上限 4，避免对 mmbiz 打太猛
  const remoteUrls = Array.from(urlMap.keys());
  const concurrency = 4;
  for (let i = 0; i < remoteUrls.length; i += concurrency) {
    const batch = remoteUrls.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (u) => {
        try {
          const local = await downloadImageToAttachment(u, userId, noteId, workspaceId);
          urlMap.set(u, local);
          downloaded++;
        } catch (e) {
          urlMap.set(u, u); // 失败保留原 URL
          failed++;
          console.warn("[url-import] 图片下载失败", u, e);
        }
      }),
    );
  }

  // 重新拼回 HTML：逐个替换原标签
  let out = html;
  for (const { tag, url } of tasks) {
    const local = urlMap.get(url) || url;
    const isLocal = local.startsWith("/api/attachments/");
    // 移除 data-src，把 src 设为本地附件
    let newTag = tag
      .replace(/\sdata-src=["'][^"']*["']/gi, "")
      .replace(/\sdata-original-src=["'][^"']*["']/gi, "")
      .replace(/\sdata-w=["'][^"']*["']/gi, "")
      .replace(/\sdata-type=["'][^"']*["']/gi, "");
    if (/\bsrc=["']/i.test(newTag)) {
      newTag = newTag.replace(/\bsrc=["'][^"']*["']/i, `src="${local}"`);
    } else {
      newTag = newTag.replace(/^<img\b/i, `<img src="${local}"`);
    }
    // 下载失败回退到原 mmbiz URL 时，加 referrerpolicy="no-referrer"
    // 让浏览器请求该图时不带 Referer——mmbiz 反盗链对"无 Referer"是放行的，
    // 反而比"带不对的 Referer"更容易拿到真实图片。
    if (!isLocal && !/\breferrerpolicy=/i.test(newTag)) {
      newTag = newTag.replace(/^<img\b/i, `<img referrerpolicy="no-referrer"`);
    }
    out = out.replace(tag, newTag);
  }

  return { html: out, downloaded, failed };
}

// ---------- 主路由 ----------

app.post("/", async (c) => {
  const { url, notebookId } = (await c.req.json()) as UrlImportRequest;
  if (!url || typeof url !== "string") {
    return c.json({ error: "请输入URL" }, 400);
  }
  if (!/^https:\/\/mp\.weixin\.qq\.com\/s[\/?]/.test(url)) {
    return c.json({ error: "目前仅支持微信公众号文章链接（mp.weixin.qq.com/s/...）" }, 400);
  }

  const userId = c.req.header("X-User-Id")!;
  const workspaceId = c.req.query("workspaceId") || null;

  let html: string;
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    if (!resp.ok) {
      return c.json({ error: `获取文章失败: HTTP ${resp.status}` }, 502);
    }
    html = await resp.text();
  } catch (err: any) {
    return c.json({ error: `网络错误: ${err?.message || err}` }, 502);
  }

  if (!/id=["']js_content["']/.test(html)) {
    // 文章已删除 / 需登录验证 / 反爬中间页
    if (/环境异常|访问过于频繁|该内容已被发布者删除/.test(html)) {
      return c.json({ error: "文章无法访问（可能已被删除或触发风控）" }, 400);
    }
    return c.json({ error: "未识别为有效的微信公众号文章" }, 400);
  }

  const title = extractWeixinTitle(html);
  const author = extractWeixinAuthor(html);
  const publishDate = extractWeixinPublishDate(html);
  const rawContent = extractWeixinContent(html);
  if (!rawContent.trim()) {
    return c.json({ error: "无法提取文章正文" }, 400);
  }

  // 先生成 noteId，用于关联附件
  const noteId = uuid();

  const db = getDb();

  // 确定目标笔记本：未指定 → "导入的文章"
  let targetNotebookId = notebookId;
  if (!targetNotebookId) {
    const exist = db
      .prepare("SELECT id FROM notebooks WHERE userId = ? AND name = ?")
      .get(userId, "导入的文章") as { id: string } | undefined;
    if (exist) {
      targetNotebookId = exist.id;
    } else {
      targetNotebookId = uuid();
      db.prepare("INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, ?, ?)")
        .run(targetNotebookId, userId, "导入的文章", "📄");
    }
  }

  const now = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

  // 先插一条占位的 notes 行——attachments 表对 noteId 有外键约束指向 notes(id)，
  // 必须先有 note 才能插 attachment，否则 FOREIGN KEY constraint failed。
  // content 先用空串占位，下面下载图片完成后再 UPDATE 回真正内容。
  try {
    db.prepare(
      `INSERT INTO notes (id, userId, notebookId, title, content, contentText, createdAt, updatedAt, workspaceId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(noteId, userId, targetNotebookId, title, "", "", now, now, workspaceId);
  } catch (err: any) {
    return c.json({ error: `写入笔记失败: ${err?.message || err}` }, 500);
  }

  // 下载图片并改写 HTML（此刻 notes 行已存在，attachments 外键能通过）
  const { html: bodyHtml, downloaded, failed } = await rewriteImages(
    rawContent,
    userId,
    noteId,
    workspaceId,
  );

  // 顶部加一个来源信息块；底部不动（保留原文样式）
  const meta = [
    author ? `作者：${author}` : "",
    publishDate ? `发布：${publishDate}` : "",
    `来源：<a href="${url}" target="_blank" rel="noopener">${url}</a>`,
  ]
    .filter(Boolean)
    .join(" · ");
  const finalHtml = `<blockquote><p>${meta}</p></blockquote>${bodyHtml}`;
  const contentText = stripTags(bodyHtml).slice(0, 2000);

  // 把图片改写后的真正 HTML 写回 notes
  try {
    db.prepare(
      `UPDATE notes SET content = ?, contentText = ?, updatedAt = ? WHERE id = ?`,
    ).run(finalHtml, contentText, now, noteId);
  } catch (err: any) {
    return c.json({ error: `更新笔记内容失败: ${err?.message || err}` }, 500);
  }

  return c.json(
    {
      success: true,
      noteId,
      title,
      author,
      publishDate,
      notebookId: targetNotebookId,
      images: { downloaded, failed },
    },
    201,
  );
});

export default app;

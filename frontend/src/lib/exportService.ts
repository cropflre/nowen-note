import JSZip from "jszip";
import { saveAs } from "file-saver";
import TurndownService from "turndown";
import i18n from "i18next";
import { generateHTML } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { common, createLowlight } from "lowlight";
import { api, resolveAttachmentUrl } from "./api";

// TipTap 扩展列表（需与 importService / 编辑器保持一致，否则某些节点会被吞掉）
const lowlight = createLowlight(common);
const tiptapExtensions = [
  StarterKit.configure({
    codeBlock: false,
    heading: { levels: [1, 2, 3] },
  }),
  Image.configure({ inline: false, allowBase64: true }),
  CodeBlockLowlight.configure({ lowlight }),
  Underline,
  Highlight.configure({ multicolor: true }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
];

/**
 * 把 note.content 规范化为 HTML。
 * - Tiptap JSON：用 generateHTML 渲染，确保 <pre><code class="language-xxx"> 结构被 turndown
 *   识别为 fenced code block（否则代码块内的 # 注释再次导入会被当成 Markdown 标题）。
 * - 已经是 HTML：原样返回。
 * - 纯文本或解析失败：回退到 contentText / content。
 */
function noteContentToHtml(rawContent: string, contentText: string): string {
  const src = rawContent || "";
  if (!src) return contentText || "";

  const trimmed = src.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(src);
      // 仅当看起来是 Tiptap doc 时才走 generateHTML
      if (parsed && typeof parsed === "object" && (parsed.type === "doc" || Array.isArray(parsed.content))) {
        return generateHTML(parsed, tiptapExtensions);
      }
    } catch {
      /* fallthrough */
    }
    return contentText || "";
  }
  return src;
}

interface ExportNote {
  id: string;
  title: string;
  content: string;
  contentText: string;
  /** 后端返回的 notebookId（按笔记本导出过滤用），旧后端可能缺失 → 置可选 */
  notebookId?: string | null;
  notebookName: string | null;
  createdAt: string;
  updatedAt: string;
}

// 清理文件名中的非法字符
function sanitizeFilename(name: string): string {
  return name.replace(/[\/\\?<>:*|"]/g, "_").replace(/\s+/g, " ").trim() || i18n.t('common.untitledNote');
}

// ============================================================================
// 图片抽取：把 HTML 里的 data: 内联图片拆成独立文件，替换为相对路径 ./assets/xxx
// 用于 zip 导出，生成可被 Typora / Obsidian / VSCode 正常预览的 Markdown
// ============================================================================

// MIME -> 扩展名
const MIME_EXT_MAP: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  // P1-1：扩展非图常见 MIME，用于把笔记里的 <a href="/api/attachments/<id>">
  // 真实文件名扩展名兜底。仍然是"已知就用 MIME，未知就走 URL 后缀"。
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-rar-compressed": "rar",
  "application/x-7z-compressed": "7z",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
};

function mimeToExt(mime: string): string {
  return MIME_EXT_MAP[mime.toLowerCase()] || "bin";
}

/** 浏览器端 SHA-1 摘要，返回十六进制字符串（只用前 N 位作文件名） */
async function sha1Hex(input: string): Promise<string> {
  // 为减少计算量，只取 base64 的前 2KB 作散列材料（已足够区分不同图片）
  const material = input.length > 2048 ? input.slice(0, 2048) + ":" + input.length : input;
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 解析 HTML 中所有 <img src="data:image/...;base64,...">：
 * - 抽出 base64 payload，按 SHA-1 前 10 位去重命名；
 * - 把 src 就地替换成 `./assets/<hash>.<ext>`；
 * - 收集 (相对路径 -> base64) 映射供外部写入 zip。
 *
 * 返回替换后的 HTML 以及图片清单。若 html 里没有 data:image，则不修改。
 * 对外链 http(s) 图片保持原样，不下载。
 */
export interface ExtractedImage {
  /** zip 内的相对路径，例如 "assets/abc123.png" */
  relPath: string;
  /** base64 字符串（不含 data: 前缀） */
  base64: string;
}

/**
 * 单条图片下载/内嵌失败记录（P0-2）。
 *
 * 用于在 zip 根目录写 `export-warnings.json`，让用户能看到具体是哪些笔记的
 * 哪些图失败了（之前只有"失败 N 张"的汇总，无法定位）。
 */
export interface ImgFailure {
  /** 原始 src（多半是 /api/attachments/<id> 或绝对 url） */
  src: string;
  /** 所属笔记 id；若调用方未传则为空 */
  noteId?: string;
  /** 所属笔记标题；用于在 warnings.json 里给人读 */
  noteTitle?: string;
  /** 失败原因（HTTP 状态码 / 空响应 / 网络错误 ...） */
  error: string;
  /** 失败发生在哪个阶段：download = fetchRemoteImages；inline = inlineRemoteImages */
  phase: "download" | "inline";
}

/**
 * 图片下载统计 + 失败明细。
 * fetchRemoteImages / inlineRemoteImages 都会往里写，最终由调用方汇总到 zip。
 */
export interface ImgStats {
  ok: number;
  failed: number;
  failures: ImgFailure[];
}

async function extractDataImages(
  html: string,
  registry: Map<string, string> // 全局 hash -> relPath，用于跨笔记去重
): Promise<{ html: string; images: ExtractedImage[] }> {
  // 仅在包含 data:image 时才进入解析分支，避免无谓开销
  if (!html || !/src=["']data:image\//i.test(html)) {
    return { html, images: [] };
  }

  const images: ExtractedImage[] = [];
  // 匹配 <img ... src="data:image/xxx;base64,YYY" ...>
  // 注意 src 可能是双引号或单引号
  const imgRe = /<img\b([^>]*?)\bsrc\s*=\s*(["'])data:(image\/[a-zA-Z0-9.+-]+);base64,([^"']+)\2([^>]*)>/gi;

  const replacements: Array<{ match: string; replacement: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const fullMatch = m[0];
    const beforeSrc = m[1] || "";
    const quote = m[2];
    const mime = m[3];
    const base64 = m[4];
    const afterSrc = m[5] || "";

    let relPath: string;
    try {
      const hash = (await sha1Hex(base64)).slice(0, 10);
      const ext = mimeToExt(mime);
      // 同一图片在多个笔记 / 多处出现时复用同一个文件名
      const cached = registry.get(hash);
      if (cached) {
        relPath = cached;
      } else {
        relPath = `assets/${hash}.${ext}`;
        registry.set(hash, relPath);
        images.push({ relPath, base64 });
      }
    } catch {
      // 散列失败时跳过，保持原 data URI
      continue;
    }

    const newSrc = `./${relPath}`;
    const rebuilt = `<img${beforeSrc} src=${quote}${newSrc}${quote}${afterSrc}>`;
    replacements.push({ match: fullMatch, replacement: rebuilt });
  }

  // 统一做一次替换。因为不同 <img> 可能有完全相同的 src（data URI 一致），
  // 直接用 String.replace(match, replacement) 也 OK，但走一个索引替换更稳。
  let out = html;
  for (const { match, replacement } of replacements) {
    // 只替换第一次出现：重复 data URI 会产生重复 match 条目，逐个替换能一一对应
    const idx = out.indexOf(match);
    if (idx >= 0) {
      out = out.slice(0, idx) + replacement + out.slice(idx + match.length);
    }
  }

  return { html: out, images };
}

// ============================================================================
// 远程图片抓取：把 HTML 里指向**本站后端**的 <img src> 下载下来打进 zip。
//
// 背景：
//   - 编辑器里的图片**不是** data URI，而是 /api/attachments/<uuid>
//     （见 backend/src/routes/attachments.ts 顶部注释）。
//   - 所以 extractDataImages 抓不到任何东西，导出的 md 里只剩外链，zip 里
//     自然就没有图片文件。这是用户反馈"图片没导出来"的根因。
//
// 设计：
//   - 只处理**认得出是本站附件**的 URL：相对路径 /api/attachments/...
//     以及绝对 URL 中包含 /api/attachments/ 的形式。其他外链（真正的
//     https://someone.com/x.png）保持原样不下载——那不是我们的数据，
//     下载还可能因为 CORS 失败，甚至泄漏 referer，得不偿失。
//   - 通过 resolveAttachmentUrl 把相对路径补全到后端 origin，兼容
//     Capacitor / 自定义 serverUrl 等部署。
//   - 复用 extractDataImages 的 registry（hash->relPath）做跨图片去重，
//     同一个附件 id 在多处出现只下载一次。
//   - 失败（404 / 网络异常 / 空响应）时吞掉错误，保留原 src，并在 console
//     打一行警告；最终在 progress 里汇总几张失败。不让一张坏图打断整个
//     导出流程。
// ============================================================================

/** 通过 MIME 判断扩展名；未知 MIME 从 URL 尾部 .ext 兜底。 */
function detectExtFromResponse(mime: string, url: string): string {
  const fromMime = MIME_EXT_MAP[mime.toLowerCase().split(";")[0].trim()];
  if (fromMime) return fromMime;
  const m = /\.([a-zA-Z0-9]{1,5})(?:\?|#|$)/.exec(url);
  if (m) return m[1].toLowerCase();
  return "bin";
}

/** 判断一个 URL 是否指向本站附件接口 —— 只下载自家的数据 */
function isAttachmentUrl(src: string): boolean {
  // 相对路径：/api/attachments/xxx 或 api/attachments/xxx
  if (/^\/?api\/attachments\//i.test(src)) return true;
  // 绝对 URL：路径里有 /api/attachments/
  if (/^https?:\/\/[^/]+\/api\/attachments\//i.test(src)) return true;
  return false;
}

/**
 * 把绝对/相对 URL 规范化为相对路径 `/api/attachments/<id>`。
 * 用于 fetchRemoteImages 下载失败的兜底：剥掉随时会失效的 host:port，让
 * 写到 zip 里的 src 至少在"相对路径"形态——即便后续这个 attachment id 在
 * 新实例里查不到，也不会因为带了死 host 而连尝试都失败。
 */
function normalizeAttachmentSrc(src: string): string {
  const m = /\/api\/attachments\/[^"'?#]+/i.exec(src);
  return m ? m[0] : src;
}

/**
 * 下载 html 里所有本站附件图片，替换 src 为 zip 内相对路径。
 *
 * 为什么用 ArrayBuffer + FileReader 转 base64：
 *   - JSZip.file 接受 { base64: true } 时期望纯 base64 字符串；我们用和
 *     extractDataImages 一致的格式，让写 zip 的代码路径统一。
 *   - 也可以直接传 Uint8Array（JSZip 支持），但那样要在存储里区分两种负载，
 *     增加复杂度，不划算。
 */
async function fetchRemoteImages(
  html: string,
  registry: Map<string, string>,
  stats: ImgStats,
  noteContext?: { noteId?: string; noteTitle?: string },
): Promise<{ html: string; images: ExtractedImage[] }> {
  if (!html || !/<img\b[^>]*\bsrc=/i.test(html)) {
    return { html, images: [] };
  }

  const images: ExtractedImage[] = [];
  // 捕获 <img ... src="..."> 的 src（单双引号都兼容）
  const imgRe = /<img\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>/gi;

  type Task = {
    fullMatch: string;
    beforeSrc: string;
    quote: string;
    originalSrc: string;
    afterSrc: string;
  };
  const tasks: Task[] = [];
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const originalSrc = m[3];
    // 已处理过的 data:（上一步会把 data URI 替成 ./assets/...，不会走到这里）
    // 跳过纯 data: 避免二次处理；跳过 blob:（页面会话级资源，下载无意义）。
    if (/^(data:|blob:)/i.test(originalSrc)) continue;
    // 跳过已经指向 zip 内相对 assets 的（上一步产物）
    if (/^\.\/?assets\//i.test(originalSrc)) continue;
    // 只处理本站附件，其他外链保持原样
    if (!isAttachmentUrl(originalSrc)) continue;

    tasks.push({
      fullMatch: m[0],
      beforeSrc: m[1] || "",
      quote: m[2],
      originalSrc,
      afterSrc: m[4] || "",
    });
  }

  if (tasks.length === 0) return { html, images: [] };

  // 并发下载（限流 6 —— 和浏览器单 host 默认并发差不多，不给自家后端压力）
  const results: Array<{ task: Task; rebuilt: string } | null> = new Array(tasks.length).fill(null);
  const concurrency = 6;
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const myIdx = cursor++;
      const task = tasks[myIdx];
      try {
        const absUrl = resolveAttachmentUrl(task.originalSrc);
        const res = await fetch(absUrl, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const mime = res.headers.get("content-type") || "application/octet-stream";
        const buf = await res.arrayBuffer();
        if (buf.byteLength === 0) throw new Error("empty body");
        // ArrayBuffer -> base64
        // 注意：大图直接 String.fromCharCode(...new Uint8Array(buf)) 会爆栈，
        // 分块拼接更稳。
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(
            null,
            bytes.subarray(i, i + chunk) as unknown as number[]
          );
        }
        const base64 = btoa(binary);

        // 以附件 id（URL 尾段）+ mime 做 key 去重；没法拿到 id 时退化为 sha1
        const idMatch = /\/api\/attachments\/([^/?#]+)/i.exec(task.originalSrc);
        const key = idMatch ? `att-${idMatch[1]}` : await sha1Hex(base64).then((h) => h.slice(0, 10));
        let relPath = registry.get(key);
        if (!relPath) {
          const ext = detectExtFromResponse(mime, task.originalSrc);
          relPath = `assets/${key}.${ext}`;
          registry.set(key, relPath);
          images.push({ relPath, base64 });
        }

        const newSrc = `./${relPath}`;
        const rebuilt = `<img${task.beforeSrc} src=${task.quote}${newSrc}${task.quote}${task.afterSrc}>`;
        results[myIdx] = { task, rebuilt };
        stats.ok++;
      } catch (err) {
        console.warn(
          `[exportService] failed to download image for zip: ${task.originalSrc}`,
          err
        );
        stats.failed++;
        // P0-2：记一条详细失败信息，在 zip 根输出 export-warnings.json
        stats.failures.push({
          src: task.originalSrc,
          noteId: noteContext?.noteId,
          noteTitle: noteContext?.noteTitle,
          error: err instanceof Error ? err.message : String(err),
          phase: "download",
        });
        // 下载失败时，至少把 src 规范化为相对路径 `/api/attachments/<id>`，
        // 剥掉随启动而变的 host:port —— 不要把 `http://localhost:3173/...`
        // 这种死链原样写进 zip，否则二次导入时前端会把它当成"外链"完全跳过，
        // 导致新数据库里那张图永远 404。
        const normalized = normalizeAttachmentSrc(task.originalSrc);
        if (normalized !== task.originalSrc) {
          const rebuilt = `<img${task.beforeSrc} src=${task.quote}${normalized}${task.quote}${task.afterSrc}>`;
          results[myIdx] = { task, rebuilt };
        }
        // 否则保持原样（results[myIdx] 仍为 null，不替换）
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  );

  // 统一替换：按原 full match 索引替换，避免同 src 的多 <img> 错位
  let out = html;
  for (const r of results) {
    if (!r) continue;
    const idx = out.indexOf(r.task.fullMatch);
    if (idx >= 0) {
      out = out.slice(0, idx) + r.rebuilt + out.slice(idx + r.task.fullMatch.length);
    }
  }
  return { html: out, images };
}

// ============================================================================

// ============================================================================
// 远程图片"内嵌为 data URI"：与 fetchRemoteImages 类似，但**不**写入 zip 的
// assets/ 目录，而是把图片字节直接编码成 data:image/...;base64,... 替回 src。
//
// 用途：
//   - 用户勾选 "导出时把图片内嵌为 base64" 时使用。
//   - 这是"导出 → 重新导入"链路最稳的方案：
//       * 导入端的 markdown→html 渲染器对 data: 开头的 src 直接放行（importService
//         的 resolveImageSrc 也会跳过不动），所以 base64 能完整进入 Tiptap JSON；
//       * 后端 /api/export/import 收到带 data:image 的 content 后，会调用
//         extractInlineBase64Images 把它落盘并替换为 /api/attachments/<新id>。
//     全程不依赖"旧 attachment id 在新数据库里依然存在"，从根上避免
//     "图片加载失败 http://localhost:<旧端口>/api/attachments/<旧id>" 的 404。
//   - 失败兜底：与 fetchRemoteImages 相同 —— 把死链规范化为相对路径，避免污染。
// ============================================================================
async function inlineRemoteImages(
  html: string,
  stats: ImgStats,
  noteContext?: { noteId?: string; noteTitle?: string },
): Promise<string> {
  if (!html || !/<img\b[^>]*\bsrc=/i.test(html)) return html;

  const imgRe = /<img\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>/gi;
  type Task = {
    fullMatch: string;
    beforeSrc: string;
    quote: string;
    originalSrc: string;
    afterSrc: string;
  };
  const tasks: Task[] = [];
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const originalSrc = m[3];
    // 已是 data:/blob: 或 zip 内 assets 路径不再处理
    if (/^(data:|blob:)/i.test(originalSrc)) continue;
    if (/^\.\/?assets\//i.test(originalSrc)) continue;
    if (!isAttachmentUrl(originalSrc)) continue;
    tasks.push({
      fullMatch: m[0],
      beforeSrc: m[1] || "",
      quote: m[2],
      originalSrc,
      afterSrc: m[4] || "",
    });
  }
  if (tasks.length === 0) return html;

  // 同 attachment id 在多处复用同一个 base64 串，避免重复下载和重复编码
  const cache = new Map<string, string>();
  const results: Array<{ task: Task; rebuilt: string } | null> = new Array(tasks.length).fill(null);
  const concurrency = 6;
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const myIdx = cursor++;
      const task = tasks[myIdx];
      const idMatch = /\/api\/attachments\/([^/?#]+)/i.exec(task.originalSrc);
      const cacheKey = idMatch ? `att-${idMatch[1]}` : task.originalSrc;
      try {
        let dataUri = cache.get(cacheKey);
        if (!dataUri) {
          const absUrl = resolveAttachmentUrl(task.originalSrc);
          const res = await fetch(absUrl, { credentials: "include" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const mime = (res.headers.get("content-type") || "application/octet-stream")
            .split(";")[0]
            .trim();
          const buf = await res.arrayBuffer();
          if (buf.byteLength === 0) throw new Error("empty body");
          // ArrayBuffer -> base64（分块避免栈溢出）
          const bytes = new Uint8Array(buf);
          let binary = "";
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(
              null,
              bytes.subarray(i, i + chunk) as unknown as number[]
            );
          }
          const base64 = btoa(binary);
          // 后端 ALLOWED_IMAGE_MIMES 不接受未知 mime；统一兜底为 image/png 风险更低，
          // 但这里既然刚刚下载成功就大概率是图片，相信 Content-Type
          const safeMime = /^image\//i.test(mime) ? mime : "image/png";
          dataUri = `data:${safeMime};base64,${base64}`;
          cache.set(cacheKey, dataUri);
        }
        const rebuilt = `<img${task.beforeSrc} src=${task.quote}${dataUri}${task.quote}${task.afterSrc}>`;
        results[myIdx] = { task, rebuilt };
        stats.ok++;
      } catch (err) {
        console.warn(
          `[exportService] failed to inline image: ${task.originalSrc}`,
          err
        );
        stats.failed++;
        // P0-2：同 fetchRemoteImages，记一条失败信息
        stats.failures.push({
          src: task.originalSrc,
          noteId: noteContext?.noteId,
          noteTitle: noteContext?.noteTitle,
          error: err instanceof Error ? err.message : String(err),
          phase: "inline",
        });
        // 兜底：规范化为相对路径，避免死 host:port 写进导出物
        const normalized = normalizeAttachmentSrc(task.originalSrc);
        if (normalized !== task.originalSrc) {
          const rebuilt = `<img${task.beforeSrc} src=${task.quote}${normalized}${task.quote}${task.afterSrc}>`;
          results[myIdx] = { task, rebuilt };
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  );

  let out = html;
  for (const r of results) {
    if (!r) continue;
    const idx = out.indexOf(r.task.fullMatch);
    if (idx >= 0) {
      out = out.slice(0, idx) + r.rebuilt + out.slice(idx + r.task.fullMatch.length);
    }
  }
  return out;
}

// ============================================================================

// ============================================================================
// 非图附件下载（P1-1）
// ----------------------------------------------------------------------------
// 与 fetchRemoteImages 配对：扫描 html 中的 <a href="/api/attachments/<id>">，
// 下载到 zip 的 assets/ 目录，并把 href 替换为相对路径 ./assets/xxx.<ext>。
//
// 设计要点：
//   - **只处理本站附件链接**（与 fetchRemoteImages 同款 isAttachmentUrl 判定），
//     外链 / mailto / 锚点 / blob: 一律不动；
//   - **不内嵌为 base64**：PDF / 视频动辄几十 MB，base64 会让 .md 爆炸，且 Markdown
//     的链接语法不允许 data URI 内嵌成文件名，反而打不开；
//   - 与图片共用同一个 `registry`（按 attachment id 做 key），同一附件被多处引用
//     时只下载一次；
//   - 失败兜底：与 fetchRemoteImages 一致——把 href 规范化为相对 /api/attachments/<id>，
//     保留 zip 内的可读语义，避免死 host 写入；
//   - 仅在导出 zip 时使用；单笔记 PDF / 图片导出不调用（那些场景图片够用）。
//
// 注意：
//   导入端目前不会自动把这些附件重建回 attachments 表（导入仍以 markdown→html 为
//   主，<a href="./assets/xxx.pdf"> 会保留为相对链接，但点击后浏览器会去访问宿主
//   文件系统而不是 attachments 接口）。这是 P1-1 的"导出半边"实现，闭环要等导入侧
//   改造。即便如此，用户已经能在 zip 里看到原始附件文件，满足"备份完整性"诉求。
// ============================================================================
async function fetchRemoteAttachments(
  html: string,
  registry: Map<string, string>,
  stats: ImgStats,
  noteContext?: { noteId?: string; noteTitle?: string },
): Promise<{ html: string; assets: ExtractedImage[] }> {
  if (!html || !/<a\b[^>]*\bhref=/i.test(html)) {
    return { html, assets: [] };
  }

  const assets: ExtractedImage[] = [];
  // 抓 <a ... href="..." ...>，捕获 (前缀, 引号, href, 后缀)；不闭合标签也无所谓
  const aRe = /<a\b([^>]*?)\bhref\s*=\s*(["'])([^"']+)\2([^>]*)>/gi;

  type Task = {
    fullMatch: string;
    beforeHref: string;
    quote: string;
    originalHref: string;
    afterHref: string;
  };
  const tasks: Task[] = [];
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html)) !== null) {
    const originalHref = m[3];
    if (/^(data:|blob:|mailto:|tel:|#)/i.test(originalHref)) continue;
    if (/^\.\/?assets\//i.test(originalHref)) continue;
    if (!isAttachmentUrl(originalHref)) continue;
    tasks.push({
      fullMatch: m[0],
      beforeHref: m[1] || "",
      quote: m[2],
      originalHref,
      afterHref: m[4] || "",
    });
  }
  if (tasks.length === 0) return { html, assets: [] };

  const results: Array<{ task: Task; rebuilt: string } | null> = new Array(tasks.length).fill(null);
  const concurrency = 4; // 非图附件常见更大，并发收敛一档
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const myIdx = cursor++;
      const task = tasks[myIdx];
      try {
        const absUrl = resolveAttachmentUrl(task.originalHref);
        const res = await fetch(absUrl, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // 大附件用 ArrayBuffer 收 + 分块 base64，避免 String.fromCharCode 爆栈
        const buf = await res.arrayBuffer();
        if (buf.byteLength === 0) throw new Error("empty body");
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(
            null,
            bytes.subarray(i, i + chunk) as unknown as number[],
          );
        }
        const base64 = btoa(binary);

        const mime = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
        // 文件名优先：从 Content-Disposition 抓；否则用 attachment id 兜底
        const cd = res.headers.get("content-disposition") || "";
        let fname: string | null = null;
        // 兼容 RFC 5987 (filename*=UTF-8'') 与传统 filename="x"
        const cdStar = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(cd);
        if (cdStar) {
          try { fname = decodeURIComponent(cdStar[1].trim().replace(/^\"|\"$/g, "")); } catch { /* ignore */ }
        }
        if (!fname) {
          const cdPlain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
          if (cdPlain) fname = cdPlain[1].trim();
        }

        const idMatch = /\/api\/attachments\/([^/?#]+)/i.exec(task.originalHref);
        const key = idMatch ? `att-${idMatch[1]}` : await sha1Hex(base64).then((h) => h.slice(0, 10));
        let relPath = registry.get(key);
        if (!relPath) {
          // 文件名清洗：从 Content-Disposition 拿到的也可能有非法字符
          const safeFname = fname ? sanitizeFilename(fname) : "";
          if (safeFname) {
            relPath = `assets/${safeFname}`;
          } else {
            const ext = detectExtFromResponse(mime, task.originalHref);
            relPath = `assets/${key}.${ext}`;
          }
          // 与图片同 registry：避免一个文件既被 <img> 又被 <a> 引用时重写两次
          registry.set(key, relPath);
          assets.push({ relPath, base64 });
        }

        const newHref = `./${relPath}`;
        const rebuilt = `<a${task.beforeHref} href=${task.quote}${newHref}${task.quote}${task.afterHref}>`;
        results[myIdx] = { task, rebuilt };
        stats.ok++;
      } catch (err) {
        console.warn(
          `[exportService] failed to download attachment for zip: ${task.originalHref}`,
          err,
        );
        stats.failed++;
        stats.failures.push({
          src: task.originalHref,
          noteId: noteContext?.noteId,
          noteTitle: noteContext?.noteTitle,
          error: err instanceof Error ? err.message : String(err),
          phase: "download",
        });
        // 兜底：把死 host 剥成相对路径
        const normalized = normalizeAttachmentSrc(task.originalHref);
        if (normalized !== task.originalHref) {
          const rebuilt = `<a${task.beforeHref} href=${task.quote}${normalized}${task.quote}${task.afterHref}>`;
          results[myIdx] = { task, rebuilt };
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
  );

  let out = html;
  for (const r of results) {
    if (!r) continue;
    const idx = out.indexOf(r.task.fullMatch);
    if (idx >= 0) {
      out = out.slice(0, idx) + r.rebuilt + out.slice(idx + r.task.fullMatch.length);
    }
  }
  return { html: out, assets };
}

// ============================================================================
// Turndown 服务工厂：HTML → Markdown 转换器（被多个导出路径复用）
// ============================================================================
function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  // ---- 自定义转义：只保留"会真正改变结构"的转义，避免 `JWT_SECRET` 变成
  // `JWT\_SECRET`、`a*b` 变成 `a\*b` 这种丑陋且对用户有迷惑性的反斜杠。
  //
  // Turndown 默认 escape 会无差别给 `_*[]()<>` 等字符前面加 `\`，目的是防止
  // 行内文本被再次解析为 markdown 语法。但代价是：变量名、路径、shell 命令
  // 全部被加了一堆反斜杠 —— 对本编辑器场景（往返到 Tiptap）非常碍眼，且
  // 在第三方 markdown 编辑器里看到也会产生"为什么有 \"的疑惑。
  //
  // 这里采用更窄的策略：只转义"出现在行首会被识别为块级语法"的字符
  //   - 行首数字+`.`/`)`：会被当成有序列表
  //   - 行首 `-` / `+` / `*`：会被当成无序列表
  //   - 行首 `#`：会被当成标题
  //   - 行首 `>`：会被当成引用
  // 行内的 `_` / `*` / `~` 等一律保留原字符。这对 round-trip 安全性的让步
  // 是可接受的：Tiptap 用户内容里 99% 的下划线和星号都是字面字符。
  // 反引号 ` 仍需在行内转义，因为它会立即开启 inline code。
  (td as unknown as { escape: (str: string) => string }).escape = (str: string) => {
    if (!str) return str;
    return str
      // 反引号：行内 code 起止符，必须转义
      .replace(/`/g, "\\`")
      // 行首的有序列表标记：1. / 1)
      .replace(/^(\s{0,3})(\d+)([.)])(\s)/gm, "$1$2\\$3$4")
      // 行首的无序列表标记：- + *（注意星号即便行首也常常是字面意义，
      // 但若不转义会被解析为列表，这里仍转义；用空格区分以保证只匹配真正的行首项）
      .replace(/^(\s{0,3})([-+*])(\s)/gm, "$1\\$2$3")
      // 行首 #：标题
      .replace(/^(\s{0,3})(#{1,6})(\s)/gm, "$1\\$2$3")
      // 行首 >：引用
      .replace(/^(\s{0,3})>/gm, "$1\\>");
  };

  // 自定义 task list 转换
  td.addRule("taskListItem", {
    filter: (node) => {
      return (
        node.nodeName === "LI" &&
        node.getAttribute("data-type") === "taskItem"
      );
    },
    replacement: (content, node) => {
      const checked = (node as Element).getAttribute("data-checked") === "true";
      const cleanContent = content.replace(/^\n+/, "").replace(/\n+$/, "");
      return `${checked ? "- [x]" : "- [ ]"} ${cleanContent}\n`;
    },
  });

  // 高亮文本
  td.addRule("highlight", {
    filter: "mark",
    replacement: (content) => `==${content}==`,
  });

  return td;
}

/**
 * Markdown 输出后处理：把多余的连续空行折叠为"至多 1 个空行"。
 *
 * 背景：Tiptap 用 `<p></p>` 表示用户在两段之间多按的回车，Turndown 会把每个
 * 块元素之间塞进 `\n\n`，于是 `<p>a</p><p></p><p>b</p>` 会输出 `a\n\n\n\nb`
 * —— 在 markdown 渲染里就是 2 个空行；导入回 Tiptap 后再次产生 `<p></p>`
 * 空段，往返几次空行越来越多。
 *
 * 本函数把 3 个及以上连续 `\n` 折叠成 2 个 `\n`（=1 个空行），保证段落间
 * 始终是稳定的"恰好 1 个空行"，让"导出 → 导入"格式幂等。
 *
 * 注意：fenced code block (```...```) 内部不应折叠，否则会破坏代码空行；
 * 这里用 split-by-fence 的方式只对围栏外的部分做替换。
 */
function postProcessMarkdown(md: string): string {
  if (!md) return md;
  // 用 ``` 行作为分隔，奇数下标段（在围栏内部）原样保留
  const parts = md.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/gm);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue; // 围栏代码块原样保留
    // 折叠 3+ 个换行为 2 个；同时去掉行尾多余空格
    parts[i] = parts[i].replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  }
  return parts.join("");
}

export type ExportProgress = {
  phase: "fetching" | "converting" | "packing" | "done" | "error";
  current: number;
  total: number;
  message: string;
};

export async function exportAllNotes(
  onProgress?: (p: ExportProgress) => void,
  options?: {
    /**
     * 图片处理策略：
     * - false（默认）：把 <img src="data:..."> 抽成独立文件放到 `<笔记本>/assets/`，
     *                  md 里用相对路径 `./assets/xxx.png`，生成的 zip 在 Typora/Obsidian
     *                  等编辑器里可直接预览，md 文件体积小、可读性好。
     * - true：保留图片 base64 内嵌（单文件自包含，但 md 巨大、长行）。
     */
    inlineImages?: boolean;
    /**
     * 显式指定导出范围。
     * - undefined → 走 api 默认（即当前激活工作区）
     * - "personal" → 仅个人空间
     * - <workspaceId> → 仅该工作区
     * 用于 DataManager 把"个人空间 / 工作区"拆成独立 Tab：每个 Tab 都
     * 应该按它自己的 scope 导出，不依赖侧边栏当前选中的 workspace。
     */
    workspaceId?: string;
  }
): Promise<boolean> {
  const inlineImages = !!options?.inlineImages;
  try {
    // 1. 获取所有笔记
    onProgress?.({ phase: "fetching", current: 0, total: 0, message: i18n.t('export.fetchingData') });
    const notes = await api.getExportNotes(options?.workspaceId) as ExportNote[];

    if (!notes || notes.length === 0) {
      onProgress?.({ phase: "error", current: 0, total: 0, message: i18n.t('export.noNotesToExport') });
      return false;
    }

    const total = notes.length;
    const zip = new JSZip();
    const td = createTurndown();

    // 2. 转换并打包
    const folderCounts = new Map<string, number>();
    // 每个笔记本目录独立的 hash->相对路径 注册表，保证 md 中 ./assets/xxx 一定存在于同级目录
    const perFolderRegistry = new Map<string, Map<string, string>>();
    // 已写入 zip 的图片相对路径，避免重复写
    const writtenImages = new Set<string>();
    // 远程图片下载计数（成功 / 失败），最终给用户做个汇总
    // P0-2：同时收集失败明细（src + noteId + error），供 zip 根目录写出 export-warnings.json
    const imgStats: ImgStats = { ok: 0, failed: 0, failures: [] };

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      onProgress?.({ phase: "converting", current: i + 1, total, message: i18n.t('export.converting', { title: note.title }) });

      // 解析 content → HTML（Tiptap JSON 会被渲染成真正的 <pre><code>，避免代码块内 # 被误判为标题）
      let html = noteContentToHtml(note.content, note.contentText);

      // 先定下该笔记的所在笔记本目录（图片抽取需要按目录注册）
      const folder = note.notebookName ? sanitizeFilename(note.notebookName) : i18n.t('export.uncategorized');

      // —— 图片抽取：默认把 data:image 拆到 <folder>/assets/ ——
      let extractedImages: ExtractedImage[] = [];
      if (!inlineImages && html) {
        let registry = perFolderRegistry.get(folder);
        if (!registry) {
          registry = new Map();
          perFolderRegistry.set(folder, registry);
        }
        const r = await extractDataImages(html, registry);
        html = r.html;
        extractedImages = r.images;

        // 再把指向 /api/attachments/<id> 的图片下载下来并替换 src
        const r2 = await fetchRemoteImages(html, registry, imgStats, { noteId: note.id, noteTitle: note.title });
        html = r2.html;
        extractedImages = extractedImages.concat(r2.images);

        // P1-1：同步拉取本笔记中的非图附件（PDF / docx / 音视频等）
        // 复用同一个 registry 与 imgStats：与图片共享去重与失败明细。
        const r3 = await fetchRemoteAttachments(html, registry, imgStats, { noteId: note.id, noteTitle: note.title });
        html = r3.html;
        extractedImages = extractedImages.concat(r3.assets);
      } else if (inlineImages && html) {
        // inline 模式：把 /api/attachments/<id> 全部抓回来内嵌成 data URI，
        // 让重新导入时后端 extractInlineBase64Images 自动重建附件，避免
        // 旧 attachment id 在新数据库找不到导致的 404。
        html = await inlineRemoteImages(html, imgStats, { noteId: note.id, noteTitle: note.title });
      }

      // 转换为 Markdown
      const markdown = html ? postProcessMarkdown(td.turndown(html)) : "";

      // 添加 YAML frontmatter
      const frontmatter = [
        "---",
        `title: "${note.title.replace(/"/g, '\\"')}"`,
        `created: ${note.createdAt}`,
        `updated: ${note.updatedAt}`,
        "---",
        "",
      ].join("\n");

      const fullContent = frontmatter + markdown;

      // 确定文件路径（folder 在抽图前已计算）
      const count = folderCounts.get(folder) || 0;
      folderCounts.set(folder, count + 1);

      let fileName = sanitizeFilename(note.title);
      // 避免同名文件冲突
      const testPath = `${folder}/${fileName}.md`;
      if (zip.file(testPath)) {
        fileName = `${fileName}_${count + 1}`;
      }

      zip.file(`${folder}/${fileName}.md`, fullContent);

      // 把本笔记抽出的图片写入 zip（同一 hash 在同目录只写一次）
      for (const img of extractedImages) {
        const fullPath = `${folder}/${img.relPath}`;
        if (writtenImages.has(fullPath)) continue;
        writtenImages.add(fullPath);
        zip.file(fullPath, img.base64, { base64: true });
      }
    }

    // 3. 添加元数据
    zip.file(
      "metadata.json",
      JSON.stringify({
        version: "1.0",
        app: "nowen-note",
        exportedAt: new Date().toISOString(),
        totalNotes: total,
        notebooks: Array.from(folderCounts.entries()).map(([name, count]) => ({ name, count })),
        // P0-2：汇总在 metadata 里，快速看总体；明细看 export-warnings.json
        imageStats: { ok: imgStats.ok, failed: imgStats.failed },
      }, null, 2)
    );

    // 3.1 如果有图片处理失败，写明细信息到 export-warnings.json，让用户能看到
    // “哪些笔记的哪些图”失败了，而不是只看到一个“失败 N 张”的总数。
    if (imgStats.failures.length > 0) {
      zip.file(
        "export-warnings.json",
        JSON.stringify({
          version: "1.0",
          app: "nowen-note",
          generatedAt: new Date().toISOString(),
          summary: { ok: imgStats.ok, failed: imgStats.failed },
          failures: imgStats.failures,
          hint: "请检查：原始附件是否仍在（/api/attachments/<id>）、网络是否可用。导入到其它实例时可能出现这些图加载失败。",
        }, null, 2)
      );
    }

    // 4. 生成 ZIP
    onProgress?.({ phase: "packing", current: total, total, message: i18n.t('export.generatingZip') });
    const blob = await zip.generateAsync(
      {
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      },
      (meta) => {
        onProgress?.({
          phase: "packing",
          current: Math.round(meta.percent),
          total: 100,
          message: i18n.t('export.compressing', { percent: Math.round(meta.percent) }),
        });
      }
    );

    // 5. 触发下载
    const date = new Date().toISOString().slice(0, 10);
    saveAs(blob, `nowen-note_backup_${date}.zip`);

    // 若有图片下载失败，给用户一个非阻塞警告（done 前多 emit 一条 error 消息）
    if (imgStats.failed > 0) {
      onProgress?.({
        phase: "error",
        current: imgStats.failed,
        total: imgStats.ok + imgStats.failed,
        message: i18n.t('export.someImagesFailed', { count: imgStats.failed }),
      });
    }
    onProgress?.({ phase: "done", current: total, total, message: i18n.t('export.exportComplete') });
    return true;
  } catch (error) {
    console.error("导出失败:", error);
    onProgress?.({ phase: "error", current: 0, total: 0, message: i18n.t('export.exportFailed', { error: (error as Error).message }) });
    return false;
  }
}

// ============================================================================
// 按笔记本导出：把指定笔记本（及其所有子孙笔记本）下的全部笔记打包为一个 zip。
//
// 设计要点：
// - 复用 exportAllNotes 的核心转换逻辑（Tiptap JSON → HTML → Markdown，图片抽取到
//   assets/ 目录），保证和全量导出产物一致的体验。
// - 目前后端 /export/notes 返回的是当前工作区全量笔记；这里在前端按 notebookId
//   过滤。大体量场景（几万条笔记）可能偏慢，但覆盖了绝大多数普通用户。
// - 子孙笔记本：通过 `descendantNotebookIds` 传入（调用方从 notebook 树 BFS 收集），
//   这样笔记本可以形成完整树结构导出（root.zip 内含多个子目录 per notebook name）。
// - 单个笔记本的根文件夹不再重复一层："root 笔记本名/root 笔记本名/xxx.md" 没意义，
//   直接让 zip 根就是那个笔记本名 —— 所以仍按"每个笔记本的 notebookName"做 folder，
//   zip 文件名用 `<root 笔记本名>.zip`。
// ============================================================================
export async function exportNotebook(
  params: {
    /** 根笔记本 id（用户右键的那一个） */
    notebookId: string;
    /** 根笔记本名（用于 zip 文件名 + 兜底展示） */
    notebookName: string;
    /** 根笔记本 + 所有子孙笔记本的 id 集合（由调用方计算好传入） */
    descendantNotebookIds: Set<string>;
    /**
     * 降级用：根笔记本 + 所有子孙笔记本的"名称"集合。
     * 仅在后端 /export/notes 返回的行里不含 notebookId 字段时才会启用
     * （例如前端已升级但后端仍是旧镜像）。按名称过滤存在跨父目录同名冲突的风险，
     * 所以只作兜底。
     */
    descendantNotebookNames?: Set<string>;
  },
  onProgress?: (p: ExportProgress) => void,
  options?: { inlineImages?: boolean }
): Promise<boolean> {
  const { notebookId, notebookName, descendantNotebookIds, descendantNotebookNames } = params;
  const inlineImages = !!options?.inlineImages;
  try {
    onProgress?.({ phase: "fetching", current: 0, total: 0, message: i18n.t('export.fetchingData') });
    const allNotes = await api.getExportNotes() as ExportNote[];

    // 过滤：优先按 notebookId 精确匹配；若后端不返回 notebookId（旧版本兼容），
    // 再降级按 notebookName 过滤并在 console 留痕以便排查。
    const hasId = (allNotes || []).some((n) => n && typeof n === "object" && !!(n as any).notebookId);
    let notes: ExportNote[];
    if (hasId) {
      notes = (allNotes || []).filter(
        (n) => n && typeof n === "object" && !!n.notebookId && descendantNotebookIds.has(n.notebookId)
      );
    } else {
      console.warn(
        "[exportNotebook] backend /export/notes missing notebookId; fallback to notebookName filter " +
          "(may be inaccurate if duplicate names exist across parents). Upgrade backend to fix."
      );
      const nameSet = descendantNotebookNames || new Set<string>([notebookName]);
      notes = (allNotes || []).filter(
        (n) => n && typeof n === "object" && n.notebookName != null && nameSet.has(n.notebookName)
      );
    }

    if (notes.length === 0) {
      onProgress?.({ phase: "error", current: 0, total: 0, message: i18n.t('export.noNotesToExport') });
      return false;
    }

    const total = notes.length;
    const zip = new JSZip();
    const td = createTurndown();
    const folderCounts = new Map<string, number>();
    const perFolderRegistry = new Map<string, Map<string, string>>();
    const writtenImages = new Set<string>();
    // P0-2：与全量导出一致，收集失败明细供写 export-warnings.json
    const imgStats: ImgStats = { ok: 0, failed: 0, failures: [] };

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      onProgress?.({ phase: "converting", current: i + 1, total, message: i18n.t('export.converting', { title: note.title }) });

      let html = noteContentToHtml(note.content, note.contentText);
      const folder = note.notebookName ? sanitizeFilename(note.notebookName) : sanitizeFilename(notebookName);

      let extractedImages: ExtractedImage[] = [];
      if (!inlineImages && html) {
        let registry = perFolderRegistry.get(folder);
        if (!registry) {
          registry = new Map();
          perFolderRegistry.set(folder, registry);
        }
        const r = await extractDataImages(html, registry);
        html = r.html;
        extractedImages = r.images;

        const r2 = await fetchRemoteImages(html, registry, imgStats, { noteId: note.id, noteTitle: note.title });
        html = r2.html;
        extractedImages = extractedImages.concat(r2.images);

        // P1-1：同步拉取本笔记中的非图附件（PDF / docx / 音视频等）
        // 复用同一个 registry 与 imgStats：与图片共享去重与失败明细。
        const r3 = await fetchRemoteAttachments(html, registry, imgStats, { noteId: note.id, noteTitle: note.title });
        html = r3.html;
        extractedImages = extractedImages.concat(r3.assets);
      } else if (inlineImages && html) {
        // inline 模式：把 /api/attachments/<id> 全部抓回来内嵌成 data URI，
        // 见 inlineRemoteImages 注释。
        html = await inlineRemoteImages(html, imgStats, { noteId: note.id, noteTitle: note.title });
      }

      const markdown = html ? postProcessMarkdown(td.turndown(html)) : "";
      const frontmatter = [
        "---",
        `title: "${note.title.replace(/"/g, '\\"')}"`,
        `created: ${note.createdAt}`,
        `updated: ${note.updatedAt}`,
        "---",
        "",
      ].join("\n");
      const fullContent = frontmatter + markdown;

      const count = folderCounts.get(folder) || 0;
      folderCounts.set(folder, count + 1);
      let fileName = sanitizeFilename(note.title);
      const testPath = `${folder}/${fileName}.md`;
      if (zip.file(testPath)) {
        fileName = `${fileName}_${count + 1}`;
      }
      zip.file(`${folder}/${fileName}.md`, fullContent);

      for (const img of extractedImages) {
        const fullPath = `${folder}/${img.relPath}`;
        if (writtenImages.has(fullPath)) continue;
        writtenImages.add(fullPath);
        zip.file(fullPath, img.base64, { base64: true });
      }
    }

    // 元数据：记录这次导出的根笔记本信息，便于二次导入校验
    zip.file(
      "metadata.json",
      JSON.stringify({
        version: "1.0",
        app: "nowen-note",
        exportedAt: new Date().toISOString(),
        scope: "notebook",
        rootNotebookId: notebookId,
        rootNotebookName: notebookName,
        totalNotes: total,
        notebooks: Array.from(folderCounts.entries()).map(([name, count]) => ({ name, count })),
        imageStats: { ok: imgStats.ok, failed: imgStats.failed },
      }, null, 2)
    );

    // P0-2：附上图片处理失败明细（与全量导出一致）
    if (imgStats.failures.length > 0) {
      zip.file(
        "export-warnings.json",
        JSON.stringify({
          version: "1.0",
          app: "nowen-note",
          generatedAt: new Date().toISOString(),
          scope: "notebook",
          rootNotebookId: notebookId,
          rootNotebookName: notebookName,
          summary: { ok: imgStats.ok, failed: imgStats.failed },
          failures: imgStats.failures,
          hint: "请检查：原始附件是否仍在（/api/attachments/<id>）、网络是否可用。导入到其它实例时可能出现这些图加载失败。",
        }, null, 2)
      );
    }

    onProgress?.({ phase: "packing", current: total, total, message: i18n.t('export.generatingZip') });
    const blob = await zip.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
      (meta) => {
        onProgress?.({
          phase: "packing",
          current: Math.round(meta.percent),
          total: 100,
          message: i18n.t('export.compressing', { percent: Math.round(meta.percent) }),
        });
      }
    );

    const date = new Date().toISOString().slice(0, 10);
    const safeRoot = sanitizeFilename(notebookName);
    saveAs(blob, `${safeRoot}_${date}.zip`);
    if (imgStats.failed > 0) {
      onProgress?.({
        phase: "error",
        current: imgStats.failed,
        total: imgStats.ok + imgStats.failed,
        message: i18n.t('export.someImagesFailed', { count: imgStats.failed }),
      });
    }
    onProgress?.({ phase: "done", current: total, total, message: i18n.t('export.exportComplete') });
    return true;
  } catch (error) {
    console.error("导出笔记本失败:", error);
    onProgress?.({ phase: "error", current: 0, total: 0, message: i18n.t('export.exportFailed', { error: (error as Error).message }) });
    return false;
  }
}

// 单篇导出：
// - 若笔记含 data:image 内嵌图，默认打成 zip（md + assets/）；
// - 否则仅下载 .md；
// - 通过 options.inlineImages = true 可强制内嵌（始终下载 .md）。
export async function exportSingleNote(
  noteId: string,
  options?: { inlineImages?: boolean }
): Promise<boolean> {
  const inlineImages = !!options?.inlineImages;
  try {
    const note = await api.getNote(noteId);
    const td = createTurndown();

    // 解析 content → HTML（Tiptap JSON 会被渲染成真正的 <pre><code>）
    let html = noteContentToHtml(note.content, note.contentText);

    // 抽图（仅在非 inline 且含 data:image 时）
    const registry = new Map<string, string>();
    let extractedImages: ExtractedImage[] = [];
    if (!inlineImages && html) {
      const r = await extractDataImages(html, registry);
      html = r.html;
      extractedImages = r.images;

      // 同样把 /api/attachments/<id> 的图片一起拉下来
      const stats: ImgStats = { ok: 0, failed: 0, failures: [] };
      const r2 = await fetchRemoteImages(html, registry, stats, { noteId: note.id, noteTitle: note.title });
      html = r2.html;
      extractedImages = extractedImages.concat(r2.images);
      if (stats.failed > 0) {
        console.warn(`[exportSingleNote] ${stats.failed} image(s) failed to download; keeping original <img src>.`);
      }
    } else if (inlineImages && html) {
      // inline 模式：把附件内嵌成 data URI，让二次导入时后端自动重建附件
      const stats: ImgStats = { ok: 0, failed: 0, failures: [] };
      html = await inlineRemoteImages(html, stats, { noteId: note.id, noteTitle: note.title });
      if (stats.failed > 0) {
        console.warn(`[exportSingleNote] ${stats.failed} image(s) failed to inline; src normalized to relative path.`);
      }
    }

    const markdown = html ? postProcessMarkdown(td.turndown(html)) : "";

    const frontmatter = [
      "---",
      `title: "${note.title.replace(/"/g, '\\"')}"`,
      `created: ${note.createdAt}`,
      `updated: ${note.updatedAt}`,
      "---",
      "",
    ].join("\n");

    const fullContent = frontmatter + markdown;
    const safeTitle = sanitizeFilename(note.title);

    if (extractedImages.length > 0) {
      // 打成 zip：根目录放 md + assets/
      const zip = new JSZip();
      zip.file(`${safeTitle}.md`, fullContent);
      for (const img of extractedImages) {
        zip.file(img.relPath, img.base64, { base64: true });
      }
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      saveAs(blob, `${safeTitle}.zip`);
    } else {
      const blob = new Blob([fullContent], { type: "text/markdown;charset=utf-8" });
      saveAs(blob, `${safeTitle}.md`);
    }
    return true;
  } catch (error) {
    console.error("导出失败:", error);
    return false;
  }
}

// ============================================================================
// 单篇导出：PDF / 图片
//
// 思路：
// - 复用 noteContentToHtml + inlineRemoteImages，把笔记渲染为自包含 HTML（图片
//   全部 data URI 化，避免新窗口/canvas 跨域受限）。
// - 把 HTML 注入一份独立的 styled 文档（含基础排版样式：标题、段落、代码块、
//   表格、任务列表），让导出的产物看起来"像样"，而不是 raw HTML。
// - PDF：在新窗口里打开该文档并调用 window.print()，由用户系统打印对话框
//   "另存为 PDF"。这是零依赖跨平台最稳的方案。
// - 图片：把同一份 HTML 包进 SVG <foreignObject>，draw 到 canvas 后导出 PNG。
//   要求：所有 <img> 必须是 data: 或 same-origin（已通过 inlineRemoteImages 满足）。
// ============================================================================

// 公共：把笔记渲染为带样式的完整 HTML 文档字符串
async function buildPrintableHtml(note: {
  title: string;
  content: string;
  contentText: string;
  createdAt: string;
  updatedAt: string;
}): Promise<string> {
  let html = noteContentToHtml(note.content, note.contentText);
  // 把 /api/attachments/<id> 全部 inline 成 data URI（避免新窗口加载失败、canvas tainted）
  const stats: ImgStats = { ok: 0, failed: 0, failures: [] };
  html = await inlineRemoteImages(html, stats);

  const safeTitle = (note.title || i18n.t('common.untitledNote'))
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const created = new Date(note.createdAt).toLocaleString();
  const updated = new Date(note.updatedAt).toLocaleString();

  // 内嵌一份基础排版样式：保证打印/截图独立于 app 主题
  const css = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #ffffff; color: #1f2328; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
      font-size: 14px; line-height: 1.7; }
    .page { max-width: 760px; margin: 0 auto; padding: 48px 56px; }
    .title { font-size: 28px; font-weight: 700; line-height: 1.3; margin: 0 0 8px; color: #111; }
    .meta { font-size: 12px; color: #888; margin-bottom: 28px; }
    .content { word-wrap: break-word; overflow-wrap: break-word; }
    .content h1 { font-size: 24px; margin: 28px 0 12px; }
    .content h2 { font-size: 20px; margin: 24px 0 10px; }
    .content h3 { font-size: 17px; margin: 20px 0 8px; }
    .content p { margin: 8px 0; }
    .content a { color: #0969da; text-decoration: none; }
    .content code { background: #f6f8fa; padding: 2px 5px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 0.92em; }
    .content pre { background: #0d1117; color: #e6edf3; padding: 14px 16px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; line-height: 1.55; }
    .content pre code { background: transparent; color: inherit; padding: 0; border-radius: 0; font-size: inherit; }
    .content blockquote { border-left: 3px solid #d0d7de; color: #57606a; margin: 8px 0; padding: 4px 14px; background: #f6f8fa; border-radius: 4px; }
    .content img { max-width: 100%; height: auto; border-radius: 6px; }
    .content table { border-collapse: collapse; margin: 12px 0; width: 100%; }
    .content th, .content td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; }
    .content th { background: #f6f8fa; font-weight: 600; }
    .content ul, .content ol { padding-left: 1.4em; margin: 8px 0; }
    .content ul[data-type="taskList"] { list-style: none; padding-left: 0; }
    .content ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 8px; margin: 4px 0; }
    .content ul[data-type="taskList"] li > label { user-select: none; }
    .content ul[data-type="taskList"] li > div { flex: 1; }
    .content hr { border: 0; border-top: 1px solid #e1e4e8; margin: 20px 0; }
    .content mark { background: #fff3a3; padding: 0 2px; border-radius: 3px; }
    @media print {
      .page { padding: 24px 28px; max-width: 100%; }
      a { color: inherit; text-decoration: none; }
      pre, blockquote, table, img { page-break-inside: avoid; }
    }
  `;

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<style>${css}</style>
</head>
<body>
<div class="page">
  <h1 class="title">${safeTitle}</h1>
  <div class="meta">${i18n.t('export.metaCreated')}: ${created} · ${i18n.t('export.metaUpdated')}: ${updated}</div>
  <div class="content">${html || ""}</div>
</div>
</body>
</html>`;
}

/**
 * 把可打印 HTML 渲染到离屏 iframe，再用 html2canvas 截图 → jsPDF 按 A4 分页塞图，
 * 最终产出 PDF Blob。供纯浏览器 / Electron 降级路径使用。
 *
 * 注意：
 *  - html2canvas 和 jsPDF 使用**动态 import**，避免初始包体积因一个低频功能多 300KB+。
 *  - 所有图片都已在 buildPrintableHtml 里 inline 成 data URI，故 html2canvas 不会
 *    因跨域 taint 失败。
 *  - PDF 为 A4 纵向，按图像高度换算分页；每页之间的"图像偏移"通过 `addImage` 的负 y 实现。
 */
async function renderPrintableHtmlToPdfBlob(docHtml: string): Promise<Blob> {
  // 离屏 iframe 承载 HTML；宽度固定 800px，保证 html2canvas 截图后再按 A4 缩放时分辨率足够。
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.left = "-99999px";
  iframe.style.top = "0";
  iframe.style.width = "820px";
  iframe.style.height = "100px";
  iframe.style.border = "0";
  iframe.setAttribute("aria-hidden", "true");
  document.body.appendChild(iframe);

  const cleanup = () => {
    try { document.body.removeChild(iframe); } catch { /* noop */ }
  };

  try {
    const doc = iframe.contentDocument;
    if (!doc) throw new Error("IFRAME_NO_DOCUMENT");
    doc.open();
    doc.write(docHtml);
    doc.close();

    // 等所有图片加载完成（data: 也是异步 decode）
    await new Promise<void>((resolve) => {
      const imgs = Array.from(doc.images);
      if (imgs.length === 0) { setTimeout(resolve, 50); return; }
      let pending = imgs.length;
      const done = () => { if (--pending <= 0) resolve(); };
      imgs.forEach((img) => {
        if (img.complete) done();
        else {
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
        }
      });
      // 兜底 5s
      setTimeout(resolve, 5000);
    });

    const page = doc.querySelector(".page") as HTMLElement | null;
    if (!page) throw new Error("PAGE_ELEMENT_NOT_FOUND");

    // 适配 iframe 高度，html2canvas 才会截到完整内容
    const fullHeight = Math.max(page.scrollHeight, page.offsetHeight, page.clientHeight);
    iframe.style.height = `${fullHeight + 40}px`;

    // 动态引入，降低首屏 JS 体积
    const [{ default: html2canvas }, jspdfMod] = await Promise.all([
      import("html2canvas"),
      import("jspdf"),
    ]);
    const jsPDF = jspdfMod.jsPDF;

    const canvas = await html2canvas(page, {
      backgroundColor: "#ffffff",
      scale: 2, // 2x DPI，兼顾清晰度与体积
      useCORS: true,
      logging: false,
      windowWidth: page.scrollWidth,
      windowHeight: fullHeight,
    });

    // A4: 210mm × 297mm
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const pageWidthMm = pdf.internal.pageSize.getWidth();   // 210
    const pageHeightMm = pdf.internal.pageSize.getHeight(); // 297
    // 左右各留 10mm 边距
    const marginMm = 10;
    const contentWidthMm = pageWidthMm - marginMm * 2;

    // canvas 宽度映射到 PDF 的 contentWidthMm；对应的 canvas 高度换算为 mm：
    const canvasWidthPx = canvas.width;
    const canvasHeightPx = canvas.height;
    const pxPerMm = canvasWidthPx / contentWidthMm;
    const imageHeightMm = canvasHeightPx / pxPerMm;

    // 上下各留 10mm 边距；每页可用内容高度
    const contentHeightMm = pageHeightMm - marginMm * 2;

    // 用单张大图分页：每页 addImage 时，y 偏移 = -(页序 * contentHeightMm)，
    // 并通过在整页范围之外让 jsPDF 裁剪。最简单稳妥的做法：
    // 把 canvas 按 contentHeightMm 切片，每页 drawImage 一段到新 canvas 再 addImage。
    const imgData = canvas.toDataURL("image/jpeg", 0.92);

    if (imageHeightMm <= contentHeightMm) {
      // 单页即可放下
      pdf.addImage(imgData, "JPEG", marginMm, marginMm, contentWidthMm, imageHeightMm);
    } else {
      // 多页：每页切一块 canvas
      const sliceHeightPx = Math.floor(contentHeightMm * pxPerMm);
      let offsetY = 0;
      let pageIndex = 0;
      while (offsetY < canvasHeightPx) {
        const thisSliceHeightPx = Math.min(sliceHeightPx, canvasHeightPx - offsetY);

        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = canvasWidthPx;
        sliceCanvas.height = thisSliceHeightPx;
        const ctx = sliceCanvas.getContext("2d");
        if (!ctx) throw new Error("SLICE_CANVAS_CTX_NULL");
        // 从原 canvas 拷贝对应区域
        ctx.drawImage(
          canvas,
          0, offsetY, canvasWidthPx, thisSliceHeightPx,
          0, 0, canvasWidthPx, thisSliceHeightPx
        );
        const sliceData = sliceCanvas.toDataURL("image/jpeg", 0.92);
        const sliceHeightMm = thisSliceHeightPx / pxPerMm;

        if (pageIndex > 0) pdf.addPage();
        pdf.addImage(sliceData, "JPEG", marginMm, marginMm, contentWidthMm, sliceHeightMm);

        offsetY += thisSliceHeightPx;
        pageIndex++;
      }
    }

    return pdf.output("blob");
  } finally {
    cleanup();
  }
}

/**
 * 单篇导出为 PDF。
 *
 * 优先级：
 *   1) Electron 桌面端：走 `window.nowenDesktop.exportNoteToPDF`，
 *      主进程用离屏 BrowserWindow + webContents.printToPDF **直接保存矢量 PDF**，
 *      用户只需选保存位置，不会弹系统打印对话框；中文/文字可选/体积小。
 *   2) 纯浏览器环境：用 html2canvas + jsPDF **直接生成 PDF 并触发下载**——
 *      把笔记渲染到离屏 iframe，截图后按 A4 分页塞进 PDF。文字为光栅图（不可选），
 *      但零系统依赖、不弹打印对话框，符合"直接下载 PDF"的体验。
 *
 * 返回值：
 *   { ok: true,  mode: 'desktop' }  — 桌面端已写入文件
 *   { ok: true,  mode: 'web'     }  — 浏览器端已触发 PDF 下载
 *   { ok: false, mode: 'canceled' } — 桌面端用户取消保存
 *   { ok: false, mode: 'error' }   — 失败
 */
export type ExportPdfResult =
  | { ok: true; mode: "desktop"; path?: string }
  | { ok: true; mode: "web" }
  | { ok: false; mode: "canceled" }
  | { ok: false; mode: "error"; error?: string };

export async function exportSingleNoteAsPDF(noteId: string): Promise<ExportPdfResult> {
  try {
    const note = await api.getNote(noteId);
    const docHtml = await buildPrintableHtml(note);

    // —— 优先：Electron 静默导出 ——
    const desktop = (window as unknown as {
      nowenDesktop?: {
        exportNoteToPDF?: (payload: { html: string; suggestedName?: string }) =>
          Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      };
    }).nowenDesktop;
    if (desktop && typeof desktop.exportNoteToPDF === "function") {
      const res = await desktop.exportNoteToPDF({
        html: docHtml,
        suggestedName: sanitizeFilename(note.title),
      });
      if (res?.canceled) return { ok: false, mode: "canceled" };
      if (res?.ok) return { ok: true, mode: "desktop", path: res.path };
      // 桌面端偶发失败 → 继续走 Web 生成路径，保证体验不中断
      console.warn("[exportSingleNoteAsPDF] desktop export failed, fallback to web:", res?.error);
    }

    // —— Web 直接下载 PDF ——
    const blob = await renderPrintableHtmlToPdfBlob(docHtml);
    const filename = `${sanitizeFilename(note.title) || "note"}.pdf`;
    saveAs(blob, filename);
    return { ok: true, mode: "web" };
  } catch (error) {
    console.error("导出 PDF 失败:", error);
    return { ok: false, mode: "error", error: String(error) };
  }
}

/**
 * 单篇导出为 PNG 图片：用 SVG <foreignObject> 把 HTML 渲染到 canvas。
 * - 不依赖第三方库；
 * - 所有图片需为 data: 或 same-origin（已被 inlineRemoteImages 处理）；
 * - 输出宽度固定为 800px（适合分享/截图），高度按内容自适应。
 */
export async function exportSingleNoteAsImage(noteId: string): Promise<boolean> {
  try {
    const note = await api.getNote(noteId);
    const docHtml = await buildPrintableHtml(note);

    // 1) 通过隐藏 iframe 渲染一遍，拿到真实高度
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-99999px";
    iframe.style.top = "0";
    iframe.style.width = "820px";
    iframe.style.height = "100px";
    iframe.style.border = "0";
    iframe.setAttribute("aria-hidden", "true");
    document.body.appendChild(iframe);

    const cleanup = () => {
      try { document.body.removeChild(iframe); } catch { /* noop */ }
    };

    const doc = iframe.contentDocument;
    if (!doc) {
      cleanup();
      return false;
    }
    doc.open();
    doc.write(docHtml);
    doc.close();

    // 等图片加载
    await new Promise<void>((resolve) => {
      const imgs = Array.from(doc.images);
      if (imgs.length === 0) { setTimeout(resolve, 50); return; }
      let pending = imgs.length;
      const done = () => { if (--pending <= 0) resolve(); };
      imgs.forEach((img) => {
        if (img.complete) done();
        else {
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
        }
      });
      // 兜底
      setTimeout(resolve, 4000);
    });

    const pageEl = doc.querySelector(".page") as HTMLElement | null;
    if (!pageEl) { cleanup(); return false; }

    // 读取真实尺寸
    const rect = pageEl.getBoundingClientRect();
    const width = Math.max(820, Math.ceil(rect.width));
    const height = Math.max(100, Math.ceil(pageEl.scrollHeight + 32));

    // 2) 序列化 page 节点为 SVG/foreignObject
    // 关键点：<foreignObject> 内部必须是合法 XML（XHTML），不能用 HTML5 的 outerHTML（
    // 会产出 <br>、<img ...> 这种自闭合不规范的字符串，导致 SVG 解析失败，img.onerror 立即触发）。
    // 所以用 XMLSerializer + 先把节点克隆到一份 XHTML 文档里，保证所有标签合规。
    const styleEl = doc.querySelector("style");
    const styleText = styleEl ? styleEl.textContent || "" : "";

    const XHTML_NS = "http://www.w3.org/1999/xhtml";
    // 创建一份 XHTML 文档作为序列化载体
    const xhtmlDoc = document.implementation.createDocument(XHTML_NS, "html", null);
    const xBody = xhtmlDoc.createElementNS(XHTML_NS, "body");
    xhtmlDoc.documentElement.appendChild(xBody);
    // 克隆 pageEl 到 xhtml 文档（importNode 会递归转命名空间）
    const importedPage = xhtmlDoc.importNode(pageEl, true) as Element;
    xBody.appendChild(importedPage);

    const serializer = new XMLSerializer();
    const pageXml = serializer.serializeToString(importedPage);

    // style 里的 CSS 可能含 <，要包在 CDATA 里避免 XML 解析报错
    const safeStyle = `<style xmlns="${XHTML_NS}"><![CDATA[${styleText}]]></style>`;

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
        `<foreignObject width="100%" height="100%">` +
          `<div xmlns="${XHTML_NS}" style="background:#ffffff;width:${width}px;">` +
            safeStyle +
            pageXml +
          `</div>` +
        `</foreignObject>` +
      `</svg>`;

    cleanup();

    // 3) 直接保存为 SVG 文件。
    // 历史教训：SVG <foreignObject> 绘制到 canvas 在 Chromium 下会把 canvas 标
    // 脏（出于保守策略，即便所有资源都是 data:），toBlob 抛 SecurityError。
    // 引入 html2canvas/dom-to-image 等库能解决，但会新增 ~200KB 依赖。
    // 当前方案：输出矢量 SVG（现代浏览器、看图软件、Office、设计工具均支持），
    // 用户可再自行转 PNG；同时文件小、可无损缩放。
    const svgBlob = new Blob(
      ['<?xml version="1.0" encoding="UTF-8"?>\n', svg],
      { type: "image/svg+xml;charset=utf-8" }
    );
    const safeTitle = sanitizeFilename(note.title);
    saveAs(svgBlob, `${safeTitle}.svg`);
    return true;
  } catch (error) {
    console.error("导出图片失败:", error);
    return false;
  }
}

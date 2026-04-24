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
  stats: { ok: number; failed: number }
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
        // results[myIdx] 保持 null —— 保留原 <img src>，不替换
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

// 初始化 Turndown (HTML → Markdown)
function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

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
  }
): Promise<boolean> {
  const inlineImages = !!options?.inlineImages;
  try {
    // 1. 获取所有笔记
    onProgress?.({ phase: "fetching", current: 0, total: 0, message: i18n.t('export.fetchingData') });
    const notes = await api.getExportNotes() as ExportNote[];

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
    const imgStats = { ok: 0, failed: 0 };

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
        const r2 = await fetchRemoteImages(html, registry, imgStats);
        html = r2.html;
        extractedImages = extractedImages.concat(r2.images);
      }

      // 转换为 Markdown
      const markdown = html ? td.turndown(html) : "";

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
      }, null, 2)
    );

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
    const imgStats = { ok: 0, failed: 0 };

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

        const r2 = await fetchRemoteImages(html, registry, imgStats);
        html = r2.html;
        extractedImages = extractedImages.concat(r2.images);
      }

      const markdown = html ? td.turndown(html) : "";
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
      }, null, 2)
    );

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
      const stats = { ok: 0, failed: 0 };
      const r2 = await fetchRemoteImages(html, registry, stats);
      html = r2.html;
      extractedImages = extractedImages.concat(r2.images);
      if (stats.failed > 0) {
        console.warn(`[exportSingleNote] ${stats.failed} image(s) failed to download; keeping original <img src>.`);
      }
    }

    const markdown = html ? td.turndown(html) : "";

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

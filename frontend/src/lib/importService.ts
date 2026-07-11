import { api } from "./api";
import { marked, Renderer } from "marked";
import i18n from "i18next";
import { Editor, generateJSON, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  TableWithSiyuanAttrs,
  TableCellWithAlign,
  TableHeaderWithAlign,
} from "@/components/extensions/TableFidelityExtensions";
import { TableRowWithHeight } from "@/components/extensions/TableRowResizable";
import TextAlign from "@tiptap/extension-text-align";
import { common, createLowlight } from "lowlight";
import { TextStyleKit } from "@/components/FontSizeExtension";
import { Video as VideoExtension } from "@/components/VideoExtension";
import { MathInline, MathBlock } from "@/components/MathExtensions";
import { FootnoteReference, FootnoteDefinition } from "@/components/FootnoteExtensions";

// BLOCK-ID-01-RV1: heading blockId 扩展（与 TiptapEditor / contentFormat 对齐）
// 只声明 attrs，不带 appendTransaction plugin
const BlockIdAttrs = Extension.create({
  name: "blockId",
  addGlobalAttributes() {
    return [{
      types: ["heading"],
      attributes: {
        blockId: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id") || null,
          renderHTML: (attributes: any) => {
            if (!attributes.blockId) return {};
            return { "data-block-id": attributes.blockId };
          },
        },
      },
    }];
  },
});

const lowlight = createLowlight(common);

// TipTap 扩展列表（与编辑器保持一致）
// 导出供 tiptapSchemaRepair.ts 复用，避免再复制一份 schema 定义
export const tiptapExtensions = [
  StarterKit.configure({
    codeBlock: false,
    heading: { levels: [1, 2, 3] },
  }),
  // BLOCK-LINKS-UI-01-RV3: 显式配置 Link 扩展，允许 note: 协议
  // 避免 repairTiptapJson round-trip 时丢失 note link
  Link.configure({
    openOnClick: false,
    autolink: true,
    linkOnPaste: true,
    protocols: ["http", "https", "mailto", "note"],
    HTMLAttributes: {
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    },
  }),
  // 与 TiptapEditor 保持一致：图片是 inline 节点，必须位于 paragraph/listItem
  // 等 inlineContent 容器内。否则 repairTiptapJson 会保留历史 doc > image 结构，
  // 主编辑器加载后任意 transaction 都会触发 contentMatchAt 崩溃。
  Image.configure({ inline: true, allowBase64: true }),
  CodeBlockLowlight.configure({ lowlight }),
  Underline,
  Highlight.configure({ multicolor: true }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableWithSiyuanAttrs.configure({ resizable: false }),
  TableRowWithHeight,
  TableHeaderWithAlign,
  TableCellWithAlign,
  // TextAlign：必须与 TiptapEditor 对齐，否则 repairTiptapJson round-trip
  // 时段落/标题的 textAlign 属性会被 schema 静默过滤掉，刷新后段落对齐丢失。
  TextAlign.configure({ types: ["heading", "paragraph"] }),
  // TextStyle + Color + FontSize：与编辑器保持一致，否则导入近来的
  // 带颜色/字号的 HTML 会被 generateJSON schema-filter 掉
  ...TextStyleKit,
  // 视频节点：与编辑器保持一致，否则导入/修复阶段 video 节点会被吃
  VideoExtension,
  // 数学公式（行内 / 块级）：必须与 TiptapEditor 对齐。
  // 缺这两个时，含 LaTeX 公式的笔记走 repairTiptapJson → generateHTML 会因
  // schema 不认识 mathInline / mathBlock 抛 RangeError，catch 兜底返回空 doc，
  // 表现为"刷新后整篇内容消失"。
  MathInline,
  MathBlock,
  // 脚注（引用 / 定义）：同 Math，含脚注节点的 doc 在 repair round-trip 时
  // 会因 schema 缺失导致 generateHTML 抛错，刷新后笔记内容被清空。
  FootnoteReference,
  FootnoteDefinition,
  // BLOCK-ID-01-RV1: heading blockId 属性，与 TiptapEditor / contentFormat 对齐
  // 避免 schema 修复时 blockId 被过滤掉
  BlockIdAttrs,
];

export interface ImportFileInfo {
  name: string;
  title: string;
  content: string;
  size: number;
  selected: boolean;
  source?: string; // 来源标识: "md" | "txt" | "html" | "xiaomi" | "oppo" | "vivo" | "oneplus" | "pdf" | "siyuan" | "siyuan-sy"
  notebookName?: string; // （已废弃，仅为向后兼容）从路径/目录推导出的单层笔记本名
  notebookPath?: string[]; // 笔记本层级路径（从根到子），如 ["我是文章2", "test2", "新笔记本"]
  imageMap?: Record<string, string>; // 相对路径 -> base64 data URI（zip 内的图片资源）
  contentFormat?: "tiptap-json" | "markdown" | "html";
  createdAt?: string;
  updatedAt?: string;
}

// 导入选项
export interface ImportOptions {
  /**
   * 是否"为每个文件创建以文件名命名的外层笔记本"
   * - true:  每个文件 → 建/找一个同名笔记本（清洗后的文件名）
   * - false: 保持原逻辑（zip 目录派生；散文件归到"导入的笔记"或用户选的笔记本）
   */
  perFileNotebook?: boolean;
  /**
   * 当 perFileNotebook=true 时，同名笔记本的处理策略
   * - "merge":  同名合并到同一笔记本（默认；依赖后端按名复用）
   * - "unique": 在本批次内自动编号 ("name", "name (2)", "name (3)"...)
   */
  duplicateStrategy?: "merge" | "unique";
  /** perFileNotebook 启用时，清洗后为空的回退名 */
  fallbackNotebookName?: string;
  /**
   * 显式指定导入目标 workspace。
   * - undefined → 走 api 默认（即当前激活工作区）
   * - "personal" → 落到个人空间（notes.workspaceId 写 NULL）
   * - <workspaceId> → 落到指定工作区
   * 与 exportAllNotes 的 workspaceId 选项配对：DataManager 拆分"个人空间 / 工作区"
   * Tab 后，每个 Tab 各自传 scope，避免依赖侧边栏当前选中的 workspace。
   */
  workspaceId?: string;
}

export type ImportProgress = {
  phase: "reading" | "uploading" | "done" | "error";
  current: number;
  total: number;
  message: string;
};

// 支持的文件扩展名
const SUPPORTED_EXTENSIONS = [".md", ".txt", ".markdown", ".html", ".htm", ".pdf"];

// PDF 单文件大小上限：50 MB
// 超过此值会直接抛出错误，避免浏览器内存爆掉或 pdfjs 解析超时。
export const MAX_PDF_SIZE = 50 * 1024 * 1024;

function isSupportedFile(name: string): boolean {
  return SUPPORTED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

function isPdfFile(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

/**
 * 用 pdfjs-dist 从 PDF 抽取文本层并组装成 HTML。
 *
 * 设计要点：
 * 1. 纯前端、按需懒加载，避免影响首屏体积；
 * 2. 仅依赖 PDF 的「文本层」(getTextContent)，不做 OCR——
 *    扫描件 PDF 没有文本层时返回空字符串，由调用方决定如何提示用户；
 * 3. 通过 y 坐标聚合同一行的 text item，再按段落空行切分，
 *    保证导入后每段独立成 <p>，而不是整篇挤成一坨；
 * 4. 不显式指定 workerSrc，使用 pdfjs 自带的 worker 入口；
 *    若运行环境拒绝创建 worker，会回退到主线程解析（pdfjs 内部已处理）。
 */
async function extractPdfToHtml(buffer: ArrayBuffer): Promise<string> {
  // 动态加载，避免与首屏耦合；这里用兼容版（legacy）以最大化浏览器/移动端兼容性
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // pdfjs v4 强制要求显式指定 workerSrc（不再支持空字符串/fake worker），
  // 否则会抛 'No "GlobalWorkerOptions.workerSrc" specified'。
  // 使用 Vite 的 `?url` 后缀 import：Vite 会在构建期将 worker 文件作为独立资源
  // 拷贝到 dist，并在开发期由 dev server 直接以正确的 MIME (module) 提供，
  // 比硬编码 CDN 更稳，也无需联网。
  if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
    // Vite 的 `?url` 后缀 import 由 vite/client 提供类型声明，TS 能正确推断
    const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // 关闭外部 cmap/standardFont 远程下载，离线/内网环境也能解析
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;

  const htmlParts: string[] = [];
  // 跟踪是否抽取到任何可见文本。
  //
  // 历史 bug：早先只用 `html.trim()` 判断 PDF 是否有文本层，
  // 但 `htmlParts` 在多页文档中会塞页分隔符 "<p></p>"——一份"扫描件 / 全图 PDF"
  // 跑下来 lineTexts 全空，htmlParts 却堆了 N-1 个 "<p></p>"，
  // `html.trim()` 不再为空，于是绕过 OCR 提示，建出一条**0 词 0 字符**的空笔记。
  // 这里独立用 hasAnyText 计数，保证只统计实际有内容的行。
  let hasAnyText = false;
  let extractedLineCount = 0;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // 把同一行的 item 按 y 坐标聚合（pdfjs 的 transform[5] 是 y）
    // 行间允许 ±2 像素的浮动误差
    type Line = { y: number; items: { x: number; str: string }[] };
    const lines: Line[] = [];

    for (const it of content.items as any[]) {
      const str: string = typeof it.str === "string" ? it.str : "";
      if (!str) continue;
      const tr = it.transform as number[] | undefined;
      const x = tr ? tr[4] : 0;
      const y = tr ? tr[5] : 0;

      // 找一条 y 接近的现有行
      let target = lines.find((l) => Math.abs(l.y - y) < 2);
      if (!target) {
        target = { y, items: [] };
        lines.push(target);
      }
      target.items.push({ x, str });
      // 处理 pdfjs 标记的「行尾」hasEOL：手动断行
      if (it.hasEOL) {
        target = { y: y - 0.001, items: [] };
        lines.push(target);
      }
    }

    // 行内按 x 排序后拼接；行整体按 y 从大到小（PDF 坐标系自上而下 y 递减）
    lines.sort((a, b) => b.y - a.y);
    const lineTexts: string[] = lines
      .map((line) => {
        line.items.sort((a, b) => a.x - b.x);
        // 行末尾的空白裁掉，但行内空白保留（中文 PDF 里空格分词常有意义）
        return line.items.map((i) => i.str).join("").replace(/\s+$/g, "");
      })
      // 这里同时过滤"看起来非空但只有不可见字符"的行——
      // 部分 PDF 的文本层会含 \u0000 / \u00A0 / \u200B（零宽空格）等，
      // 视觉上是空，却让 .length > 0 通过。
      .filter((t) => /\S/.test(t.replace(/[\u0000-\u001f\u007f\u200b\u200c\u200d\u2060\ufeff]/g, "")));

    // 段落聚合：连续非空行视为同一段，遇到空行/原始空行边界则分段
    // 由于上面已 filter 掉空行，这里把每个 lineText 视为独立段落即可
    // —— 对于普通文本 PDF 这种处理已能得到清晰的段落分隔（每行一个 <p>）
    for (const lt of lineTexts) {
      const escaped = lt
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      htmlParts.push(`<p>${escaped}</p>`);
      hasAnyText = true;
      extractedLineCount++;
    }

    // 页与页之间空一行，便于后续编辑。
    // 注意：仅在 hasAnyText 已经成立时才插入页分隔符——否则一份纯扫描件
    // 会因为 N-1 个 "<p></p>" 让 html.trim() 看起来非空，绕过 OCR 提示。
    if (pageNum < pdf.numPages && hasAnyText) {
      htmlParts.push("<p></p>");
    }
  }

  // 主动释放资源，避免 worker/document 句柄堆积
  try { await pdf.destroy(); } catch { /* ignore */ }

  // 真正没抽到任何可见文本——直接返回空串，由调用方抛 PDF_NO_TEXT_LAYER_FLAG，
  // 弹"该 PDF 无可提取文本，请使用 OCR 工具处理后再导入"。
  if (!hasAnyText) {
    return "";
  }

  // 调试日志：抽到了多少行有效文本、文档总页数。
  // 用户反馈"导入后笔记是空的"时，第一时间能在 console 看到 lineCount 区分
  // "前端抽取阶段就空" vs "抽取正常但下游被吞"。
  // 仅 dev 环境输出，避免线上 console 噪音；Vite 的 import.meta.env.DEV 在打包时被 inline。
  if (import.meta.env.DEV) {
    console.info(`[importService] PDF extracted: ${extractedLineCount} lines from ${pdf.numPages} page(s)`);
  }

  return htmlParts.join("\n");
}

// PDF 无可提取文本时抛出的错误标志（DataManager 层据此弹出 OCR 提示）
export const PDF_NO_TEXT_LAYER_FLAG = "__PDF_NO_TEXT_LAYER__";

// PDF 文件超过大小上限时抛出的错误标志
export const PDF_TOO_LARGE_FLAG = "__PDF_TOO_LARGE__";

// 笔记本名的最大长度（超出会被截断），与后端 notebooks.name 字段兼容
const MAX_NOTEBOOK_NAME_LENGTH = 60;
// 默认笔记本名（清洗后为空时的回退）
const DEFAULT_FALLBACK_NOTEBOOK_NAME = "导入的笔记";

/**
 * 从文件名派生出一个合法的笔记本名
 * 处理：
 * 1. 去掉已知的笔记扩展名（.md/.txt/.markdown/.html/.htm）
 * 2. 路径分隔符仅保留最后一段（兼容 webkitRelativePath）
 * 3. 剥离 Windows/跨平台非法字符（<>:"/\|?*）和控制字符
 * 4. 合并多余空白、裁剪首尾空白和点号
 * 5. 长度超限则按视觉字符截断
 * 6. 为空时返回 null（调用方决定回退）
 */
export function deriveNotebookNameFromFile(fileName: string): string | null {
  if (!fileName || typeof fileName !== "string") return null;

  // 只取最后一段（例如 webkitRelativePath: "folder/a.md" -> "a.md"）
  const base = fileName.split(/[\\/]+/).pop() || fileName;

  // 去掉支持的扩展名（含 .pdf）
  let name = base;
  for (const ext of SUPPORTED_EXTENSIONS) {
    if (name.toLowerCase().endsWith(ext)) {
      name = name.slice(0, -ext.length);
      break;
    }
  }

  // 剥离控制字符 + 跨平台非法字符
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ");

  // 合并空白 & 去首尾 .、空格（Windows 不允许以点号或空格结尾）
  name = name.replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "");

  if (!name) return null;

  // 长度裁剪（按 code point 计，避免截断到代理对中间）
  if ([...name].length > MAX_NOTEBOOK_NAME_LENGTH) {
    name = [...name].slice(0, MAX_NOTEBOOK_NAME_LENGTH).join("").trim();
  }

  return name || null;
}

/**
 * 在批次内对同名笔记本自动编号：name -> name, name (2), name (3) ...
 * 保持与 `getOrCreateNotebookByName` 幂等性兼容（后端按完整名字找/建）
 */
function uniquifyNotebookName(name: string, used: Map<string, number>): string {
  const count = used.get(name) || 0;
  used.set(name, count + 1);
  if (count === 0) return name;
  return `${name} (${count + 1})`;
}

function isHtmlFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

// 检测 HTML 内容来源（手机品牌）
function detectHtmlSource(html: string, fileName: string): string {
  const lower = html.toLowerCase();
  if (lower.includes("mi note") || lower.includes("小米笔记") || lower.includes("miui") || lower.includes("xiaomi")) return "xiaomi";
  if (lower.includes("coloros") || lower.includes("oppo") || lower.includes("oplus")) return "oppo";
  if (lower.includes("vivo") || lower.includes("funtouch") || lower.includes("originos")) return "vivo";
  if (lower.includes("oneplus") || lower.includes("一加") || lower.includes("h2os") || lower.includes("oxygenos")) return "oneplus";
  if (isHtmlFile(fileName)) return "html";
  return "md";
}

// 清理 HTML 内容：去除多余标签、样式、脚本，保留核心内容
function cleanHtmlContent(html: string): string {
  let content = html;

  // 移除 script 和 style 标签及其内容
  content = content.replace(/<script[\s\S]*?<\/script>/gi, "");
  content = content.replace(/<style[\s\S]*?<\/style>/gi, "");

  // 移除 HTML 注释
  content = content.replace(/<!--[\s\S]*?-->/g, "");

  // 移除 head 部分
  content = content.replace(/<head[\s\S]*?<\/head>/gi, "");

  // 提取 body 内容（如果有）
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    content = bodyMatch[1];
  }

  // 移除所有内联样式属性
  content = content.replace(/\s+style="[^"]*"/gi, "");
  content = content.replace(/\s+class="[^"]*"/gi, "");
  content = content.replace(/\s+id="[^"]*"/gi, "");

  // 移除 data-* 属性（保留 tiptap 需要的）
  content = content.replace(/\s+data-(?!type|checked)[a-z-]+="[^"]*"/gi, "");

  // 移除空的 span/div 标签
  content = content.replace(/<span[^>]*>\s*<\/span>/gi, "");
  content = content.replace(/<div[^>]*>\s*<\/div>/gi, "");

  // 将 div 转为 p（常见于手机笔记）
  content = content.replace(/<div[^>]*>/gi, "<p>");
  content = content.replace(/<\/div>/gi, "</p>");

  // 将 br 转为段落分隔
  content = content.replace(/<br\s*\/?>\s*<br\s*\/?>/gi, "</p><p>");
  content = content.replace(/<br\s*\/?>/gi, "</p><p>");

  // 清理嵌套的空 p 标签
  content = content.replace(/<p>\s*<\/p>/gi, "");

  // 去除前后空白
  content = content.trim();

  // 如果清理后没有任何 HTML 标签，包裹在 p 中
  if (!content.match(/<[a-z]/i)) {
    content = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => `<p>${line.trim()}</p>`)
      .join("\n");
  }

  return content;
}

// 从 HTML 中提取标题
function extractTitleFromHtml(html: string, fallbackTitle: string): string {
  // 尝试从 <title> 标签提取
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1].trim()) {
    return titleMatch[1].trim();
  }
  // 尝试从第一个 h1/h2 提取
  const headingMatch = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  if (headingMatch && headingMatch[1].trim()) {
    return headingMatch[1].replace(/<[^>]+>/g, "").trim();
  }
  return fallbackTitle;
}

// 读取拖入的文件列表
//
// 增强：
// 1. 同批次内的图片文件（png/jpg/gif/webp/svg/bmp/ico）会被读取为 base64 data URI，
//    构建一个 imageMap 并附加到每个 md/txt/html 笔记上。
//    这样用户"同时选中 md + 相对路径下的图片"即可恢复图片引用，不必先打成 zip。
// 2. 若 File 带有 webkitRelativePath（来自 <input webkitdirectory> 或拖拽目录），
//    会同时按相对路径与文件名建立两条索引，提高命中率。
export async function readMarkdownFiles(
  files: FileList | File[]
): Promise<ImportFileInfo[]> {
  const result: ImportFileInfo[] = [];
  const fileArray = Array.from(files);

  // —— 第一轮：扫描所有图片文件，构建 imageMap ——
  const imageMap: Record<string, string> = {};
  for (const file of fileArray) {
    if (!isImageFile(file.name)) continue;
    try {
      // 读成 ArrayBuffer 再转 base64，避免 FileReader 的异步嵌套
      const buf = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buf);
      const mime = getImageMime(file.name);
      const dataUri = `data:${mime};base64,${base64}`;

      // 键：文件名（不含路径），以及 webkitRelativePath 提供的相对路径
      const relPath = (file as any).webkitRelativePath as string | undefined;
      if (relPath) {
        imageMap[relPath] = dataUri;
        // 去掉顶层目录后的路径（与 md 里 `./images/a.png` 这种更接近）
        const parts = relPath.split("/");
        if (parts.length > 1) {
          imageMap[parts.slice(1).join("/")] = dataUri;
        }
      }
      if (!imageMap[file.name]) {
        imageMap[file.name] = dataUri;
      }
    } catch (err) {
      console.warn("读取本地图片失败:", file.name, err);
    }
  }
  const hasImages = Object.keys(imageMap).length > 0;

  // —— 第二轮：读取笔记文件 ——
  for (const file of fileArray) {
    if (!isSupportedFile(file.name)) continue;

    const fileNameTitle = file.name.replace(/\.(md|txt|markdown|html|htm|pdf)$/i, "");

    // PDF：单独走 pdfjs 抽取文本层
    if (isPdfFile(file.name)) {
      if (file.size > MAX_PDF_SIZE) {
        const err = new Error(`${PDF_TOO_LARGE_FLAG}:${file.name}`);
        (err as any).flag = PDF_TOO_LARGE_FLAG;
        (err as any).fileName = file.name;
        throw err;
      }
      try {
        const buf = await file.arrayBuffer();
        const html = await extractPdfToHtml(buf);
        if (!html.trim()) {
          const err = new Error(`${PDF_NO_TEXT_LAYER_FLAG}:${file.name}`);
          (err as any).flag = PDF_NO_TEXT_LAYER_FLAG;
          (err as any).fileName = file.name;
          throw err;
        }
        result.push({
          name: file.name,
          title: fileNameTitle,
          content: html,
          size: file.size,
          selected: true,
          source: "pdf",
          imageMap: hasImages ? imageMap : undefined,
        });
      } catch (err: any) {
        // 已经携带 flag 的错误（无文本层 / 文件过大）原样上抛由 UI 提示
        if (err && err.flag) throw err;
        // 其他解析失败：包装成统一错误
        console.error("PDF 解析失败:", file.name, err);
        const wrapped = new Error(`PDF 解析失败：${file.name}`);
        (wrapped as any).fileName = file.name;
        throw wrapped;
      }
      continue;
    }

    const text = await file.text();

    if (isHtmlFile(file.name)) {
      const source = detectHtmlSource(text, file.name);
      const title = extractTitleFromHtml(text, fileNameTitle);
      result.push({
        name: file.name,
        title,
        content: text,
        size: file.size,
        selected: true,
        source,
        imageMap: hasImages ? imageMap : undefined,
      });
    } else {
      result.push({
        name: file.name,
        title: fileNameTitle,
        content: text,
        size: file.size,
        selected: true,
        source: file.name.endsWith(".txt") ? "txt" : "md",
        imageMap: hasImages ? imageMap : undefined,
      });
    }
  }

  return result;
}

// 把 ArrayBuffer 编码成 base64（避免使用 FileReader 的链式回调）
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

// 图片扩展名 → MIME 类型
const IMAGE_MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() || "";
  return ext in IMAGE_MIME_MAP;
}

function getImageMime(name: string): string {
  const ext = (name.toLowerCase().split(".").pop() || "") as string;
  return IMAGE_MIME_MAP[ext] || "application/octet-stream";
}

// 从 zip 内部路径推导笔记本名（取第一级目录名）
function deriveNotebookName(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return undefined; // 文件位于根目录
  const first = parts[0];
  // 过滤常见的无意义目录
  if (first.startsWith(".") || first === "__MACOSX" || first.toLowerCase() === "assets" || first.toLowerCase() === "images") {
    return undefined;
  }
  return first;
}

// 清洗单个路径片段（目录名），规则与 deriveNotebookNameFromFile 一致但不去扩展名
function sanitizeSegment(segment: string): string | null {
  if (!segment) return null;
  let s = segment;
  // 剥离控制字符 + 跨平台非法字符
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ");
  // 合并空白 & 去首尾 .、空格
  s = s.replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "");
  if (!s) return null;
  // 长度裁剪
  if ([...s].length > MAX_NOTEBOOK_NAME_LENGTH) {
    s = [...s].slice(0, MAX_NOTEBOOK_NAME_LENGTH).join("").trim();
  }
  return s || null;
}

/**
 * 从 zip 内部路径推导完整的笔记本层级路径。
 * 例如 path = "我是文章2/test2/新笔记本/note.md"
 *      -> ["我是文章2", "test2", "新笔记本"]
 * 返回的数组顺序为从根到叶。
 *
 * 过滤规则：
 * - 跳过 "__MACOSX"、以 "." 开头的隐藏目录
 * - 跳过 "assets" / "images" 等纯资源目录（仅当它们出现在中间或末端且不是唯一目录时）
 * - 每段经过 sanitizeSegment 清洗
 */
function deriveNotebookPath(path: string, outerFolderName?: string): string[] {
  const parts = path.split("/").filter(Boolean);
  // 最后一段是文件名，不算笔记本
  const dirParts = parts.slice(0, -1);

  const result: string[] = [];
  for (const raw of dirParts) {
    // 过滤无意义目录
    if (raw.startsWith(".") || raw === "__MACOSX") continue;
    const lower = raw.toLowerCase();
    if (lower === "assets" || lower === "images") continue;
    const cleaned = sanitizeSegment(raw);
    if (cleaned) result.push(cleaned);
  }

  // 如果提供了最外层文件夹名（zip 文件名派生），并且它还没作为第一段出现，则前置
  if (outerFolderName) {
    if (result.length === 0 || result[0] !== outerFolderName) {
      result.unshift(outerFolderName);
    }
  }

  return result;
}

// 从 ZIP 文件中读取笔记
export async function readMarkdownFromZip(file: File): Promise<ImportFileInfo[]> {
  const r = await readMarkdownFromZipWithMeta(file);
  return r.files;
}

/**
 * P1-2：从导出 zip 里同时拿到笔记 + metadata.json 内容。
 *
 * 旧 `readMarkdownFromZip` 只返回 ImportFileInfo[]，丢弃了 metadata.json 里
 * `rootNotebookId / rootNotebookName / scope` 等信息——这些信息在"把同一份
 * 备份导回原笔记本"的场景里非常有用：DataManager 可据此自动预选目标笔记本，
 * 而不是每次都把内容塞进默认的"导入的笔记"。
 *
 * 设计取舍：
 *   - 不强行把 metadata.json 暴露到 ImportFileInfo 里，保持原数据结构稳定；
 *   - 旧调用方 `readMarkdownFromZip` 行为不变（continue 跳过 metadata.json）；
 *   - 新调用方走 `readMarkdownFromZipWithMeta`，按需消费 metadata。
 *
 * metadata 字段说明（与 exportService 一致）：
 *   { version, app, exportedAt,
 *     scope?: "notebook" | undefined,           // 仅 exportNotebook 设置
 *     rootNotebookId?: string,                  // 仅 exportNotebook 设置
 *     rootNotebookName?: string,                // 仅 exportNotebook 设置
 *     totalNotes: number,
 *     notebooks: { name, count }[],
 *     imageStats?: { ok, failed }                // 新增字段，旧包没有
 *   }
 */
export interface ZipImportMeta {
  version?: string;
  app?: string;
  exportedAt?: string;
  scope?: string;
  rootNotebookId?: string;
  rootNotebookName?: string;
  totalNotes?: number;
  notebooks?: Array<{ name: string; count: number }>;
  imageStats?: { ok: number; failed: number };
}

export async function readMarkdownFromZipWithMeta(
  file: File,
): Promise<{ files: ImportFileInfo[]; meta: ZipImportMeta | null }> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(file);
  const result: ImportFileInfo[] = [];

  // P1-2：先试读 metadata.json（如果是本应用导出的 zip，根目录会有）
  let meta: ZipImportMeta | null = null;
  const metaEntry = zip.file("metadata.json");
  if (metaEntry) {
    try {
      const text = await metaEntry.async("text");
      const parsed = JSON.parse(text) as ZipImportMeta;
      // 轻量边界检查：只认可 nowen-note 自家导出的 metadata，避免被外部 zip
      // 中的同名文件误认（用户可能上传个包含 metadata.json 的项目压缩包）。
      if (parsed && parsed.app === "nowen-note") {
        meta = parsed;
      }
    } catch (e) {
      // 解析失败不中断导入，仅告知调用方 meta=null
      console.warn("解析 metadata.json 失败，将忽略该文件：", e);
    }
  }

  // 用 zip 文件名（去掉 .zip 扩展）作为最外层笔记本名，保证"导出前的顶层目录"在导入后依然存在
  const rawZipBase = (file.name || "archive.zip").replace(/\.zip$/i, "");
  const outerFolderName = sanitizeSegment(rawZipBase) || "导入的笔记";

  // 第一轮：扫描所有图片文件，构建路径 → base64 的映射
  const imageMap: Record<string, string> = {};
  for (const [path, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    if (path.includes("__MACOSX") || path.startsWith(".")) continue;
    if (!isImageFile(path)) continue;
    try {
      const base64 = await zipEntry.async("base64");
      const mime = getImageMime(path);
      const dataUri = `data:${mime};base64,${base64}`;
      // 同时用完整路径和文件名做 key，提升相对路径匹配命中率
      imageMap[path] = dataUri;
      const fileName = path.split("/").pop();
      if (fileName && !imageMap[fileName]) {
        imageMap[fileName] = dataUri;
      }
    } catch (err) {
      console.warn("读取 zip 图片失败:", path, err);
    }
  }

  // 第二轮：扫描笔记文件
  for (const [path, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    if (!isSupportedFile(path)) continue;
    if (path === "metadata.json") continue;
    if (path === "export-warnings.json") continue;
    // 跳过 macOS 资源文件
    if (path.includes("__MACOSX") || path.startsWith(".")) continue;

    const fileName = path.split("/").pop() || path;
    const fileNameTitle = fileName.replace(/\.(md|txt|markdown|html|htm|pdf)$/i, "");

    // PDF：从 zip 内部条目走二进制 → pdfjs 抽文本
    if (isPdfFile(fileName)) {
      const notebookPath = deriveNotebookPath(path, outerFolderName);
      const notebookName = notebookPath.length > 0 ? notebookPath[notebookPath.length - 1] : undefined;
      try {
        const arr = await zipEntry.async("uint8array");
        if (arr.byteLength > MAX_PDF_SIZE) {
          const err = new Error(`${PDF_TOO_LARGE_FLAG}:${fileName}`);
          (err as any).flag = PDF_TOO_LARGE_FLAG;
          (err as any).fileName = fileName;
          throw err;
        }
        // 复制成独立 ArrayBuffer，避免 jszip 内部缓冲被复用
        const buf = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
        const html = await extractPdfToHtml(buf);
        if (!html.trim()) {
          const err = new Error(`${PDF_NO_TEXT_LAYER_FLAG}:${fileName}`);
          (err as any).flag = PDF_NO_TEXT_LAYER_FLAG;
          (err as any).fileName = fileName;
          throw err;
        }
        result.push({
          name: path,
          title: fileNameTitle,
          content: html,
          size: arr.byteLength,
          selected: true,
          source: "pdf",
          notebookName,
          notebookPath,
          imageMap,
        });
      } catch (err: any) {
        if (err && err.flag) throw err;
        console.error("PDF 解析失败:", path, err);
        const wrapped = new Error(`PDF 解析失败：${fileName}`);
        (wrapped as any).fileName = fileName;
        throw wrapped;
      }
      continue;
    }

    const text = await zipEntry.async("text");
    // 完整层级：zip 文件名（最外层） + zip 内部所有中间目录
    const notebookPath = deriveNotebookPath(path, outerFolderName);
    // notebookName 保留为末级目录名（向后兼容 & 日志用）
    const notebookName = notebookPath.length > 0 ? notebookPath[notebookPath.length - 1] : undefined;

    if (isHtmlFile(fileName)) {
      const source = detectHtmlSource(text, fileName);
      const title = extractTitleFromHtml(text, fileNameTitle);
      result.push({
        name: path,
        title,
        content: text,
        size: text.length,
        selected: true,
        source,
        notebookName,
        notebookPath,
        imageMap,
      });
    } else {
      result.push({
        name: path,
        title: fileNameTitle,
        content: text,
        size: text.length,
        selected: true,
        source: fileName.endsWith(".txt") ? "txt" : "md",
        notebookName,
        notebookPath,
        imageMap,
      });
    }
  }

  return { files: result, meta };
}

// 从 YAML frontmatter 中提取日期信息
function extractFrontmatterDates(md: string): { createdAt?: string; updatedAt?: string } {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return {};

  const fm = fmMatch[1];
  let createdAt: string | undefined;
  let updatedAt: string | undefined;

  const createdMatch = fm.match(/^created:\s*(.+)$/m);
  if (createdMatch) createdAt = createdMatch[1].trim();

  const updatedMatch = fm.match(/^updated:\s*(.+)$/m);
  if (updatedMatch) updatedAt = updatedMatch[1].trim();

  return { createdAt, updatedAt };
}

// 脱壳：整段被 ```markdown ... ``` 外层围栏包裹的场景（常见于从博客/ChatGPT 复制）
// 识别规则：首个非空行是 ```[markdown|md|空] 开围栏 + 末尾存在一个"单独成行的 ```"闭合围栏，
// 且二者之间没有其他同级 lang=markdown/md 的开围栏（避免误剥真正的代码块）。
function unwrapOuterMarkdownFence(content: string): string {
  const lines = content.split("\n");
  // 首个非空行
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  if (start >= lines.length) return content;

  const opener = lines[start].trim();
  const openMatch = opener.match(/^(`{3,}|~{3,})(.*)$/);
  if (!openMatch) return content;
  const fence = openMatch[1];
  const fenceChar = fence[0];
  const fenceLen = fence.length;
  const langToken = (openMatch[2] || "").trim().split(/\s+/)[0] || "";
  // 仅处理 lang 为 markdown/md/空 的外层围栏；其他语言（如 bash、js）不应被脱壳
  if (langToken && !/^(markdown|md)$/i.test(langToken)) return content;

  // 末尾非空行应是闭合围栏
  let end = lines.length - 1;
  while (end > start && !lines[end].trim()) end--;
  if (end <= start) return content;

  const isClosingFence = (rawLine: string): boolean => {
    const t = rawLine.trim();
    if (t.length < fenceLen) return false;
    let k = 0;
    while (k < t.length && t[k] === fenceChar) k++;
    if (k < fenceLen) return false;
    const rest = t.slice(k);
    return rest.length === 0 || /^\s*$/.test(rest);
  };
  if (!isClosingFence(lines[end])) return content;

  // 返回剥掉外层后的内容
  return lines.slice(start + 1, end).join("\n");
}

// 将 Markdown 转为 HTML（用于存储到 Tiptap 格式）
export function markdownToSimpleHtml(md: string, imageMap?: Record<string, string>): string {
  // 去除 YAML frontmatter
  // 注意：必须锁定"字符串最开头"且 --- 独占整行，否则会把文档中任意两个水平线
  // `---` 之间的内容整段吃掉（曾导致粘贴含有多个 --- 分隔线的 MD 时大量内容丢失）。
  let content = md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");

  // 脱壳：整段被 ```markdown ... ``` 包裹时，剥掉外层
  content = unwrapOuterMarkdownFence(content);

  // 使用 marked 解析 Markdown → HTML
  // marked 是业界成熟的 CommonMark 兼容解析器，正确处理嵌套围栏代码块、表格、任务列表等
  const renderer = new Renderer();

  // 图片：替换 imageMap 中的本地路径为 data URI
  renderer.image = ({ href, title, text }: { href: string; title?: string | null; text: string }) => {
    const resolvedSrc = resolveLocalAssetSrc(href, imageMap);
    const titleAttr = title ? ` title="${title}"` : "";
    return `<img src="${resolvedSrc}" alt="${text}"${titleAttr} />`;
  };

  // 代码块：输出 Tiptap 期望的 <pre><code class="language-xxx"> 格式
  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    const langClass = lang ? ` class="language-${lang}"` : "";
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre><code${langClass}>${escaped}</code></pre>`;
  };

  marked.use({ renderer, gfm: true, breaks: false });

  const html = replaceLocalAssetSources(marked.parse(content) as string, imageMap);
  // 规范化 marked 输出的 GFM 表格 HTML，使其符合 Tiptap table schema
  // （否则带表格的 md 在下游 generateJSON 时会产出非法 content，触发
  //  ProseMirror 的 "Called contentMatchAt on a node with invalid content"）
  // 同时把 GFM 任务列表（- [x] / - [ ]）改写成 Tiptap TaskList 格式，
  // 否则会被 schema 当成普通 <ul>，checkbox 直接丢失退化成无序列表。
  return normalizeTaskListHtml(normalizeTableHtml(html));
}

function replaceLocalAssetSources(html: string, assetMap?: Record<string, string>): string {
  if (!assetMap || !html || !/\s(?:src)=["']/i.test(html)) return html;

  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
      const root = doc.body.firstElementChild;
      if (!root) return html;
      const elements = root.querySelectorAll("img[src], video[src], video source[src], audio[src], audio source[src]");
      elements.forEach((el) => {
        const src = el.getAttribute("src");
        if (!src) return;
        el.setAttribute("src", resolveLocalAssetSrc(src, assetMap));
      });
      return root.innerHTML;
    } catch (e) {
      console.warn("[importService] replaceLocalAssetSources DOM rewrite failed:", e);
    }
  }

  return html.replace(
    /(<(?:img|video|audio|source)\b[^>]*\ssrc=)(["'])([^"']+)(\2)/gi,
    (_match, prefix: string, quote: string, src: string, suffix: string) =>
      `${prefix}${quote}${resolveLocalAssetSrc(src, assetMap)}${suffix}`,
  );
}

// 把 marked 输出的 GFM 任务列表 HTML 改写成 Tiptap TaskList/TaskItem 期望的形态。
//
// marked@14 输出（GFM 任务列表）：
//   <ul>
//     <li><input checked="" disabled="" type="checkbox"> 已完成项</li>
//     <li><input disabled="" type="checkbox"> 未完成项</li>
//   </ul>
// Tiptap TaskList/TaskItem 期望的 parse 形态：
//   <ul data-type="taskList">
//     <li data-type="taskItem" data-checked="true"><p>已完成项</p></li>
//     <li data-type="taskItem" data-checked="false"><p>未完成项</p></li>
//   </ul>
//
// 不用正则是因为 li 内容可能含嵌套 <ul>（子任务）、链接、加粗等结构，
// DOMParser 处理嵌套天然正确。在浏览器中开销 ~1ms，可接受。
//
// 关键规则：
// - 只改写**直接子级含 <input type="checkbox"> 的 li**；普通 li 维持原样
// - 包含至少一个 task li 的 ul 才标记为 taskList；纯无序列表不动
// - data-checked 来源于 input 的 checked 属性
// - input 节点本身从 li 中移除（Tiptap 渲染时会自己生成 checkbox）
function normalizeTaskListHtml(html: string): string {
  if (!html || html.indexOf("type=\"checkbox\"") === -1) return html;
  // 服务端/测试环境无 DOMParser 时退化（不抛错，原样返回）
  if (typeof DOMParser === "undefined") return html;

  try {
    const doc = new DOMParser().parseFromString(
      `<div>${html}</div>`,
      "text/html",
    );
    const root = doc.body.firstElementChild;
    if (!root) return html;

    // 自底向上遍历所有 ul：先处理嵌套的子 ul，再处理父 ul
    // 这样父 li 被改写成 taskItem 时，里面已经处理过的子 taskList 不会被破坏
    const allUls = Array.from(root.querySelectorAll("ul"));
    for (const ul of allUls) {
      const directLis = Array.from(ul.children).filter(
        (el) => el.tagName === "LI",
      ) as HTMLLIElement[];
      let hasTaskItem = false;

      for (const li of directLis) {
        // li 的首个有效子元素必须是 input[type=checkbox] 才算任务项
        const firstChild = li.firstElementChild;
        if (
          !firstChild ||
          firstChild.tagName !== "INPUT" ||
          (firstChild as HTMLInputElement).type !== "checkbox"
        ) {
          continue;
        }
        hasTaskItem = true;
        const checked = (firstChild as HTMLInputElement).hasAttribute("checked");
        // 移除 input，保留余下文本/元素作为 taskItem 的内容
        firstChild.remove();
        // marked 输出的 li 文本紧贴 input 后，通常是个空格开头，trim 掉
        if (li.firstChild && li.firstChild.nodeType === 3) {
          li.firstChild.nodeValue = (li.firstChild.nodeValue || "").replace(/^\s+/, "");
        }
        li.setAttribute("data-type", "taskItem");
        li.setAttribute("data-checked", checked ? "true" : "false");
        // Tiptap TaskItem schema 要求内容是 paragraph+。把直接子级的散文本/inline
        // 节点包到一个 <p> 里；已经是 <p>/<ul>（嵌套子任务）等块级元素的不动。
        wrapInlineChildrenInParagraph(li);
      }

      if (hasTaskItem) {
        ul.setAttribute("data-type", "taskList");
      }
    }

    return root.innerHTML;
  } catch (e) {
    console.warn("[importService] normalizeTaskListHtml failed:", e);
    return html;
  }
}

// 把元素的直接 inline 子节点（文本、<a>、<strong>、<code> 等）按相邻段聚合到
// 单个 <p> 里。已经是块级（p/ul/ol/blockquote/pre/h1-h6/div）的子节点维持位置。
// 用于满足 Tiptap TaskItem 的 "paragraph+ 内容" schema 要求。
function wrapInlineChildrenInParagraph(el: Element): void {
  const blockTags = new Set([
    "P", "UL", "OL", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6",
    "DIV", "TABLE", "HR",
  ]);
  const children = Array.from(el.childNodes);
  let buffer: Node[] = [];
  const flush = (insertBefore: Node | null) => {
    if (buffer.length === 0) return;
    // 全部为空白文本则不生成 <p>
    const allWhitespace = buffer.every(
      (n) => n.nodeType === 3 && !(n.nodeValue || "").trim(),
    );
    if (allWhitespace) {
      buffer.forEach((n) => n.parentNode?.removeChild(n));
      buffer = [];
      return;
    }
    const p = el.ownerDocument!.createElement("p");
    buffer.forEach((n) => p.appendChild(n));
    el.insertBefore(p, insertBefore);
    buffer = [];
  };

  for (const node of children) {
    if (node.nodeType === 1 && blockTags.has((node as Element).tagName)) {
      flush(node);
    } else {
      buffer.push(node);
    }
  }
  flush(null);
}

// 规范化表格 HTML，让它能被 Tiptap 的 Table schema 接受。
//
// Tiptap 官方 @tiptap/extension-table 的 schema 要求：
//   table > tableRow > (tableCell | tableHeader)
// 它**不接受** <thead>/<tbody>/<tfoot> 作为 <table> 的直接子节点。
//
// 但 marked 在 gfm:true 下输出的标准表格是：
//   <table><thead><tr>...</tr></thead><tbody><tr>...</tr></tbody></table>
// 这会让 generateJSON 产出 schema 不合法的 JSON——init 时不报，但第一次
// 经过 transaction 时（如 SearchReplacePanel 的 highlight decoration plugin）
// 触发 contentMatchAt 抛错，整个编辑器白屏。
//
// 这里用最简的字符串替换把 <thead>/<tbody>/<tfoot> 标签剥掉（保留里面的
// <tr>）。单元格 align 需保留给 schema round-trip（SiYuan 表格保真）。
function normalizeTableHtml(html: string): string {
  if (!html || html.indexOf("<table") === -1) return html;
  return html
    // 剥掉 <thead>/<tbody>/<tfoot> 包裹标签（保留内部 <tr>）
    .replace(/<\/?(thead|tbody|tfoot)\b[^>]*>/gi, "");
}

// Layer 2 兜底：用一个离屏 Editor 把任意脏 HTML 修复成合 schema 的 JSON。
//
// 触发场景：normalizeTableHtml 没覆盖到的未知脏姿势（嵌套 list 异常、
// 自定义标签、错配标签等）让 generateJSON 抛错，或产出空 doc。
// ProseMirror 的 setContent 内置 schema fixup（丢非法子节点 / 补必需包裹），
// 比手写规则鲁棒得多。代价：实例化一个 headless Editor，~10-20ms。
//
// 注意：Tiptap 4 的 Editor 构造函数在没传 element 时跑 headless 模式，
// 不需要真实 DOM 节点。
function repairHtmlViaHeadlessEditor(html: string): unknown | null {
  let editor: Editor | null = null;
  try {
    editor = new Editor({
      extensions: tiptapExtensions,
      content: html,
      // 静默丢弃非法内容而不是抛错；不设置时默认就是 false，这里写明意图
      enableContentCheck: false,
    });
    return editor.getJSON();
  } catch (e) {
    console.warn("[importService] headless editor repair failed:", e);
    return null;
  } finally {
    try { editor?.destroy(); } catch { /* ignore */ }
  }
}

// 在 imageMap 中查找本地资源路径对应的 data URI
function resolveLocalAssetSrc(src: string, imageMap?: Record<string, string>): string {
  if (!imageMap) return src;
  // 外链 / 绝对 URL / 已是 data URI，不处理
  if (/^(https?:|data:|\/\/)/i.test(src)) return src;

  // 去除查询参数和 hash
  const clean = src.split(/[?#]/)[0];
  // 直接命中
  if (imageMap[clean]) return imageMap[clean];
  // 规范化开头的 ./ 或 /
  const normalized = clean.replace(/^\.\//, "").replace(/^\//, "");
  if (imageMap[normalized]) return imageMap[normalized];
  // 仅用文件名匹配
  const base = normalized.split("/").pop();
  if (base && imageMap[base]) return imageMap[base];
  // 解码 URI（中文文件名在 md 中可能被 encode）
  try {
    const decoded = decodeURIComponent(normalized);
    if (imageMap[decoded]) return imageMap[decoded];
    const decodedBase = decoded.split("/").pop();
    if (decodedBase && imageMap[decodedBase]) return imageMap[decodedBase];
  } catch {
    /* ignore */
  }
  return src;
}

function isSiyuanSource(source?: string): boolean {
  return source === "siyuan" || source === "siyuan-sy";
}

function replaceMarkdownLocalAssets(md: string, imageMap?: Record<string, string>): string {
  if (!imageMap || !md) return md;

  const withMarkdownImages = md.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (match, alt: string, rawSrc: string) => {
      const src = String(rawSrc || "").trim();
      if (/^(https?:|data:|\/\/)/i.test(src)) return match;
      const resolved = resolveLocalAssetSrc(src, imageMap);
      return `![${alt}](${resolved})`;
    },
  );

  return replaceLocalAssetSources(withMarkdownImages, imageMap);
}

function convertSiyuanImportToMarkdown(fileInfo: ImportFileInfo): string {
  let md = fileInfo.content || "";
  md = md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  md = replaceMarkdownLocalAssets(md, fileInfo.imageMap);
  return md.trim();
}

// 处理行内 Markdown 语法
function inlineMarkdown(text: string, imageMap?: Record<string, string>): string {
  return (
    text
      // 图片（必须在链接之前处理）
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
        const resolved = resolveLocalAssetSrc(src.trim(), imageMap);
        const escapedAlt = alt.replace(/"/g, "&quot;");
        return `<img src="${resolved}" alt="${escapedAlt}" />`;
      })
      // 链接
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      // 粗斜体
      .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
      // 粗体
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      // 斜体
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      // 删除线
      .replace(/~~(.+?)~~/g, "<s>$1</s>")
      // 高亮
      .replace(/==(.+?)==/g, "<mark>$1</mark>")
      // 行内代码已废弃：剥离反引号，保留为纯文本（统一使用代码块）
      .replace(/`([^`]+)`/g, "$1")
  );
}

// 将纯文本转为 HTML
function textToHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      // 转义 HTML 特殊字符
      const escaped = trimmed
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<p>${escaped}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

// 根据来源转换内容为 TipTap JSON 字符串
export function convertToTiptapJson(fileInfo: ImportFileInfo): string {
  const { content, source, imageMap } = fileInfo;

  let html: string;
  switch (source) {
    case "pdf":
      // PDF 在读取阶段已被组装成纯净的 <p> HTML，不需要再次清洗或解析
      html = content;
      break;
    case "html":
    case "xiaomi":
    case "oppo":
    case "vivo":
    case "oneplus":
      html = cleanHtmlContent(content);
      break;
    case "txt":
      html = textToHtml(content);
      break;
    case "md":
    default:
      html = markdownToSimpleHtml(content, imageMap);
      break;
  }

  // 将 HTML 转为 TipTap JSON 格式（与编辑器保存格式一致）
  //
  // 两层防御：
  //   Layer 1（已在 markdownToSimpleHtml 末尾做）：normalizeTableHtml 把
  //     marked 产出的 <thead>/<tbody> 剥成 Tiptap 接受的形态；
  //   Layer 2（此处）：generateJSON 仍可能在未知脏 HTML 上产出"内部不合
  //     schema 的 JSON"——init 时不报、transaction 时崩。这里用一个
  //     headless Editor 让 ProseMirror 的 setContent 走自家 schema fixup
  //     兜底，保证任何 html 都能产出合 schema 的 JSON。
  try {
    const json = generateJSON(html, tiptapExtensions);

    // 防御：generateJSON 在 schema 命中失败时不会抛错，而是吐出
    // `{ type: "doc", content: [{ type: "paragraph" }] }` 这样的"空 doc"。
    // 此时如果原 html 其实非空，先尝试 headless Editor 修复；仍失败再
    // 回退到 HTML 字符串。
    const looksEmpty =
      json &&
      json.type === "doc" &&
      Array.isArray(json.content) &&
      (json.content.length === 0 ||
        (json.content.length === 1 &&
          json.content[0]?.type === "paragraph" &&
          !json.content[0]?.content));
    if (looksEmpty && html.replace(/<[^>]+>/g, "").trim().length > 0) {
      console.warn("[importService] generateJSON produced empty doc, retrying via headless editor");
      const repaired = repairHtmlViaHeadlessEditor(html);
      if (repaired) return JSON.stringify(repaired);
      return html;
    }

    return JSON.stringify(json);
  } catch (err) {
    // generateJSON 抛错（最常见：parseHTML 出来的内容不满足某个 node 的
    // contentMatch）。先试 headless Editor 修复，再回退 HTML 字符串。
    console.warn("[importService] generateJSON threw, retrying via headless editor:", err);
    const repaired = repairHtmlViaHeadlessEditor(html);
    if (repaired) return JSON.stringify(repaired);
    return html;
  }
}

// 提取纯文本用于搜索索引
export function extractPlainText(fileInfo: ImportFileInfo): string {
  const { content, source } = fileInfo;

  if (source === "pdf" || source === "html" || source === "xiaomi" || source === "oppo" || source === "vivo" || source === "oneplus") {
    return content
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  // Markdown / txt
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
    .replace(/[#*_~`\[\]()>|-]/g, "")
    .trim();
}

// 执行导入
export async function importNotes(
  fileInfos: ImportFileInfo[],
  notebookId?: string,
  onProgress?: (p: ImportProgress) => void,
  options?: ImportOptions
): Promise<{ success: boolean; count: number }> {
  const selected = fileInfos.filter((f) => f.selected);

  if (selected.length === 0) {
    onProgress?.({ phase: "error", current: 0, total: 0, message: i18n.t('dataManager.noFilesSelected') });
    return { success: false, count: 0 };
  }

  // 解析导入选项
  // 当用户明确选了目标笔记本（notebookId）时，perFileNotebook 被忽略（保持 UI 层互斥约定的最终保险）
  const perFileNotebook = !notebookId && !!options?.perFileNotebook;
  const duplicateStrategy = options?.duplicateStrategy ?? "merge";
  const fallbackNotebookName =
    (options?.fallbackNotebookName && options.fallbackNotebookName.trim()) ||
    DEFAULT_FALLBACK_NOTEBOOK_NAME;

  // 批次内"名字 -> 已出现次数"，用于 duplicateStrategy=unique 时自动编号
  const usedNotebookNames = new Map<string, number>();

  try {
    onProgress?.({ phase: "uploading", current: 0, total: selected.length, message: i18n.t('dataManager.uploadingProgress') });

    const notes = selected.map((f) => {
      const importAsMarkdown = isSiyuanSource(f.source);
      const note: { title: string; content: string; contentText: string; contentFormat?: "tiptap-json" | "markdown" | "html"; createdAt?: string; updatedAt?: string; notebookName?: string; notebookPath?: string[] } = {
        title: f.title,
        content: importAsMarkdown ? convertSiyuanImportToMarkdown(f) : convertToTiptapJson(f),
        contentText: extractPlainText(f),
        contentFormat: importAsMarkdown ? "markdown" : "tiptap-json",
      };
      // 对 Markdown 文件尝试提取 frontmatter 中的日期
      if (f.source === "md" || !f.source) {
        const dates = extractFrontmatterDates(f.content);
        if (dates.createdAt) note.createdAt = dates.createdAt;
        if (dates.updatedAt) note.updatedAt = dates.updatedAt;
      }
      if (f.createdAt) note.createdAt = f.createdAt;
      if (f.updatedAt) note.updatedAt = f.updatedAt;

      // —— 决定该笔记的 notebookName / notebookPath ——
      // 优先级：perFileNotebook（覆盖式） > zip 路径派生 f.notebookPath > 扁平 f.notebookName > 无
      if (perFileNotebook) {
        // 从原始文件名派生；失败则回退到标题；仍失败则用 fallback
        const derived =
          deriveNotebookNameFromFile(f.name) ||
          deriveNotebookNameFromFile(f.title) ||
          fallbackNotebookName;
        const finalName =
          duplicateStrategy === "unique"
            ? uniquifyNotebookName(derived, usedNotebookNames)
            : derived;
        note.notebookName = finalName;
        // per-file 模式下视为单层路径
        note.notebookPath = [finalName];
      } else if (f.notebookPath && f.notebookPath.length > 0) {
        // zip 导入：透传完整层级路径，后端按层级逐级查找/创建
        note.notebookPath = f.notebookPath;
        note.notebookName = f.notebookPath[f.notebookPath.length - 1];
      } else if (f.notebookName) {
        // 向后兼容：没有 notebookPath 时仍透传单层名字
        note.notebookName = f.notebookName;
      }
      return note;
    });

    const result = await api.importNotes(notes, notebookId, undefined, options?.workspaceId);

    onProgress?.({
      phase: "done",
      current: result.count,
      total: selected.length,
      message: i18n.t('dataManager.importSuccessCount', { count: result.count }),
    });

    return { success: true, count: result.count };
  } catch (error) {
    console.error("导入失败:", error);
    onProgress?.({
      phase: "error",
      current: 0,
      total: selected.length,
      message: i18n.t('dataManager.importFailed', { error: (error as Error).message }),
    });
    return { success: false, count: 0 };
  }
}

// =============================================================================
// 单文件快速导入（拖拽专用）
// -----------------------------------------------------------------------------
// 与 importNotes 不同：不走 dialog/选择/分组那套批量流程，
// 直接把一份 .md / .markdown / .txt 转成一条笔记落库。
// 用于 NoteList 的"拖文件进来即导入"快捷路径，逻辑要尽量轻。
// =============================================================================
export interface ImportMarkdownAsNoteResult {
  note: import("@/types").Note;
  previewText: string;
}

const IMPORT_TEXT_MAX_SIZE = 10 * 1024 * 1024; // 10MB，足够覆盖绝大多数手写笔记

export async function importMarkdownAsNote(params: {
  notebookId: string;
  file: File;
}): Promise<ImportMarkdownAsNoteResult> {
  const { notebookId, file } = params;
  if (!file) throw new Error("未选择文件");
  if (file.size > IMPORT_TEXT_MAX_SIZE) {
    throw new Error(
      `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 ${IMPORT_TEXT_MAX_SIZE / 1024 / 1024} MB`,
    );
  }

  const text = await file.text();
  const lower = file.name.toLowerCase();
  const isMd = lower.endsWith(".md") || lower.endsWith(".markdown");
  const source: ImportFileInfo["source"] = isMd ? "md" : "txt";

  // 标题：md 优先取首个一级标题；否则用文件名（去扩展名）
  const fileBaseName = file.name.replace(/\.(md|markdown|txt)$/i, "");
  let title = fileBaseName;
  if (isMd) {
    const m = text.match(/^\s*#\s+(.+?)\s*$/m);
    if (m && m[1].trim()) title = m[1].trim();
  }

  const fileInfo: ImportFileInfo = {
    name: file.name,
    title,
    content: text,
    size: text.length,
    selected: true,
    source,
  };

  const content = convertToTiptapJson(fileInfo);
  const previewText = extractPlainText(fileInfo).slice(0, 200);

  // md frontmatter 里若有 createdAt / updatedAt 就尊重它
  const dates = isMd ? extractFrontmatterDates(text) : {};

  const baseNote = (await api.createNote({ notebookId, title })) as import("@/types").Note;
  const updated = (await api.updateNote(baseNote.id, {
    content,
    contentText: previewText,
    version: baseNote.version,
    ...(dates.createdAt ? { createdAt: dates.createdAt } : {}),
    ...(dates.updatedAt ? { updatedAt: dates.updatedAt } : {}),
  } as Partial<import("@/types").Note>)) as import("@/types").Note;

  return { note: updated, previewText };
}

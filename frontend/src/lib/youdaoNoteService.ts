/**
 * 有道云笔记 Web 版批量导出目录解析器
 *
 * 有道云笔记导出格式说明：
 * 用户从 Web 版/客户端使用「批量导出」功能，会得到一个目录树，例如：
 *
 *   qq{userId}_2026-05-06_{ts}/
 *     2022/
 *       前端知识点.md
 *       vue/
 *     过去/
 *       2021-4-30/
 *         note1.md
 *         note2.html
 *         photo.png
 *         report.pdf
 *         design.xmind
 *       bookmarks_xxx.html               ← 浏览器收藏夹（Netscape 格式）
 *       2021.9.13.note.pdf               ← 有道无法转换为 md 的笔记打印的 PDF
 *     导出失败文档解决方案_xxx.txt        ← 列出导出失败的笔记
 *
 * 文件类型分发策略：
 * - .md / .markdown / .txt / .html / .htm → 走现有 importNotes 链路（笔记内容）
 * - .docx                                 → mammoth 解析为 HTML 后作为笔记
 * - 其他类型（.pdf/.xmind/.7z/.zip/.rar/.epub/.exe/.bat/...） → 作为附件
 *   每个文件生成一篇仅含「文件链接卡片」的占位笔记，附件挂载流程：
 *     1) importNotes 创建占位笔记（content 留空字符串占位）
 *     2) attachments.upload(file, noteId) 拿到附件 URL
 *     3) PUT /notes/:id 把卡片 HTML 写入正文
 * - bookmarks*.html (Netscape 书签格式)   → 转层级 markdown 列表
 * - 「导出失败文档解决方案_*.txt」         → 识别为说明笔记
 *
 * 目录 → 笔记本映射：
 * - 顶层目录名（如 qq{userId}_xxx）作为根笔记本（用户可在 UI 改名）
 * - 内部子目录按层级映射成 notebookPath，由后端逐级 find/create
 *
 * 元数据：
 * - 创建/修改时间：从 File.lastModified 推断（webkitRelativePath 模式下可用）
 *   注意：浏览器只暴露 lastModified，无 created；保留 updatedAt 即可
 */

import { api } from "./api";
import { generateJSON } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
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
import { common, createLowlight } from "lowlight";
import {
  ImportFileInfo,
  ImportProgress,
  importNotes,
  markdownToSimpleHtml,
} from "./importService";
import { TextStyleKit } from "@/components/FontSizeExtension";
import { Video as VideoExtension } from "@/components/VideoExtension";

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
  TableWithSiyuanAttrs.configure({ resizable: false }),
  TableRowWithHeight,
  TableHeaderWithAlign,
  TableCellWithAlign,
  // TextStyle + Color + FontSize：与编辑器保持一致
  ...TextStyleKit,
  // 视频节点：与编辑器保持一致，否则有道导入中的 video 会被吞
  VideoExtension,
];

// ============================================================
// 文件分类
// ============================================================

/** 笔记类文本（直接走 importNotes 链路） */
const TEXT_NOTE_EXTENSIONS = [".md", ".markdown", ".txt", ".html", ".htm"];

/** docx 通过 mammoth 转 HTML 后作为笔记 */
const DOCX_EXTENSIONS = [".docx"];

/** 这些文件被认为「不能直接打开预览」，按附件占位笔记处理；上限来自 backend 配置（非图片类的扩展名集合不限制具体类型，只看大小） */
const NON_NOTE_AS_ATTACHMENT = true;

/** 图片扩展名（用于内嵌到同名/同目录笔记里） */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];

/** 一定跳过的隐藏 / 系统垃圾 */
const SKIP_PATTERNS = [/^\.DS_Store$/i, /^Thumbs\.db$/i, /^__MACOSX$/i, /^\._/];

function getExt(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx < 0) return "";
  return name.slice(idx).toLowerCase();
}

function isTextNote(name: string): boolean {
  return TEXT_NOTE_EXTENSIONS.includes(getExt(name));
}
function isDocxFile(name: string): boolean {
  return DOCX_EXTENSIONS.includes(getExt(name));
}
function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(getExt(name));
}

function shouldSkip(name: string): boolean {
  return SKIP_PATTERNS.some((re) => re.test(name));
}

/**
 * 判断 HTML 是否为 Netscape 书签格式
 * 标志：DOCTYPE 含 "NETSCAPE-Bookmark-file-1"
 */
function isNetscapeBookmark(html: string): boolean {
  return /<!DOCTYPE\s+NETSCAPE-Bookmark-file-1>/i.test(html.slice(0, 200));
}

/**
 * 判断是否为「导出失败文档解决方案」说明文件
 * 启发式：文件名以「导出失败文档解决方案」开头，扩展名 .txt
 */
function isYoudaoFailureNotice(name: string): boolean {
  return /^导出失败文档解决方案.*\.txt$/i.test(name);
}

// ============================================================
// 路径处理
// ============================================================

const MAX_NOTEBOOK_NAME_LENGTH = 60;

function sanitizeSegment(seg: string): string {
  let s = seg.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ");
  s = s.replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "");
  if ([...s].length > MAX_NOTEBOOK_NAME_LENGTH) {
    s = [...s].slice(0, MAX_NOTEBOOK_NAME_LENGTH).join("").trim();
  }
  return s;
}

/**
 * 把 webkitRelativePath 拆成 (notebookPath[], fileName)
 * 例：
 *   relPath = "qq.../过去/2021-4-30/note1.md"
 *   rootName = "有道云笔记"  (用户在 UI 输入的根笔记本名；可空)
 *
 *   → notebookPath = ["有道云笔记", "过去", "2021-4-30"]   (跳过 webkit 顶层)
 *      fileName    = "note1.md"
 *
 * 顶层目录（webkit 第一段）通常是有道导出包名 "qq{userId}_xxx"，
 * 默认丢弃，用 rootName 替代；rootName 为空时则保留它。
 */
function splitRelPath(
  relPath: string,
  rootName: string | undefined,
): { notebookPath: string[]; fileName: string } {
  const parts = relPath.split(/[/\\]+/).filter(Boolean);
  if (parts.length === 0) return { notebookPath: [], fileName: relPath };
  const fileName = parts[parts.length - 1];
  // 中间目录（不含顶层 + 不含文件名）
  const middleDirs = parts.slice(1, -1);
  const cleanedMiddle = middleDirs.map(sanitizeSegment).filter(Boolean);

  const notebookPath: string[] = [];
  if (rootName && rootName.trim()) {
    notebookPath.push(sanitizeSegment(rootName) || rootName.trim());
  } else {
    // 没填根名：用 webkit 顶层目录
    const top = sanitizeSegment(parts[0]);
    if (top) notebookPath.push(top);
  }
  notebookPath.push(...cleanedMiddle);
  return { notebookPath, fileName };
}

// ============================================================
// 解析后的扫描结果（UI 展示用）
// ============================================================

export type YoudaoEntryKind =
  | "note-md"
  | "note-html"
  | "note-txt"
  | "note-docx"
  | "note-bookmark"
  | "note-failure-notice"
  | "attachment"
  | "image"
  | "skipped";

export interface YoudaoEntry {
  /** webkit 相对路径（含顶层目录） */
  relPath: string;
  /** 文件名（不含路径） */
  fileName: string;
  /** 笔记本层级路径（不含文件名） */
  notebookPath: string[];
  /** 文件大小（字节） */
  size: number;
  /** 修改时间（来自 File.lastModified） */
  lastModified: number;
  /** 分类 */
  kind: YoudaoEntryKind;
  /** 是否被用户选中导入 */
  selected: boolean;
  /** 真实 File 对象（导入阶段需要） */
  file: File;
}

export interface YoudaoScanResult {
  rootFolderName: string; // 顶层目录名（webkit 顶层）
  entries: YoudaoEntry[];
  /** 仅作 UI 展示的统计 */
  stats: {
    notes: number; // text + docx + bookmark + failure-notice
    attachments: number; // 含 image
    skipped: number; // 隐藏文件 / 不识别
    totalBytes: number;
  };
}

/**
 * 扫描用户选中的目录，把每个文件分类，返回结果供 UI 预览。
 * 不做任何 I/O 上传 / 重型解析（mammoth、html parsing 都延后到导入阶段）。
 */
export function scanYoudaoExport(files: FileList | File[]): YoudaoScanResult {
  const fileArray = Array.from(files);
  const entries: YoudaoEntry[] = [];

  // 推断 webkit 顶层目录名
  let rootFolderName = "youdao-import";
  if (fileArray.length > 0) {
    const first = (fileArray[0] as any).webkitRelativePath as string | undefined;
    if (first) {
      const top = first.split(/[/\\]/)[0];
      if (top) rootFolderName = top;
    }
  }

  let totalBytes = 0;
  let notes = 0;
  let attachments = 0;
  let skipped = 0;

  for (const file of fileArray) {
    const relPath = ((file as any).webkitRelativePath as string | undefined) || file.name;
    const fileName = relPath.split(/[/\\]/).pop() || file.name;

    if (shouldSkip(fileName)) {
      skipped++;
      entries.push({
        relPath,
        fileName,
        notebookPath: [],
        size: file.size,
        lastModified: file.lastModified,
        kind: "skipped",
        selected: false,
        file,
      });
      continue;
    }

    const { notebookPath } = splitRelPath(relPath, rootFolderName);

    let kind: YoudaoEntryKind;
    if (isYoudaoFailureNotice(fileName)) {
      kind = "note-failure-notice";
      notes++;
    } else if (isImageFile(fileName)) {
      // 图片单独标记，导入时挂到「同目录第一篇笔记」里或者作为附件
      kind = "image";
      attachments++;
    } else if (isTextNote(fileName)) {
      const ext = getExt(fileName);
      if (ext === ".html" || ext === ".htm") {
        // 名字含 bookmarks 关键字时优先视为书签；否则在导入阶段嗅探内容再决定
        if (/bookmarks?/i.test(fileName)) {
          kind = "note-bookmark";
        } else {
          kind = "note-html";
        }
      } else if (ext === ".txt") {
        kind = "note-txt";
      } else {
        kind = "note-md";
      }
      notes++;
    } else if (isDocxFile(fileName)) {
      kind = "note-docx";
      notes++;
    } else if (NON_NOTE_AS_ATTACHMENT) {
      kind = "attachment";
      attachments++;
    } else {
      kind = "skipped";
      skipped++;
    }

    totalBytes += file.size;
    entries.push({
      relPath,
      fileName,
      notebookPath,
      size: file.size,
      lastModified: file.lastModified,
      kind,
      selected: kind !== "skipped",
      file,
    });
  }

  return {
    rootFolderName,
    entries,
    stats: { notes, attachments, skipped, totalBytes },
  };
}

// ============================================================
// 解析逻辑（按 kind 分发）
// ============================================================

/**
 * Netscape 书签 HTML → 层级 markdown 列表
 *
 * 输入示例：
 *   <DL><p>
 *     <DT><H3>书签栏</H3>
 *     <DL><p>
 *       <DT><A HREF="https://...">标题</A>
 *     </DL><p>
 *   </DL><p>
 *
 * 输出示例：
 *   ## 书签栏
 *   - [标题](https://...)
 */
function bookmarksHtmlToMarkdown(html: string): string {
  const out: string[] = [];

  // 用 DOMParser 解析（浏览器原生，免依赖）
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return "";
  }

  const root = doc.querySelector("dl");
  if (!root) return "";

  // 递归遍历，深度决定标题级数（最多 h6）
  const walk = (dl: Element, depth: number) => {
    const children = Array.from(dl.children);
    for (const child of children) {
      // <DT> 是书签项的容器，内部可能是 <H3>（文件夹标题）或 <A>（书签）
      if (child.tagName === "DT") {
        const h3 = child.querySelector(":scope > h3");
        const a = child.querySelector(":scope > a");
        if (h3) {
          const title = (h3.textContent || "").trim();
          if (title) {
            const level = Math.min(depth + 1, 6);
            out.push(`${"#".repeat(level)} ${title}`);
            out.push("");
          }
          // 同级 DT 之后通常跟着 <DL>（子层级）
          // 兄弟节点中找下一个 DL
          let sib = child.nextElementSibling;
          while (sib && sib.tagName !== "DL" && sib.tagName !== "DT") {
            sib = sib.nextElementSibling;
          }
          if (sib && sib.tagName === "DL") {
            walk(sib, depth + 1);
          }
        } else if (a) {
          const title = (a.textContent || "").trim() || (a as HTMLAnchorElement).href;
          const href = (a as HTMLAnchorElement).getAttribute("href") || "";
          const safeTitle = title.replace(/\[/g, "［").replace(/\]/g, "］");
          out.push(`- [${safeTitle}](${href})`);
        }
      }
    }
  };

  walk(root, 1);
  return out.join("\n");
}

/**
 * 文件大小格式化（字节 → KB/MB/GB）
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 推断附件 MIME 类型（用 file.type 兜底，再按扩展名补）
 */
function getMimeByExt(name: string): string {
  const ext = getExt(name);
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
    ".rar": "application/vnd.rar",
    ".7z": "application/x-7z-compressed",
    ".epub": "application/epub+zip",
    ".xmind": "application/vnd.xmind.workbook",
  };
  return map[ext] || "application/octet-stream";
}

/**
 * 转换 docx 为 HTML（mammoth 浏览器版）
 *
 * 这是一个比较重的依赖（≈800KB），所以延后到导入阶段动态 import。
 * 走 mammoth 主入口（带类型声明），它会在浏览器环境自动选择正确的实现。
 */
async function docxToHtml(file: File): Promise<string> {
  // @ts-ignore - mammoth 主入口在浏览器下也能用，但类型声明仅覆盖 node 路径
  const mammoth = await import("mammoth");
  const buf = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  // mammoth.value 是 HTML 字符串
  return (result && (result as any).value) || "";
}

/**
 * 把任意 HTML 转成 Tiptap JSON 字符串
 * （与 importService.convertToTiptapJson 等价，但这里独立实现避免循环依赖）
 */
function htmlToTiptapJson(html: string): string {
  try {
    const json = generateJSON(html, tiptapExtensions);
    return JSON.stringify(json);
  } catch {
    return html;
  }
}

/**
 * 把 markdown 文本转成 Tiptap JSON 字符串
 */
function markdownToTiptapJson(md: string): string {
  const html = markdownToSimpleHtml(md);
  return htmlToTiptapJson(html);
}

/**
 * 提取 HTML 标题（沿用 importService 思路：title → h1/h2 → 文件名）
 */
function extractHtmlTitle(html: string, fallback: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1].trim()) {
    return titleMatch[1].trim();
  }
  const headingMatch = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (headingMatch && headingMatch[1].trim()) {
    return headingMatch[1].replace(/<[^>]+>/g, "").trim();
  }
  return fallback;
}

/**
 * 去文件扩展名
 */
function stripExt(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

/**
 * 生成附件占位笔记的 HTML 卡片
 * 与编辑器现有渲染保持兼容：用 <p><a href="..."> 包裹，附文件大小说明
 */
function buildAttachmentCardHtml(
  fileName: string,
  attachmentUrl: string,
  size: number,
): string {
  const safeName = fileName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const sizeText = formatFileSize(size);
  return [
    `<p><strong>📎 ${safeName}</strong></p>`,
    `<p><a href="${attachmentUrl}" target="_blank" rel="noopener">下载文件</a> · ${sizeText}</p>`,
    `<p><em>从有道云笔记导入</em></p>`,
  ].join("");
}

// ============================================================
// 导入主流程
// ============================================================

export interface YoudaoImportOptions {
  /** 用户在 UI 输入的根笔记本名（默认 "有道云笔记"） */
  rootName: string;
  /** 进度回调 */
  onProgress?: (p: ImportProgress) => void;
}

/**
 * 把扫描结果变成「文本笔记」与「附件」两组任务，分别处理。
 */
export async function runYoudaoImport(
  scan: YoudaoScanResult,
  options: YoudaoImportOptions,
): Promise<{ success: boolean; noteCount: number; attachmentCount: number; errors: string[] }> {
  const onProgress = options.onProgress;
  const rootName = (options.rootName || "").trim() || "有道云笔记";

  const selected = scan.entries.filter((e) => e.selected && e.kind !== "skipped");

  const textNoteKinds: YoudaoEntryKind[] = [
    "note-md",
    "note-txt",
    "note-html",
    "note-docx",
    "note-bookmark",
    "note-failure-notice",
  ];
  const textTasks = selected.filter((e) => textNoteKinds.includes(e.kind));
  const attachmentTasks = selected.filter((e) => e.kind === "attachment" || e.kind === "image");

  const errors: string[] = [];
  let noteCount = 0;
  let attachmentCount = 0;
  const total = textTasks.length + attachmentTasks.length;
  let done = 0;

  // ---------- 阶段 1：文本笔记（一次 importNotes 批量提交） ----------
  if (textTasks.length > 0) {
    onProgress?.({
      phase: "reading",
      current: 0,
      total,
      message: "正在解析笔记文件...",
    });

    const fileInfos: ImportFileInfo[] = [];
    for (let i = 0; i < textTasks.length; i++) {
      const e = textTasks[i];
      try {
        let title = stripExt(e.fileName);
        let content: string;
        const notebookPath = rebuildNotebookPath(e.relPath, rootName);

        if (e.kind === "note-md" || e.kind === "note-txt") {
          const text = await e.file.text();
          if (e.kind === "note-txt") {
            // 以代码块形式保留原始格式，避免 marked 把 url/列表样式误解析
            content = htmlToTiptapJson(textToParagraphs(text));
          } else {
            content = markdownToTiptapJson(text);
          }
        } else if (e.kind === "note-bookmark") {
          const text = await e.file.text();
          if (isNetscapeBookmark(text)) {
            const md = bookmarksHtmlToMarkdown(text);
            content = markdownToTiptapJson(md || `# ${title}\n\n（无书签内容）`);
          } else {
            // 名字像书签但内容不是 → 退化为普通 html
            const cleaned = stripHtmlBoilerplate(text);
            title = extractHtmlTitle(text, title);
            content = htmlToTiptapJson(cleaned);
          }
        } else if (e.kind === "note-html") {
          const text = await e.file.text();
          if (isNetscapeBookmark(text)) {
            // 没有 bookmarks 关键字但内容是 Netscape → 当书签处理
            const md = bookmarksHtmlToMarkdown(text);
            content = markdownToTiptapJson(md || `# ${title}\n\n（无书签内容）`);
          } else {
            const cleaned = stripHtmlBoilerplate(text);
            title = extractHtmlTitle(text, title);
            content = htmlToTiptapJson(cleaned);
          }
        } else if (e.kind === "note-docx") {
          const html = await docxToHtml(e.file);
          content = htmlToTiptapJson(html || `<p>（docx 内容为空）</p>`);
        } else if (e.kind === "note-failure-notice") {
          const text = await e.file.text();
          // 把它转成一篇说明笔记，方便用户检索
          title = "【有道导入说明】导出失败的文档列表";
          content = htmlToTiptapJson(textToParagraphs(text));
        } else {
          continue;
        }

        fileInfos.push({
          name: e.relPath,
          title,
          content: "", // 占位，下面再填（importService.convertToTiptapJson 会再加工，但我们这里已经直接给 JSON）
          size: e.size,
          selected: true,
          source: "html", // 让 importService 把 content 当 html 传过去（其实下面我们直接绕过 importNotes 用裸 API）
          notebookPath,
        });
        // 重新塞入 content（绕过 importService 的二次转换）—— 我们要把已经是 Tiptap JSON 的字符串直接给后端
        fileInfos[fileInfos.length - 1].content = content;
      } catch (err) {
        errors.push(`${e.relPath}: ${(err as Error).message}`);
      } finally {
        done++;
        onProgress?.({
          phase: "reading",
          current: done,
          total,
          message: `解析中 ${done}/${total}`,
        });
      }
    }

    // 直接走 api.importNotes（绕过 importService.importNotes 的 source 转换；
    // 我们已经把 content 准备成 Tiptap JSON 字符串了）
    if (fileInfos.length > 0) {
      onProgress?.({
        phase: "uploading",
        current: done,
        total,
        message: `正在上传 ${fileInfos.length} 篇笔记...`,
      });
      try {
        const payload = fileInfos.map((f) => ({
          title: f.title,
          content: f.content,
          contentText: stripTagsForIndex(f.content),
          notebookPath: f.notebookPath,
          notebookName:
            f.notebookPath && f.notebookPath.length > 0
              ? f.notebookPath[f.notebookPath.length - 1]
              : undefined,
        }));
        const res = await api.importNotes(payload);
        if (res.success) {
          noteCount += res.count;
        } else {
          errors.push("批量上传文本笔记失败");
        }
      } catch (err) {
        errors.push(`批量上传失败: ${(err as Error).message}`);
      }
    }
  }

  // ---------- 阶段 2：附件文件（每个文件一篇占位笔记 + upload + 回填正文） ----------
  for (let i = 0; i < attachmentTasks.length; i++) {
    const e = attachmentTasks[i];
    onProgress?.({
      phase: "uploading",
      current: done + i,
      total,
      message: `上传附件 ${i + 1}/${attachmentTasks.length}: ${e.fileName}`,
    });

    try {
      const notebookPath = rebuildNotebookPath(e.relPath, rootName);
      const title = stripExt(e.fileName) || e.fileName;

      // 1) 创建占位笔记
      const placeholderHtml = `<p>正在上传附件 <strong>${e.fileName}</strong>...</p>`;
      const placeholderJson = htmlToTiptapJson(placeholderHtml);
      const createRes = await api.importNotes([
        {
          title,
          content: placeholderJson,
          contentText: title,
          notebookPath,
          notebookName: notebookPath[notebookPath.length - 1],
        },
      ]);

      if (!createRes.success || !createRes.notes || createRes.notes.length === 0) {
        errors.push(`${e.relPath}: 创建占位笔记失败`);
        continue;
      }
      const noteId = createRes.notes[0].id;

      // 2) 上传附件
      // 浏览器对带特殊字符的 file.name 在 FormData 里通常没问题，但部分后端 multer
      // 在解析 filename* 时有边界问题；保险起见用一个保留扩展名的稳定名字
      const safeName = sanitizeFileName(e.fileName);
      const blob = new File([e.file], safeName, {
        type: e.file.type || getMimeByExt(e.fileName),
      });
      const upRes = await api.attachments.upload(noteId, blob);

      if (!upRes || !upRes.url) {
        errors.push(`${e.relPath}: 附件上传无返回`);
        continue;
      }

      // 3) 回填正文
      const isImg = e.kind === "image";
      const finalHtml = isImg
        ? `<p><img src="${upRes.url}" alt="${e.fileName}" /></p>`
        : buildAttachmentCardHtml(e.fileName, upRes.url, e.size);
      const finalJson = htmlToTiptapJson(finalHtml);
      // H4 乐观锁：后端对 title/content/contentText 三类内容更新强制要求 version 字段，
      // 占位笔记是上一行 importNotes 刚 INSERT 出来的，notes.version DEFAULT 1，
      // 这里直接传 1 即可。漏传会被 400 VERSION_REQUIRED 拒掉，导致整个附件链路失败
      // （历史 bug：仅含附件的有道云笔记导入永远 0 成功 1 失败）。
      // 优先用占位笔记返回的 version，没有就兜底 1。
      const placeholderVersion =
        typeof createRes.notes[0]?.version === "number" ? createRes.notes[0].version : 1;
      await api.updateNote(noteId, {
        content: finalJson,
        contentText: e.fileName,
        version: placeholderVersion,
      });

      attachmentCount++;
      noteCount++; // 占位笔记本身也算一篇笔记
    } catch (err) {
      errors.push(`${e.relPath}: ${(err as Error).message}`);
    }
  }

  onProgress?.({
    phase: errors.length > 0 ? "error" : "done",
    current: total,
    total,
    message:
      errors.length > 0
        ? `完成（${errors.length} 条失败）`
        : `成功导入 ${noteCount} 篇笔记 + ${attachmentCount} 个附件`,
  });

  return {
    success: errors.length === 0 || noteCount + attachmentCount > 0,
    noteCount,
    attachmentCount,
    errors,
  };
}

// ============================================================
// helpers
// ============================================================

/**
 * 重新算 notebookPath：splitRelPath 在扫描阶段已经算过一次，但
 * 用户可能在 UI 里改了 rootName，这里重算保证一致。
 */
function rebuildNotebookPath(relPath: string, rootName: string): string[] {
  const r = splitRelPath(relPath, rootName);
  return r.notebookPath;
}

/**
 * 把纯文本切成 <p>...</p> 段落，转义特殊字符
 */
function textToParagraphs(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;"),
    )
    .map((line) => `<p>${line}</p>`)
    .join("");
}

/**
 * 提取 HTML body 内容并去掉 script/style/head/注释
 */
function stripHtmlBoilerplate(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<head[\s\S]*?<\/head>/gi, "");
  const m = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m) s = m[1];
  // 去掉 div 包装与各种 data/style 属性
  s = s.replace(/\s+style="[^"]*"/gi, "");
  s = s.replace(/\s+class="[^"]*"/gi, "");
  s = s.replace(/\s+id="[^"]*"/gi, "");
  return s.trim();
}

/**
 * 提取笔记纯文本（用于 contentText 检索索引）
 * 简单粗暴：剥掉所有标签 + 折叠空白
 */
function stripTagsForIndex(jsonOrHtml: string): string {
  // 如果是 Tiptap JSON 字符串，先尝试提取所有 text 字段
  if (jsonOrHtml.startsWith("{") && jsonOrHtml.includes('"type"')) {
    try {
      const obj = JSON.parse(jsonOrHtml);
      const out: string[] = [];
      const visit = (n: any) => {
        if (!n) return;
        if (typeof n.text === "string") out.push(n.text);
        if (Array.isArray(n.content)) n.content.forEach(visit);
      };
      visit(obj);
      return out.join(" ").replace(/\s+/g, " ").trim();
    } catch {
      // fall through
    }
  }
  return jsonOrHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 清洗文件名（用于上传到后端）
 * - 去掉路径分隔符
 * - 折叠空白
 * - 保留扩展名
 */
function sanitizeFileName(name: string): string {
  const last = name.split(/[/\\]/).pop() || name;
  const cleaned = last.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, "_");
  return cleaned || "file";
}

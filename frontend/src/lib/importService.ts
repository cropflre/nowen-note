import { api } from "./api";
import i18n from "i18next";

export interface ImportFileInfo {
  name: string;
  title: string;
  content: string;
  size: number;
  selected: boolean;
  source?: string; // 来源标识: "md" | "txt" | "html" | "xiaomi" | "oppo" | "vivo" | "oneplus"
}

export type ImportProgress = {
  phase: "reading" | "uploading" | "done" | "error";
  current: number;
  total: number;
  message: string;
};

// 支持的文件扩展名
const SUPPORTED_EXTENSIONS = [".md", ".txt", ".markdown", ".html", ".htm"];

function isSupportedFile(name: string): boolean {
  return SUPPORTED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
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
export async function readMarkdownFiles(
  files: FileList | File[]
): Promise<ImportFileInfo[]> {
  const result: ImportFileInfo[] = [];
  const fileArray = Array.from(files);

  for (const file of fileArray) {
    if (!isSupportedFile(file.name)) continue;

    const text = await file.text();
    const fileNameTitle = file.name.replace(/\.(md|txt|markdown|html|htm)$/i, "");

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
      });
    } else {
      result.push({
        name: file.name,
        title: fileNameTitle,
        content: text,
        size: file.size,
        selected: true,
        source: file.name.endsWith(".txt") ? "txt" : "md",
      });
    }
  }

  return result;
}

// 从 ZIP 文件中读取笔记
export async function readMarkdownFromZip(file: File): Promise<ImportFileInfo[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(file);
  const result: ImportFileInfo[] = [];

  for (const [path, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    if (!isSupportedFile(path)) continue;
    if (path === "metadata.json") continue;
    // 跳过 macOS 资源文件
    if (path.includes("__MACOSX") || path.startsWith(".")) continue;

    const text = await zipEntry.async("text");
    const fileName = path.split("/").pop() || path;
    const fileNameTitle = fileName.replace(/\.(md|txt|markdown|html|htm)$/i, "");

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
      });
    } else {
      result.push({
        name: path,
        title: fileNameTitle,
        content: text,
        size: text.length,
        selected: true,
        source: fileName.endsWith(".txt") ? "txt" : "md",
      });
    }
  }

  return result;
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

// 将 Markdown 转为简单的 HTML（用于存储到 Tiptap 格式）
function markdownToSimpleHtml(md: string): string {
  // 去除 YAML frontmatter
  let content = md.replace(/^---[\s\S]*?---\n*/m, "");

  // 基本的 Markdown → HTML 转换
  content = content
    // 标题
    .replace(/^######\s+(.+)$/gm, "<h6>$1</h6>")
    .replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>")
    .replace(/^####\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
    .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
    // 粗体和斜体
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // 删除线
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    // 高亮
    .replace(/==(.+?)==/g, "<mark>$1</mark>")
    // 行内代码
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // 待办列表
    .replace(/^- \[x\]\s+(.+)$/gm, '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><div>$1</div></li></ul>')
    .replace(/^- \[ \]\s+(.+)$/gm, '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div>$1</div></li></ul>')
    // 无序列表
    .replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>")
    // 有序列表
    .replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>")
    // 链接
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // 图片
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
    // 水平线
    .replace(/^---$/gm, "<hr />")
    // 段落（将非 HTML 行包裹在 <p> 中）
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("<")) return trimmed;
      return `<p>${trimmed}</p>`;
    })
    .filter(Boolean)
    .join("\n");

  return content;
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

// 根据来源转换内容为 HTML
function convertToHtml(fileInfo: ImportFileInfo): string {
  const { content, source } = fileInfo;

  switch (source) {
    case "html":
    case "xiaomi":
    case "oppo":
    case "vivo":
    case "oneplus":
      return cleanHtmlContent(content);
    case "txt":
      return textToHtml(content);
    case "md":
    default:
      return markdownToSimpleHtml(content);
  }
}

// 提取纯文本用于搜索索引
function extractPlainText(fileInfo: ImportFileInfo): string {
  const { content, source } = fileInfo;

  if (source === "html" || source === "xiaomi" || source === "oppo" || source === "vivo" || source === "oneplus") {
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
    .replace(/^---[\s\S]*?---\n*/m, "")
    .replace(/[#*_~`\[\]()>|-]/g, "")
    .trim();
}

// 执行导入
export async function importNotes(
  fileInfos: ImportFileInfo[],
  notebookId?: string,
  onProgress?: (p: ImportProgress) => void
): Promise<{ success: boolean; count: number }> {
  const selected = fileInfos.filter((f) => f.selected);

  if (selected.length === 0) {
    onProgress?.({ phase: "error", current: 0, total: 0, message: i18n.t('dataManager.noFilesSelected') });
    return { success: false, count: 0 };
  }

  try {
    onProgress?.({ phase: "uploading", current: 0, total: selected.length, message: i18n.t('dataManager.uploadingProgress') });

    const notes = selected.map((f) => {
      const note: { title: string; content: string; contentText: string; createdAt?: string; updatedAt?: string } = {
        title: f.title,
        content: convertToHtml(f),
        contentText: extractPlainText(f),
      };
      // 对 Markdown 文件尝试提取 frontmatter 中的日期
      if (f.source === "md" || !f.source) {
        const dates = extractFrontmatterDates(f.content);
        if (dates.createdAt) note.createdAt = dates.createdAt;
        if (dates.updatedAt) note.updatedAt = dates.updatedAt;
      }
      return note;
    });

    const result = await api.importNotes(notes, notebookId);

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

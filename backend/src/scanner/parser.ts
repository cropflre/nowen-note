/**
 * scanner/parser.ts — Frontmatter + body 解析器
 *
 * 解析 Markdown 文件中的 YAML frontmatter（`---` 包裹）
 * 和正文内容，返回结构化数据。
 */
import { v4 as uuid } from "uuid";

/** 解析后的笔记结构化数据 */
export interface ParsedNote {
  /** 文件路径（相对 MD 根目录） */
  relativePath: string;
  /** 唯一标识（来自 frontmatter id 或自动生成） */
  id: string;
  /** 笔记标题 */
  title: string;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 修改时间（ISO 8601） */
  updatedAt: string;
  /** 标签列表 */
  tags: string[];
  /** 别名列表 */
  aliases: string[];
  /** 笔记本路径（如 "编程/TypeScript"） */
  notebook: string | null;
  /** 是否置顶 */
  pinned: boolean;
  /** 是否归档 */
  archived: boolean;
  /** 来源 URL */
  source: string;
  /** AI 摘要 */
  summary: string;
  /** 正文 Markdown（不含 frontmatter） */
  body: string;
  /** 全文纯文本（去除 Markdown 格式，供 FTS5 索引） */
  contentText: string;
  /** 文件 SHA256 */
  sha256: string;
  /** 原始 frontmatter 对象（未识别的字段也保留） */
  rawFrontmatter: Record<string, unknown>;
}

/** frontmatter 解析结果 */
interface FrontmatterResult {
  attrs: Record<string, unknown>;
  body: string;
  raw: string; // 原始 YAML 字符串
}

/**
 * 解析 YAML frontmatter
 * 标准格式:
 *   ---
 *   key: value
 *   ---
 *   正文...
 */
function parseFrontmatter(content: string): FrontmatterResult {
  const attrs: Record<string, unknown> = {};
  let body = content;
  let raw = "";

  const trimmed = content.trimStart();
  if (trimmed.startsWith("---")) {
    const endIndex = trimmed.indexOf("---", 3);
    if (endIndex !== -1) {
      raw = trimmed.slice(3, endIndex).trim();
      body = trimmed.slice(endIndex + 3).trimStart();
      // 简单 YAML 解析（只处理标量、数组、嵌套级别1的对象）
      for (const line of raw.split("\n")) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith("#")) continue;
        const colonIdx = trimmedLine.indexOf(":");
        if (colonIdx === -1) continue;
        const key = trimmedLine.slice(0, colonIdx).trim();
        let value: unknown = trimmedLine.slice(colonIdx + 1).trim();

        // 数组: [a, b, c]
        if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
          value = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        }
        // 布尔值
        else if (value === "true") value = true;
        else if (value === "false") value = false;
        // 空值
        else if (value === "" || value === "null" || value === "~") value = null;
        // 去掉引号
        else if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        } else if (typeof value === "string" && value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }

        // 多行数组（缩进的 - item 格式）
        if (value === null || value === "") {
          // 尝试读取下面的缩进行
          // 简化处理: 跳过多行 YAML
        }

        if (key) attrs[key] = value;
      }
    }
  }

  return { attrs, body, raw };
}

/**
 * 将 Markdown 正文转为纯文本（去除 markdown 格式）
 */
function markdownToPlainText(md: string): string {
  return md
    // 移除代码块
    .replace(/```[\s\S]*?```/g, "")
    // 移除行内代码
    .replace(/`[^`]+`/g, "")
    // 移除图片 ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    // 移除链接 [text](url) → text
    .replace(/\[([^\]]*)\]\([^)]+\)/g, "$1")
    // 移除 Markdown 标题标记
    .replace(/^#{1,6}\s+/gm, "")
    // 移除粗斜体
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    // 移除 > 引用标记
    .replace(/^>\s+/gm, "")
    // 移除列表标记
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    // 移除分隔线
    .replace(/^---+\s*$/gm, "")
    // 移除 HTML 标签
    .replace(/<[^>]+>/g, "")
    // 移除双链标记 [[Title]] → Title
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    // 移除 frontmatter 中已经包含的内联标签标记
    .replace(/#([\u4e00-\u9fff\w/-]+)/g, "$1")
    // 合并空白
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 解析 Markdown 文件内容
 */
export function parseMarkdown(
  content: string,
  relativePath: string,
  sha256: string,
): ParsedNote {
  const { attrs, body } = parseFrontmatter(content);

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  // 从 frontmatter 提取字段
  const id = (attrs.id as string) || uuid();
  const title =
    (attrs.title as string) ||
    filenameToTitle(relativePath);
  const createdAt = normalizeDate(attrs.created as string) || now;
  const updatedAt = normalizeDate(attrs.updated as string) || now;
  const tags = parseTags(attrs, body);
  const aliases = parseArrayField(attrs.aliases);
  const notebook = (attrs.notebook as string) || inferNotebook(relativePath);
  const pinned = attrs.pinned === true;
  const archived = attrs.archived === true;
  const source = (attrs.source as string) || "";
  const summary = (attrs.summary as string) || "";

  return {
    relativePath,
    id,
    title,
    createdAt,
    updatedAt,
    tags,
    aliases,
    notebook,
    pinned,
    archived,
    source,
    summary,
    body,
    contentText: markdownToPlainText(body),
    sha256,
    rawFrontmatter: attrs,
  };
}

/**
 * 从文件名推测标题
 */
function filenameToTitle(relativePath: string): string {
  const filename = relativePath.split("/").pop() || relativePath;
  const lastDot = filename.lastIndexOf(".");
  if (lastDot > 0) return filename.slice(0, lastDot);
  return filename;
}

/**
 * 从相对路径推测 notebook
 * 示例: "02-知识库/编程/TypeScript/类型系统.md" → "编程/TypeScript"
 */
function inferNotebook(relativePath: string): string | null {
  const parts = relativePath.split("/");
  // 去掉文件名
  parts.pop();
  if (parts.length === 0) return null;
  // 去掉 NN- 前缀
  const cleaned = parts.map((p) => p.replace(/^\d{2,3}-/, ""));
  return cleaned.join("/");
}

/**
 * 从 frontmatter 和正文中提取标签
 */
function parseTags(
  attrs: Record<string, unknown>,
  body: string,
): string[] {
  const tags = new Set<string>();

  // 1. 从 frontmatter tags 数组提取
  const fmTags = parseArrayField(attrs.tags);
  for (const t of fmTags) tags.add(t);

  // 2. 从 frontmatter tag（单数）提取
  if (attrs.tag && typeof attrs.tag === "string") {
    tags.add(attrs.tag);
  }

  // 3. 从正文内联 #标签 提取（不在代码块中）
  const inlineTagRegex = /(?<!\w)#([\u4e00-\u9fff\w/\\-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = inlineTagRegex.exec(body)) !== null) {
    const tag = match[1].trim();
    if (tag && tag.length < 50) {
      tags.add(tag);
    }
  }

  return [...tags];
}

/**
 * 将数组字段转为 string[]
 */
function parseArrayField(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 将日期字符串规范化为 `YYYY-MM-DD HH:mm:ss`
 */
function normalizeDate(dateStr: string | undefined): string | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return null;
  }
}

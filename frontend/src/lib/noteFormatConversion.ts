import {
  markdownToPlainText,
  markdownToTiptapJSON,
  normalizeToMarkdown,
} from "@/lib/contentFormat";

export type NoteFormatConversionTarget = "markdown" | "tiptap-json";

export const REQUEST_NOTE_FORMAT_CONVERSION_EVENT =
  "nowen:request-note-format-conversion";

export interface NoteFormatConversionRequest {
  noteId: string;
  targetFormat: NoteFormatConversionTarget;
}

const GENERATED_BLOCK_MARKER_RE =
  /[ \t]*(?:\^blk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8,12}[ \t]*)+$/gim;

function stripFrontMatter(markdown: string): string {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() === "---") {
    const closing = lines.slice(1, 80).findIndex((line) => line.trim() === "---");
    if (closing >= 0) return lines.slice(closing + 2).join("\n").replace(/^\n+/, "");
  }

  // 修复旧转换器把 YAML 头部错误转成“分隔线 + 单段文本”的历史结果。
  if (/^(?:\*\s*){3}$/.test(lines[0]?.trim() || "")) {
    const metadataIndex = lines.findIndex((line, index) => index > 0 && line.trim());
    const metadata = metadataIndex >= 0 ? lines[metadataIndex].trim() : "";
    if (/\btitle:\s*/i.test(metadata) && /\bcreated:\s*/i.test(metadata) && /\bupdated:\s*/i.test(metadata)) {
      return lines.slice(metadataIndex + 1).join("\n").replace(/^\n+/, "");
    }
  }

  return markdown;
}

function repairLegacyUnbalancedFence(markdown: string, removedMarkerCount: number): string {
  if (removedMarkerCount === 0) return markdown;
  const lines = markdown.split("\n");
  const fences = lines
    .map((line, index) => ({ index, match: line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/) }))
    .filter((entry) => entry.match) as Array<{ index: number; match: RegExpMatchArray }>;
  if (fences.length % 2 === 0 || fences.length === 0) return markdown;

  // 旧版富文本转回 Markdown 时会漏掉首个代码块的开始围栏，只留下结束围栏。
  // 仅在存在系统块标识且围栏数量为奇数时修复，避免改写用户主动输入的未闭合代码块。
  const firstFence = fences[0];
  let insertAt = firstFence.index;
  while (insertAt > 0 && lines[insertAt - 1].trim()) insertAt--;
  lines.splice(insertAt, 0, firstFence.match[1]);
  return lines.join("\n");
}

/** 转换时只保留用户内容，内部块标识由后端按内容重新复用或生成。 */
export function prepareMarkdownForFormatConversion(markdown: string): string {
  const normalized = (markdown || "").replace(/\r\n?/g, "\n");
  const removedMarkerCount = normalized.match(GENERATED_BLOCK_MARKER_RE)?.length || 0;
  GENERATED_BLOCK_MARKER_RE.lastIndex = 0;
  const withoutMarkers = normalized
    .replace(GENERATED_BLOCK_MARKER_RE, "")
    .replace(/[ \t]+$/gm, "");
  GENERATED_BLOCK_MARKER_RE.lastIndex = 0;
  return stripFrontMatter(
    repairLegacyUnbalancedFence(withoutMarkers, removedMarkerCount),
  ).trim();
}

export function getNoteFormatConversionTarget(
  contentFormat: string | null | undefined,
): NoteFormatConversionTarget {
  return contentFormat === "markdown" ? "tiptap-json" : "markdown";
}

export function convertNoteContent(
  content: string,
  contentText: string,
  targetFormat: NoteFormatConversionTarget,
) {
  const markdown = prepareMarkdownForFormatConversion(
    normalizeToMarkdown(content || "", contentText || ""),
  );
  const plainText = markdownToPlainText(markdown) || contentText || "";

  if (targetFormat === "markdown") {
    return {
      content: markdown,
      contentText: plainText,
      contentFormat: "markdown" as const,
    };
  }

  return {
    content: JSON.stringify(markdownToTiptapJSON(markdown)),
    contentText: plainText,
    contentFormat: "tiptap-json" as const,
  };
}

export function requestActiveNoteFormatConversion(
  detail: NoteFormatConversionRequest,
) {
  window.dispatchEvent(new CustomEvent(REQUEST_NOTE_FORMAT_CONVERSION_EVENT, { detail }));
}

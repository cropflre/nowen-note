import type { FileItem } from "@/types";
import { isVideoFile, toInlineAttachmentUrl } from "@/lib/mediaUploadService";

export type ExistingAttachmentInsertItem = Pick<
  FileItem,
  "category" | "filename" | "mimeType" | "size" | "url"
>;

/**
 * 文件管理中的图片应按图片节点插入，而不是退化成普通附件链接。
 * MIME 判断作为兼容兜底，覆盖旧服务端或历史数据 category 未正确归类的情况。
 */
export function isInlineImageAttachment(
  item: Pick<ExistingAttachmentInsertItem, "category" | "mimeType">,
): boolean {
  return item.category === "image" || /^image\//i.test(item.mimeType.trim());
}

/**
 * 文件管理目前只区分 image/file，视频会落在 file 分类中，因此同时根据
 * MIME 和扩展名识别，兼容浏览器未提供 MIME、旧数据 MIME 缺失等情况。
 */
export function isInlineVideoAttachment(
  item: Pick<ExistingAttachmentInsertItem, "filename" | "mimeType">,
): boolean {
  return isVideoFile({ name: item.filename || "", type: item.mimeType || "" });
}

function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`;
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\]/g, "\\]");
}

function escapeMarkdownTitle(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}

function encodeMarkdownUrl(url: string): string {
  return url.replace(/\s/g, "%20").replace(/\)/g, "%29");
}

/**
 * Markdown 编辑器从文件管理插入时：
 * - 图片生成 `![alt](url)`，预览区直接渲染图片；
 * - 视频生成 Nowen 的 `@[video](url "title")` 语法，预览区直接播放；
 * - 其他文件继续生成带大小的附件链接。
 */
export function buildExistingAttachmentMarkdownSnippet(
  item: ExistingAttachmentInsertItem,
): string {
  const label = escapeMarkdownLabel(item.filename || "attachment");
  const url = encodeMarkdownUrl(item.url);
  if (isInlineImageAttachment(item)) {
    return `![${label}](${url})`;
  }
  if (isInlineVideoAttachment(item)) {
    const previewUrl = encodeMarkdownUrl(toInlineAttachmentUrl(item.url));
    const title = escapeMarkdownTitle(item.filename || "video");
    return `\n\n@[video](${previewUrl} "${title}")\n\n`;
  }
  const sizeLabel = formatAttachmentSize(item.size);
  return `[📎 ${label}${sizeLabel ? ` (${sizeLabel})` : ""}](${url})`;
}

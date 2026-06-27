/**
 * PASTE-REMOTE-IMAGE-LOCALIZE-01: 远程图片本地化服务
 *
 * 粘贴图文时，自动把远程图片下载并上传到 nowen-note 的文件管理/附件系统，
 * 然后把正文中的图片链接替换成 nowen-note 自己的文件地址。
 *
 * 核心流程：
 *   1. 解析 HTML/Markdown 中的远程图片 URL
 *   2. 调用后端接口下载并保存远程图片
 *   3. 替换原始链接为本地附件链接
 */

import { api } from "./api";
import { toast } from "./toast";

// 本地附件 URL 模式，不需要本地化
const LOCAL_ATTACHMENT_PATTERNS = [
  /^\/api\/attachments\//,
  /^\/api\/files\//,
  /^https?:\/\/[^/]+\/api\/attachments\//,
  /^https?:\/\/[^/]+\/api\/files\//,
];

// 远程图片 URL 模式
const REMOTE_IMAGE_PATTERN = /^https?:\/\//;

// 已知的非图片扩展名（跳过）
const NON_IMAGE_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".rar", ".7z", ".tar", ".gz",
  ".mp3", ".mp4", ".avi", ".mov", ".wmv", ".flv",
  ".exe", ".bat", ".cmd", ".sh", ".ps1",
]);

export interface RemoteImageInfo {
  /** 原始 URL */
  originalUrl: string;
  /** 在 HTML 中的位置（用于替换） */
  index: number;
  /** 完整的标签（<img src="..."> 或 ![alt](url)） */
  fullMatch: string;
}

/**
 * 检查 URL 是否需要本地化
 */
export function shouldLocalizeUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;

  // 已经是本地附件，跳过
  for (const pattern of LOCAL_ATTACHMENT_PATTERNS) {
    if (pattern.test(url)) return false;
  }

  // 不是远程 URL，跳过
  if (!REMOTE_IMAGE_PATTERN.test(url)) return false;

  // 检查是否是图片扩展名
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    for (const ext of NON_IMAGE_EXTENSIONS) {
      if (pathname.endsWith(ext)) return false;
    }
  } catch {
    return false;
  }

  return true;
}

/**
 * 从 HTML 中提取远程图片 URL
 */
export function extractRemoteImageUrls(html: string): RemoteImageInfo[] {
  const results: RemoteImageInfo[] = [];
  const seen = new Set<string>();

  // 匹配 <img src="...">
  const imgTagRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = imgTagRegex.exec(html)) !== null) {
    const url = match[1];
    if (shouldLocalizeUrl(url) && !seen.has(url)) {
      seen.add(url);
      results.push({
        originalUrl: url,
        index: match.index,
        fullMatch: match[0],
      });
    }
  }

  return results;
}

/**
 * 从 Markdown 中提取远程图片 URL
 */
export function extractRemoteImageUrlsFromMarkdown(md: string): RemoteImageInfo[] {
  const results: RemoteImageInfo[] = [];
  const seen = new Set<string>();

  // 匹配 ![alt](url)
  const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = mdImageRegex.exec(md)) !== null) {
    const url = match[2].trim();
    if (shouldLocalizeUrl(url) && !seen.has(url)) {
      seen.add(url);
      results.push({
        originalUrl: url,
        index: match.index,
        fullMatch: match[0],
      });
    }
  }

  return results;
}

export interface LocalizeResult {
  /** 原始 URL */
  originalUrl: string;
  /** 本地化后的 URL */
  localUrl: string;
  /** 是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
  /** 是否去重（已存在相同图片） */
  deduplicated?: boolean;
}

/**
 * 本地化单个远程图片
 */
export async function localizeRemoteImage(
  url: string,
  noteId: string,
  source: string = "paste",
): Promise<LocalizeResult> {
  try {
    const result = await api.attachments.importRemoteImage(noteId, url, source);
    return {
      originalUrl: url,
      localUrl: result.url,
      success: true,
      deduplicated: result.deduplicated,
    };
  } catch (err: any) {
    console.error("[remoteImageLocalizer] Failed to localize:", url, err);
    return {
      originalUrl: url,
      localUrl: url, // 失败时保留原始 URL
      success: false,
      error: err?.message || "下载失败",
    };
  }
}

/**
 * 批量本地化远程图片
 *
 * 同一次粘贴中相同 URL 不会重复下载多次。
 */
export async function localizeRemoteImages(
  urls: string[],
  noteId: string,
  source: string = "paste",
  onProgress?: (completed: number, total: number) => void,
): Promise<LocalizeResult[]> {
  const results: LocalizeResult[] = [];
  const urlMap = new Map<string, LocalizeResult>();

  // 去重：相同 URL 只下载一次
  const uniqueUrls = [...new Set(urls)];

  for (let i = 0; i < uniqueUrls.length; i++) {
    const url = uniqueUrls[i];
    const result = await localizeRemoteImage(url, noteId, source);
    urlMap.set(url, result);
    results.push(result);

    if (onProgress) {
      onProgress(i + 1, uniqueUrls.length);
    }
  }

  // 把去重的结果展开回原始顺序
  return urls.map((url) => urlMap.get(url)!);
}

/**
 * 替换 HTML 中的远程图片 URL
 */
export function replaceRemoteUrlsInHtml(
  html: string,
  urlMap: Map<string, string>,
): string {
  let result = html;

  for (const [originalUrl, localUrl] of urlMap) {
    // 替换所有出现的 URL
    result = result.split(originalUrl).join(localUrl);
  }

  return result;
}

/**
 * 替换 Markdown 中的远程图片 URL
 */
export function replaceRemoteUrlsInMarkdown(
  md: string,
  urlMap: Map<string, string>,
): string {
  let result = md;

  for (const [originalUrl, localUrl] of urlMap) {
    result = result.split(originalUrl).join(localUrl);
  }

  return result;
}

/**
 * 显示本地化进度 toast
 */
export function showLocalizationToast(
  total: number,
  success: number,
  failed: number,
  deduplicated: number,
): void {
  if (total === 0) return;

  if (failed === 0) {
    const msg = deduplicated > 0
      ? `已保存 ${success} 张图片（${deduplicated} 张去重）`
      : `已保存 ${success} 张图片`;
    toast.success(msg);
  } else if (success === 0) {
    toast.error(`${failed} 张图片保存失败，已保留原链接`);
  } else {
    toast.warning(`${success} 张图片已保存，${failed} 张失败`);
  }
}

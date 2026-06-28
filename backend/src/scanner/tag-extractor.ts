/**
 * scanner/tag-extractor.ts — 标签提取器
 *
 * 从 Markdown 正文中提取 #标签
 * 排除代码块和 frontmatter 中的标签
 */
export interface ExtractedTag {
  /** 标签名 */
  name: string;
  /** 在正文中的起始位置 */
  start: number;
  /** 在正文中的结束位置 */
  end: number;
}

/**
 * 从正文中提取内联 #标签
 *
 * 规则:
 * - 中英文标签均支持: #编程, #TypeScript
 * - 层级标签: #编程/TypeScript
 * - 排除代码块中的标签
 * - 排除标题行开头的 #（Markdown 标题标记）
 * - 标签不能以数字开头（#123 不是标签）
 */
export function extractInlineTags(body: string): ExtractedTag[] {
  const tags: ExtractedTag[] = [];
  // 先移除代码块
  const cleaned = body.replace(/```[\s\S]*?```/g, " ");
  // 再移除行内代码
  const noCode = cleaned.replace(/`[^`]+`/g, " ");

  // 匹配 #标签
  // #后跟中文字符、字母、数字、/、-、_，但不能是纯数字
  const regex = /(?:^|[\s(【（,，])#([\u4e00-\u9fff\w/-]+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(noCode)) !== null) {
    const tagName = match[1];
    // 跳过纯数字标签
    if (/^\d+$/.test(tagName)) continue;
    // 跳过过长的标签
    if (tagName.length > 50) continue;
    // 跳过看起来像 URL 的 (#anchor, #section)
    if (/^[a-z-]+$/.test(tagName) && tagName.length < 3) continue;

    const fullMatchStart = match.index + match[0].indexOf("#");
    const fullMatchEnd = fullMatchStart + tagName.length + 1;

    tags.push({
      name: tagName,
      start: fullMatchStart,
      end: fullMatchEnd,
    });
  }

  return tags;
}

/**
 * 标签名规范化（统一大小写、去除首尾空白）
 */
export function normalizeTagName(name: string): string {
  return name.trim();
}

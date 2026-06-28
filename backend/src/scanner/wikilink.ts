/**
 * scanner/wikilink.ts — 双链解析器
 *
 * 解析 Markdown 正文中的 [[双链]] 语法。
 * 格式: [[Title]] 或 [[Title|显示文本]]
 */
export interface WikiLink {
  /** 目标笔记标题 */
  target: string;
  /** 显示文本（可为空，默认用 target） */
  displayText: string;
  /** 在正文中的起始位置 */
  start: number;
  /** 在正文中的结束位置 */
  end: number;
}

/**
 * 从正文中提取所有 [[双链]]
 */
export function extractWikiLinks(body: string): WikiLink[] {
  const links: WikiLink[] = [];
  // 匹配 [[...]] 但不匹配 [[]] 或 [[|]]
  const regex = /\[\[([^\]]+?)\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body)) !== null) {
    const raw = match[1];
    const start = match.index;
    const end = start + match[0].length;

    // 拆分目标与显示文本
    const pipeIdx = raw.indexOf("|");
    if (pipeIdx !== -1) {
      const target = raw.slice(0, pipeIdx).trim();
      const displayText = raw.slice(pipeIdx + 1).trim();
      if (target) {
        links.push({ target, displayText: displayText || target, start, end });
      }
    } else {
      const target = raw.trim();
      if (target) {
        links.push({ target, displayText: target, start, end });
      }
    }
  }

  return links;
}

/**
 * 规范化双链目标（统一空白、去掉首尾空格）
 */
export function normalizeLinkTarget(target: string): string {
  return target.replace(/\s+/g, " ").trim();
}

/**
 * 从一组笔记标题中查找匹配的双链目标
 */
export function resolveWikiLink(
  target: string,
  allTitles: Map<string, string>, // title → noteId
  aliases: Map<string, string>,   // alias → noteId
): string | null {
  // 1. 精确匹配标题
  const exact = allTitles.get(target);
  if (exact) return exact;

  // 2. 别名匹配
  const aliasMatch = aliases.get(target);
  if (aliasMatch) return aliasMatch;

  // 3. 不区分大小写
  const lowerTarget = target.toLowerCase();
  for (const [title, id] of allTitles) {
    if (title.toLowerCase() === lowerTarget) return id;
  }

  return null;
}

/**
 * 笔记间引用关系（note_links）维护工具
 * ---------------------------------------------------------------------------
 * 背景：
 *   BACKLINKS-01 实现了 [[note:UUID|标题]] 格式的正向引用插入。
 *   BACKLINKS-02 需要支持"反向链接查询"：给定目标笔记，找出所有引用了它的来源笔记。
 *
 *   本模块提供两个核心能力：
 *     1) extractNoteIdsFromContent(content): 从 note.content 字符串里
 *        解析出所有 [[note:UUID|标题]] 引用，去重返回 targetNoteId 集合。
 *     2) syncNoteLinks(db, userId, sourceNoteId, content): 把 note_links 表里
 *        sourceNoteId 对应的行**全量同步**到 content 当前实际引用的集合。
 *        实现：DELETE old → INSERT new（在调用方提供的 db 连接里执行）。
 *
 * 维护时机（写时维护）：
 *   - POST /api/notes        新笔记创建后 → syncNoteLinks
 *   - PUT  /api/notes/:id    笔记内容更新后 → syncNoteLinks（仅 content 变更时）
 *
 * 不维护的场景：
 *   - notes.isTrashed = 1：被丢回收站的笔记**保留**引用记录。
 *     回收站里的笔记不参与反向链接查询（API 层过滤 isTrashed=1 的来源笔记）。
 *   - Markdown 模式：当前仅解析 TipTap JSON 和 HTML 中的 [[note:...]] 格式。
 *     Markdown 编辑器暂未支持 [[ 双链，后续可扩展。
 *
 * 引用格式：
 *   - 纯文本：`[[note:UUID|标题]]`
 *   - TipTap JSON 中表现为 text node，可能带有 link mark（href: "note:UUID"）
 *   - HTML 中可能被渲染为 `<a href="note:UUID">标题</a>`
 */

import { v4 as uuid } from "uuid";
import { noteLinksRepository } from "../repositories";
import type { NoteLinkEntry } from "../repositories";

// 匹配 [[note:UUID|标题]] 和 [[note:UUID#blk:BLOCK_ID|标题 > 摘要]] 格式（纯文本形式）
// UUID 支持大小写十六进制
// #blk:BLOCK_ID 可选
const NOTE_LINK_RE = /\[\[note:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:#blk:([a-zA-Z0-9_-]+))?(?:\|([^\]]*))?\]\]/g;

// 匹配 href="note:UUID" 和 href="note:UUID#blk:BLOCK_ID" 格式（HTML/TipTap link mark 形式）
const NOTE_HREF_RE = /note:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:#blk:([a-zA-Z0-9_-]+))?/g;

/**
 * 从 note.content 字符串里解析出所有被引用的 note/block 链接。
 *
 * 兼容格式：
 *   - 笔记级纯文本：`[[note:UUID|标题]]`
 *   - 块级纯文本：`[[note:UUID#blk:BLOCK_ID|标题 > 摘要]]`
 *   - 笔记级 href：`href="note:UUID"`
 *   - 块级 href：`href="note:UUID#blk:BLOCK_ID"`
 *
 * 返回 NoteLinkEntry 数组（去重：同一 targetNoteId + targetBlockId 只保留一条）。
 */
export function extractNoteLinksFromContent(content: string): NoteLinkEntry[] {
  const seen = new Set<string>();
  const entries: NoteLinkEntry[] = [];

  const addEntry = (entry: NoteLinkEntry) => {
    const key = `${entry.targetNoteId}:${entry.targetBlockId || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  // 匹配 [[note:UUID#blk:BLOCK_ID|标题 > 摘要]] 格式
  for (const match of content.matchAll(NOTE_LINK_RE)) {
    const noteId = match[1].toLowerCase();
    const blockId = match[2] || null;
    const displayText = match[3] || null;

    addEntry({
      targetNoteId: noteId,
      targetBlockId: blockId,
      linkType: blockId ? "block" : "note",
      linkText: displayText || null,
      excerpt: blockId && displayText ? displayText : null,
    });
  }

  // 匹配 href="note:UUID#blk:BLOCK_ID" 格式（HTML/TipTap link mark）
  for (const match of content.matchAll(NOTE_HREF_RE)) {
    const noteId = match[1].toLowerCase();
    const blockId = match[2] || null;

    addEntry({
      targetNoteId: noteId,
      targetBlockId: blockId,
      linkType: blockId ? "block" : "note",
      linkText: null,
      excerpt: null,
    });
  }

  return entries;
}

/**
 * 同步 note_links 表：全量重建 sourceNoteId 的引用关系。
 *
 * 逻辑：
 *   1. DELETE FROM note_links WHERE userId = ? AND sourceNoteId = ?
 *   2. 从 content 解析出引用链接（含笔记级和块级）
 *   3. 排除自引用（笔记级）
 *   4. 过滤掉不存在的 target note
 *   5. INSERT 新的 note_links 行
 *
 * 失败仅打日志，不阻断保存（与 attachmentReferences 一致）。
 */
export function syncNoteLinks(
  _db: unknown,
  userId: string,
  sourceNoteId: string,
  content: string,
): void {
  try {
    // 1. 解析新的引用（含笔记级和块级）
    const links = extractNoteLinksFromContent(content);

    // 2. 排除笔记级自引用（块级自引用允许：引用自己的某个 heading）
    const filteredLinks = links.filter(
      (link) => !(link.targetNoteId === sourceNoteId.toLowerCase() && !link.targetBlockId)
    );

    // 3. 调用 Repository 执行 DELETE + INSERT（保持现有事务边界）
    noteLinksRepository.replaceLinksForSource(userId, sourceNoteId, filteredLinks);
  } catch (e) {
    console.warn("[syncNoteLinks] failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * 获取目标笔记的所有反向链接（来源笔记）。
 *
 * 返回结构：
 *   - sourceNoteId: 来源笔记 ID
 *   - title: 来源笔记标题
 *   - updatedAt: 来源笔记更新时间
 *   - linkText: 引用时的显示文本（可选）
 *   - linkType: 'note' 或 'block'
 *   - targetBlockId: 被引用的块 ID（可选）
 *   - excerpt: 块级引用摘要（可选）
 *
 * 排除规则：
 *   - isTrashed = 1 的来源笔记
 *   - 无权限的来源笔记（调用方应已做过权限校验）
 */
export function getBacklinks(
  _db: unknown,
  userId: string,
  targetNoteId: string,
  limit: number = 50,
): Array<{
  sourceNoteId: string;
  title: string;
  updatedAt: string;
  linkText: string | null;
  linkType: string;
  targetBlockId: string | null;
  excerpt: string | null;
}> {
  return noteLinksRepository.getBacklinks(userId, targetNoteId, limit);
}

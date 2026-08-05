import type Database from "better-sqlite3";

export interface MarkdownNoteForProjection {
  id: string;
  content: string;
  contentFormat: string;
  [key: string]: unknown;
}

const CURRENT_BLOCK_ID = String.raw`blk_[A-Za-z0-9_-]{6,}`;
const STRICT_GENERATED_BLOCK_ID = String.raw`blk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8,12}`;
// v1.4.5 及更早版本、部分导入器曾写入无下划线的 32 位十六进制块 ID。
// 该格式足够严格，可以在没有 note_blocks_index 记录时安全识别为内部元数据。
const LEGACY_COMPACT_BLOCK_ID = String.raw`blk[0-9a-f]{32}`;
const MARKER_BLOCK_ID = String.raw`(?:${CURRENT_BLOCK_ID}|${LEGACY_COMPACT_BLOCK_ID})`;
const STRICT_INTERNAL_BLOCK_ID = String.raw`(?:${STRICT_GENERATED_BLOCK_ID}|${LEGACY_COMPACT_BLOCK_ID})`;

const INLINE_MARKER_RE = new RegExp(String.raw`[ \t]+\^(${MARKER_BLOCK_ID})[ \t]*$`, "i");
const LINE_MARKER_RE = new RegExp(String.raw`^[ \t]*\^(${MARKER_BLOCK_ID})[ \t]*$`, "i");
const ATTACHED_STRICT_MARKER_RE = new RegExp(String.raw`\^(${STRICT_INTERNAL_BLOCK_ID})[ \t]*$`, "i");
const LEGACY_PREFIX_MARKER_RE = new RegExp(String.raw`^[ \t]*\^(${LEGACY_COMPACT_BLOCK_ID})[ \t]+`, "i");
const LEGACY_COMPACT_BLOCK_ID_RE = new RegExp(String.raw`^${LEGACY_COMPACT_BLOCK_ID}$`, "i");
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

function isLegacyCompactBlockId(blockId: string): boolean {
  return LEGACY_COMPACT_BLOCK_ID_RE.test(blockId);
}

function shouldRemoveBlockId(
  blockId: string,
  knownBlockIds?: ReadonlySet<string>,
): boolean {
  // 旧版紧凑 ID 不再属于当前块身份体系，始终作为历史内部元数据清理。
  if (isLegacyCompactBlockId(blockId)) return true;
  return !knownBlockIds || knownBlockIds.has(blockId);
}

/**
 * Remove reserved block markers from a user-facing Markdown projection.
 *
 * Current-format markers are removed only when they belong to the note index
 * (unless no index set is supplied). Strict legacy compact IDs are always
 * removed because old clients/importers persisted them as hidden metadata.
 * Fenced code remains byte-for-byte unchanged.
 */
export function projectMarkdownForUser(
  markdown: string,
  knownBlockIds?: ReadonlySet<string>,
): string {
  if (!markdown || !markdown.includes("^blk")) return markdown;
  const removals: Array<{ from: number; to: number }> = [];
  let offset = 0;
  let fenceChar = "";
  let fenceLength = 0;

  while (offset <= markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const lineEnd = newline < 0 ? markdown.length : newline;
    const lineEndWithNewline = newline < 0 ? markdown.length : newline + 1;
    const line = markdown.slice(offset, lineEnd);

    if (fenceChar) {
      const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLength},}[ \\t]*$`);
      if (closeRe.test(line)) {
        fenceChar = "";
        fenceLength = 0;
      }
    } else {
      const opener = line.match(FENCE_OPEN_RE);
      if (opener) {
        fenceChar = opener[1][0];
        fenceLength = opener[1].length;
      } else {
        const standalone = line.match(LINE_MARKER_RE);
        if (standalone && shouldRemoveBlockId(standalone[1], knownBlockIds)) {
          removals.push({ from: offset, to: lineEndWithNewline });
        } else {
          const inline = line.match(INLINE_MARKER_RE);
          if (
            inline
            && inline.index != null
            && shouldRemoveBlockId(inline[1], knownBlockIds)
          ) {
            removals.push({ from: offset + inline.index, to: lineEnd });
          } else {
            // 严格系统 ID 即使前导空格被历史编辑器误删，也不能暴露给用户。
            const attached = line.match(ATTACHED_STRICT_MARKER_RE);
            if (
              attached
              && attached.index != null
              && shouldRemoveBlockId(attached[1], knownBlockIds)
            ) {
              removals.push({ from: offset + attached.index, to: lineEnd });
            } else {
              // 少量历史导入文件把紧凑块 ID 放在行首，后面紧跟正文。
              const prefix = line.match(LEGACY_PREFIX_MARKER_RE);
              if (prefix) {
                removals.push({ from: offset, to: offset + prefix[0].length });
              }
            }
          }
        }
      }
    }

    if (newline < 0) break;
    offset = lineEndWithNewline;
  }

  let output = markdown;
  for (const removal of removals.sort((a, b) => b.from - a.from)) {
    output = output.slice(0, removal.from) + output.slice(removal.to);
  }
  return output;
}

/**
 * Remove only obsolete compact block markers before Markdown is re-indexed.
 * Current-format block identity is preserved and will continue to be managed by
 * note_blocks_index.
 */
export function stripLegacyInternalMarkdownMarkers(markdown: string): string {
  return projectMarkdownForUser(markdown, new Set<string>());
}

export function projectMarkdownNoteForUser<T extends MarkdownNoteForProjection>(
  db: Database.Database,
  note: T,
): T {
  if (!note || note.contentFormat !== "markdown" || typeof note.content !== "string") return note;
  try {
    const rows = db.prepare(
      "SELECT blockId FROM note_blocks_index WHERE noteId = ?",
    ).all(note.id) as Array<{ blockId: string }>;
    const known = new Set(rows.map((row) => row.blockId));
    const content = projectMarkdownForUser(note.content, known);
    return content === note.content ? note : { ...note, content };
  } catch {
    // 老库在块索引表建立前也要隐藏严格的历史紧凑标记。
    const content = stripLegacyInternalMarkdownMarkers(note.content);
    return content === note.content ? note : { ...note, content };
  }
}

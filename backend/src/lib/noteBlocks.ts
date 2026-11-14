import { withEncryptedBlockWrite } from "./encryptedBlockWrites.js";
import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import type Database from "better-sqlite3";
import { stripLegacyInternalMarkdownMarkers } from "./markdownUserContent";
import { isEncryptedBlockLanguage } from "./encryptedNotes.js";

export const SUPPORTED_NOTE_BLOCK_TYPES = [
  "heading",
  "paragraph",
  "listItem",
  "taskItem",
  "blockquote",
  "codeBlock",
  "table",
  "video",
  "blockEmbed",
  "mathBlock",
] as const;

export type NoteBlockType = typeof SUPPORTED_NOTE_BLOCK_TYPES[number];

export interface NoteBlockIndexRow {
  noteId: string;
  blockId: string;
  blockType: NoteBlockType;
  parentBlockId: string | null;
  blockOrder: number;
  plainText: string;
  contentHash: string;
  path: string;
  startOffset: number | null;
  endOffset: number | null;
  createdAt?: string;
  updatedAt?: string;
}

interface BlockCandidate extends Omit<NoteBlockIndexRow, "blockId"> {
  blockId: string | null;
  explicitBlockId: boolean;
  markerInsertOffset?: number;
  markerStyle?: "inline" | "standalone";
}

const SUPPORTED = new Set<string>(SUPPORTED_NOTE_BLOCK_TYPES);
const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const MARKDOWN_BLOCK_ID_RE = /(?:\s+|^)(\^blk_[A-Za-z0-9_-]{6,})\s*$/;
const GENERATED_MARKDOWN_BLOCK_ID = String.raw`blk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8,12}`;
const GENERATED_MARKER_LINE_RE = new RegExp(String.raw`^[ \t]*\^(${GENERATED_MARKDOWN_BLOCK_ID})[ \t]*$`, "i");
const ATTACHED_GENERATED_MARKER_RE = new RegExp(String.raw`^(.*\S)\^(${GENERATED_MARKDOWN_BLOCK_ID})[ \t]*$`, "i");
const TRAILING_GENERATED_MARKER_RE = new RegExp(String.raw`^(.*\S)[ \t]*\^(${GENERATED_MARKDOWN_BLOCK_ID})[ \t]*$`, "i");
const STANDALONE_MARKER_RE = /^[ \t]*\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$/;
// CommonMark 分隔线（---、***、- - -）没有文本也不带 ID：行尾加标记会让它变成普通段落
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
// 紧跟段落的 setext 下划线：上面的段落是标题，ID 写在文字行上
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
// GFM 表格分隔行（与 @lezer/markdown 相同）
const TABLE_DELIMITER_RE = /^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;
// 编辑器转 Markdown 时保留为 HTML 的块：pre/script/style 到结束标签为止，其余到空行为止（CommonMark HTML 块）
const HTML_BLOCK_OPEN_RE = /^ {0,3}<(pre|script|style|details|div|table|section|article|iframe|video|audio|p|h[1-6])(?=[\s>/])/i;
const HTML_BLOCK_ID_RE = /^ {0,3}<[a-z][\w-]*\b[^>]*?\sdata-block-id="(blk_[A-Za-z0-9_-]{6,})"/i;
// 块级公式的开始/结束行：与代码块相同，ID 独占一行写在结束 `$$` 之后，写在行尾它就不再是结束行
const MATH_FENCE_RE = /^ {0,3}\$\$[ \t]*$/;
const LEGACY_MATH_CLOSE_RE = new RegExp(String.raw`^( {0,3}\$\$)[ \t]+\^(${GENERATED_MARKDOWN_BLOCK_ID})[ \t]*$`, "i");

/** GFM 表格行的单元格：按未转义的「|」切分，忽略行首行尾可选的「|」。 */
function tableCells(line: string): string[] {
  const text = line.trim();
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) { cell += text[i] + text[i + 1]; i++; continue; }
    if (text[i] === "|") { cells.push(cell); cell = ""; continue; }
    cell += text[i];
  }
  cells.push(cell);
  if (text.startsWith("|")) cells.shift();
  if (/(?<!\\)\|$/.test(text)) cells.pop();
  return cells.map((value) => value.trim());
}

function isTableStart(lines: Array<{ text: string }>, index: number): boolean {
  const header = lines[index]?.text;
  const delimiter = lines[index + 1]?.text.trim();
  return Boolean(header && delimiter) && classifyMarkdownLine(header) === "paragraph" && /(?<!\\)\|/.test(header)
    && TABLE_DELIMITER_RE.test(delimiter) && tableCells(header).length === tableCells(delimiter).length;
}

function htmlPlainText(raw: string): string {
  return raw.replace(/<[^>]*>/g, " ")
    .replace(/&#10;/g, "\n").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

function makeBlockId(): string {
  return `blk_${uuid()}`;
}

function hashText(type: string, text: string): string {
  return createHash("sha256")
    .update(type)
    .update("\0")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("hex");
}

function collectNodeText(node: any): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "codeBlock" && isEncryptedBlockLanguage(node.attrs?.language)) return "";
  if (node.type === "text") return String(node.text || "");
  if (node.type === "hardBreak") return "\n";
  if (!Array.isArray(node.content)) return "";
  return node.content.map(collectNodeText).join("");
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
}

function parseTiptap(noteId: string, content: string): {
  normalizedContent: string;
  candidates: BlockCandidate[];
  changed: boolean;
} {
  let doc: any;
  try {
    doc = JSON.parse(content || "{}");
  } catch {
    return { normalizedContent: content, candidates: [], changed: false };
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.content)) {
    return { normalizedContent: content, candidates: [], changed: false };
  }

  const seen = new Set<string>();
  const candidates: BlockCandidate[] = [];
  let order = 0;
  let changed = false;

  const visit = (nodes: any[], parentBlockId: string | null, path: number[]) => {
    nodes.forEach((node, index) => {
      if (!node || typeof node !== "object") return;
      const currentPath = [...path, index];
      let nextParent = parentBlockId;

      if (SUPPORTED.has(node.type)) {
        const attrs = node.attrs && typeof node.attrs === "object" ? { ...node.attrs } : {};
        let blockId = validBlockId(attrs.blockId) ? attrs.blockId : null;
        if (!blockId || seen.has(blockId)) {
          blockId = makeBlockId();
          attrs.blockId = blockId;
          node.attrs = attrs;
          changed = true;
        }
        seen.add(blockId);
        const plainText = collectNodeText(node).replace(/\u0000/g, "").trim();
        candidates.push({
          noteId,
          blockId,
          explicitBlockId: true,
          blockType: node.type as NoteBlockType,
          parentBlockId,
          blockOrder: order++,
          plainText,
          contentHash: hashText(node.type, node.type === "codeBlock" && isEncryptedBlockLanguage(node.attrs?.language) ? JSON.stringify(node.content) : plainText),
          path: currentPath.join("."),
          startOffset: null,
          endOffset: null,
        });
        nextParent = blockId;
      }

      if (Array.isArray(node.content)) visit(node.content, nextParent, currentPath);
    });
  };

  visit(doc.content, null, []);
  const normalizedContent = changed ? JSON.stringify(doc) : content.trim();
  return {
    normalizedContent,
    candidates,
    changed: changed || normalizedContent !== content,
  };
}

function lineOffsets(content: string): Array<{ text: string; start: number; end: number; endWithNewline: number }> {
  const lines: Array<{ text: string; start: number; end: number; endWithNewline: number }> = [];
  let cursor = 0;
  const raw = content.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i];
    const start = cursor;
    const end = start + text.length;
    const endWithNewline = end + (i < raw.length - 1 ? 1 : 0);
    lines.push({ text, start, end, endWithNewline });
    cursor = endWithNewline;
  }
  return lines;
}

function stripMarkdownMarker(raw: string): { text: string; blockId: string | null } {
  const match = raw.match(MARKDOWN_BLOCK_ID_RE);
  if (!match) return { text: raw, blockId: null };
  const blockId = match[1].slice(1);
  return { text: raw.slice(0, match.index).replace(/\s+$/, ""), blockId };
}

function classifyMarkdownLine(line: string): NoteBlockType | null {
  if (THEMATIC_BREAK_RE.test(line)) return null;
  if (/^\s{0,3}#{1,6}\s+/.test(line)) return "heading";
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) return "taskItem";
  // 有序列表的分隔符可以是「.」或「)」：编辑器让相邻的有序列表交替使用，避免合并成一个列表
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) return "listItem";
  if (/^\s{0,3}>\s?/.test(line)) return "blockquote";
  return line.trim() ? "paragraph" : null;
}

function cleanMarkdownText(type: NoteBlockType, value: string): string {
  let text = value.trim();
  if (type === "heading") text = text.replace(/^#{1,6}\s+/, "");
  else if (type === "taskItem") text = text.replace(/^[-*+]\s+\[[ xX]\]\s+/, "");
  else if (type === "listItem") text = text.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
  else if (type === "blockquote") text = text.replace(/^>\s?/, "");
  return text.replace(/\s+\^blk_[A-Za-z0-9_-]{6,}\s*$/, "").trim();
}

function normalizeGeneratedMarkdownMarkers(content: string): string {
  // 旧版无下划线块 ID 不属于当前身份体系：先从正文中物理清除，随后
  // assignCandidateIds/applyMarkdownIds 会为真实内容生成标准 blk_<uuid> 标记。
  const legacySanitized = stripLegacyInternalMarkdownMarkers(content);
  if (!legacySanitized.includes("^blk_")) return legacySanitized;
  const lines = lineOffsets(legacySanitized);
  const edits: Array<{ from: number; to: number; insert: string }> = [];
  let fenceChar = "";
  let fenceLength = 0;
  let expectsCodeMarker = false;
  // 与 parseMarkdown 划分 HTML 块的方式一致：pre/script/style 到结束标签为止，其余到空行为止
  let htmlClose: RegExp | null = null;
  let inHtml = false;
  let htmlStart = -1;
  let inMath = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (fenceChar) {
      const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLength},}[ \\t]*$`);
      if (closeRe.test(line.text)) {
        fenceChar = "";
        fenceLength = 0;
        expectsCodeMarker = true;
      }
      continue;
    }

    const marker = line.text.match(GENERATED_MARKER_LINE_RE);
    if (expectsCodeMarker) {
      expectsCodeMarker = false;
      if (marker) continue;
    }

    if (!line.text.trim()) inHtml = false;
    const html: RegExpMatchArray | null = htmlClose || inHtml ? null : line.text.match(HTML_BLOCK_OPEN_RE);
    if (html) {
      const tag = html[1].toLowerCase();
      if (tag === "pre" || tag === "script" || tag === "style") htmlClose = new RegExp(`</${tag}\\s*>`, "i");
      else inHtml = true;
      htmlStart = index;
    }
    if (htmlClose || inHtml) {
      // 多行 HTML 块的 ID 与代码块相同，独占一行写在块后（pre/script/style 在结束标签之后，其余在空行之前）
      const last = htmlClose ? htmlClose.test(line.text) : !lines[index + 1]?.text.trim();
      if (htmlClose && last) {
        htmlClose = null;
        expectsCodeMarker = true;
      } else if (inHtml && marker && last) {
        continue;
      }
      // 旧版按行和空行切块，把标记写进了多行 HTML 块的中间行或末行行尾（代码里就多出 ^blk_ 文字，块补丁也会拒绝）：
      // 中间行的去掉，末行的挪到块后独占一行。单行 HTML 块行尾的标记是正常写法，不动
      const trailing = line.text.match(TRAILING_GENERATED_MARKER_RE);
      if (trailing && !(last && index === htmlStart)) {
        edits.push({ from: line.start, to: line.end, insert: last ? `${trailing[1]}\n^${trailing[2]}` : trailing[1] });
        continue;
      }
    } else if (MATH_FENCE_RE.test(line.text)) {
      // 块级公式与代码块相同，结束 `$$` 之后独占一行的 ID 不是孤立标记
      expectsCodeMarker = inMath;
      inMath = !inMath;
      continue;
    } else if (inMath && LEGACY_MATH_CLOSE_RE.test(line.text)) {
      // 旧版把 ID 接在结束 `$$` 行尾，这一行因此不再闭合公式（块补丁会整篇拒绝）：挪到下一行
      const [, close, id] = line.text.match(LEGACY_MATH_CLOSE_RE)!;
      edits.push({ from: line.start, to: line.end, insert: `${close}\n^${id}` });
      inMath = false;
      continue;
    } else {
      const opener = line.text.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (opener) {
        fenceChar = opener[1][0];
        fenceLength = opener[1].length;
        continue;
      }
    }

    if (marker) {
      edits.push({ from: line.start, to: line.endWithNewline, insert: "" });
      continue;
    }

    // 隐藏标记边界被回车或输入破坏时，块 ID 可能直接粘在正文后面。
    // 仅修复严格的系统 UUID，避免改写用户主动输入的普通 ^blk_ 文本。
    const attached = line.text.match(ATTACHED_GENERATED_MARKER_RE);
    if (attached) {
      edits.push({
        from: line.start,
        to: line.end,
        insert: `${attached[1]} ^${attached[2]}`,
      });
    }
  }

  let normalized = legacySanitized;
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    normalized = normalized.slice(0, edit.from) + edit.insert + normalized.slice(edit.to);
  }
  return normalized.trim() ? normalized : "";
}

function parseMarkdown(noteId: string, content: string): {
  normalizedContent: string;
  candidates: BlockCandidate[];
  changed: boolean;
} {
  const normalizedContent = normalizeGeneratedMarkdownMarkers(content);
  const lines = lineOffsets(normalizedContent);
  const candidates: BlockCandidate[] = [];
  let order = 0;

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.text.trim()) {
      i++;
      continue;
    }

    const fence = line.text.match(/^([ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+)?)(`{3,}|~{3,})(.*)$/);
    if (fence && (!fence[1].trim() || isEncryptedBlockLanguage(fence[3].trim()))) {
      const fenceToken = fence[2];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^${isEncryptedBlockLanguage(fence[3].trim()) ? "[ \\t>]*" : "\\s*"}${fenceToken[0]}{${fenceToken.length},}\\s*$`).test(lines[j].text)) j++;
      if (j < lines.length) j++;
      let markerLine = j;
      let explicitBlockId: string | null = null;
      if (markerLine < lines.length) {
        const marker = lines[markerLine].text.trim().match(/^\^(blk_[A-Za-z0-9_-]{6,})$/);
        if (marker) {
          explicitBlockId = marker[1];
          j++;
        }
      }
      const start = line.start;
      const end = (j > i ? lines[j - 1].endWithNewline : line.endWithNewline);
      const raw = normalizedContent.slice(start, end);
      const plainText = isEncryptedBlockLanguage(fence[3].trim()) ? "" : raw
        .replace(/^\s*(```+|~~~+)[^\n]*\n?/, "")
        .replace(/\n?\s*(```+|~~~+)\s*(?:\n\^blk_[A-Za-z0-9_-]+)?\s*$/, "")
        .trim();
      candidates.push({
        noteId,
        blockId: explicitBlockId,
        explicitBlockId: Boolean(explicitBlockId),
        blockType: "codeBlock",
        parentBlockId: null,
        blockOrder: order++,
        plainText,
        contentHash: hashText("codeBlock", isEncryptedBlockLanguage(fence[3].trim()) ? raw : plainText),
        path: String(order - 1),
        startOffset: start,
        endOffset: end,
        markerInsertOffset: (j > i ? lines[j - 1].end : line.end),
        markerStyle: "standalone",
      });
      i = Math.max(j, i + 1);
      continue;
    }

    if (MATH_FENCE_RE.test(line.text)) {
      let close = i + 1;
      while (close < lines.length && !MATH_FENCE_RE.test(lines[close].text)) close++;
      if (close < lines.length) {
        const standalone = lines[close + 1]?.text.match(STANDALONE_MARKER_RE);
        const end = standalone ? close + 2 : close + 1;
        const latex = lines.slice(i + 1, close).map((row) => row.text).join("\n").trim();
        candidates.push({
          noteId,
          blockId: standalone?.[1] ?? null,
          explicitBlockId: Boolean(standalone),
          blockType: "mathBlock",
          parentBlockId: null,
          blockOrder: order++,
          plainText: latex,
          contentHash: hashText("mathBlock", latex),
          path: String(order - 1),
          startOffset: line.start,
          endOffset: lines[end - 1].endWithNewline,
          markerInsertOffset: lines[close].end,
          markerStyle: "standalone",
        });
        i = end;
        continue;
      }
    }

    if (isTableStart(lines, i)) {
      // GFM 把表格后不以其他块开头的非空行都读成表格行
      let j = i + 2;
      while (j < lines.length && lines[j].text.trim() && classifyMarkdownLine(lines[j].text) === "paragraph"
        && !/^\s*(```+|~~~+)/.test(lines[j].text) && !HTML_BLOCK_OPEN_RE.test(lines[j].text)) j++;
      const last = lines[j - 1];
      const rows = lines.slice(i, j).map((row) => row.text);
      // 与编辑器转 Markdown 一致，表格的 ID 写在最后一行行尾（GFM 忽略多出的单元格）；
      // 只有表头的表格没有能写 ID 的行：分隔行加了标记就不再是表格
      const hasBody = j > i + 2;
      const stripped = hasBody ? stripMarkdownMarker(rows[rows.length - 1]) : { text: rows[rows.length - 1], blockId: null };
      rows[rows.length - 1] = stripped.text;
      const blockId = stripped.blockId;
      const plainText = rows.filter((_row, index) => index !== 1).flatMap(tableCells)
        .map((cell) => cell.replace(/\\\|/g, "|")).filter(Boolean).join(" ");
      candidates.push({
        noteId,
        blockId,
        explicitBlockId: Boolean(blockId),
        blockType: "table",
        parentBlockId: null,
        blockOrder: order++,
        plainText,
        contentHash: hashText("table", plainText),
        path: String(order - 1),
        startOffset: line.start,
        endOffset: last.endWithNewline,
        markerInsertOffset: hasBody ? last.end : undefined,
        markerStyle: "inline",
      });
      i = j;
      continue;
    }

    const html = line.text.match(HTML_BLOCK_OPEN_RE);
    if (html) {
      const tag = html[1].toLowerCase();
      const closesAtTag = tag === "pre" || tag === "script" || tag === "style";
      let contentEnd = i + 1;
      if (closesAtTag) {
        const close = new RegExp(`</${tag}\\s*>`, "i");
        let k = i;
        while (k < lines.length && !close.test(lines[k].text)) k++;
        contentEnd = Math.min(k + 1, lines.length);
      } else {
        while (contentEnd < lines.length && lines[contentEnd].text.trim()) contentEnd++;
      }
      let blockEnd = contentEnd;
      let markerId: string | null = null;
      if (closesAtTag && contentEnd < lines.length) {
        const standalone = lines[contentEnd].text.match(STANDALONE_MARKER_RE);
        if (standalone) { markerId = standalone[1]; blockEnd = contentEnd + 1; }
      } else if (!closesAtTag && contentEnd - 1 > i) {
        const standalone = lines[contentEnd - 1].text.match(STANDALONE_MARKER_RE);
        if (standalone) { markerId = standalone[1]; contentEnd -= 1; }
      }
      const lastContent = lines[contentEnd - 1];
      let raw = normalizedContent.slice(line.start, lastContent.end);
      if (!markerId) {
        const inline = stripMarkdownMarker(raw);
        if (inline.blockId) { markerId = inline.blockId; raw = inline.text; }
      }
      const blockType: NoteBlockType = tag === "pre" ? "codeBlock" : tag === "table" ? "table" : /^h[1-6]$/.test(tag) ? "heading" : "paragraph";
      const plainText = htmlPlainText(raw);
      candidates.push({
        noteId,
        // 编辑器保留的 HTML 自带 data-block-id：沿用它，Markdown 与富文本里是同一个 ID
        blockId: markerId ?? line.text.match(HTML_BLOCK_ID_RE)?.[1] ?? null,
        explicitBlockId: Boolean(markerId),
        blockType,
        parentBlockId: null,
        blockOrder: order++,
        plainText,
        contentHash: hashText(blockType, plainText),
        path: String(order - 1),
        startOffset: line.start,
        endOffset: lines[blockEnd - 1].endWithNewline,
        markerInsertOffset: lastContent.end,
        // 多行 HTML 的结束行在块补丁看来仍在 HTML 内部，ID 另起一行
        markerStyle: contentEnd - 1 > i ? "standalone" : "inline",
      });
      i = blockEnd;
      continue;
    }

    const type = classifyMarkdownLine(line.text);
    if (!type) {
      i++;
      continue;
    }

    let j = i + 1;
    if (type === "paragraph") {
      while (j < lines.length && lines[j].text.trim() && classifyMarkdownLine(lines[j].text) === "paragraph" && !/^\s*(```+|~~~+)/.test(lines[j].text)
        && !SETEXT_UNDERLINE_RE.test(lines[j].text) && !HTML_BLOCK_OPEN_RE.test(lines[j].text) && !MATH_FENCE_RE.test(lines[j].text)) {
        j++;
      }
    }
    const setext = type === "paragraph" && j < lines.length && SETEXT_UNDERLINE_RE.test(lines[j].text);
    const blockType: NoteBlockType = setext ? "heading" : type;
    const start = line.start;
    const end = lines[j - 1].endWithNewline;
    const raw = normalizedContent.slice(start, end).replace(/\n$/, "");
    const stripped = stripMarkdownMarker(raw);
    const plainText = cleanMarkdownText(type, stripped.text.replace(/\n/g, " "));
    candidates.push({
      noteId,
      blockId: stripped.blockId,
      explicitBlockId: Boolean(stripped.blockId),
      blockType,
      parentBlockId: null,
      blockOrder: order++,
      plainText,
      contentHash: hashText(blockType, plainText),
      path: String(order - 1),
      startOffset: start,
      endOffset: end,
      markerInsertOffset: lines[j - 1].end,
      markerStyle: "inline",
    });
    // 下划线行属于这个标题，不单独成块，也不带标记
    i = setext ? j + 1 : j;
  }

  return { normalizedContent, candidates, changed: normalizedContent !== content };
}

export function ensureNoteBlockTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_blocks_index (
      noteId TEXT NOT NULL,
      blockId TEXT NOT NULL,
      blockType TEXT NOT NULL,
      parentBlockId TEXT,
      blockOrder INTEGER NOT NULL DEFAULT 0,
      plainText TEXT NOT NULL DEFAULT '',
      contentHash TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      startOffset INTEGER,
      endOffset INTEGER,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (noteId, blockId),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_note_blocks_block_id ON note_blocks_index(blockId);
    CREATE INDEX IF NOT EXISTS idx_note_blocks_note_order ON note_blocks_index(noteId, blockOrder);
    CREATE INDEX IF NOT EXISTS idx_note_blocks_hash ON note_blocks_index(noteId, blockType, contentHash);

    CREATE TABLE IF NOT EXISTS block_operations (
      userId TEXT NOT NULL,
      operationId TEXT NOT NULL,
      noteId TEXT NOT NULL,
      resultJson TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (userId, operationId),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_block_operations_note ON block_operations(noteId, createdAt DESC);
  `);
}

function assignCandidateIds(
  db: Database.Database,
  noteId: string,
  candidates: BlockCandidate[],
): void {
  const previous = db.prepare(`
    SELECT blockId, blockType, contentHash, blockOrder
    FROM note_blocks_index
    WHERE noteId = ?
    ORDER BY blockOrder ASC
  `).all(noteId) as Array<{ blockId: string; blockType: string; contentHash: string; blockOrder: number }>;

  const reusable = new Map<string, string[]>();
  for (const row of previous) {
    const key = `${row.blockType}:${row.contentHash}`;
    const list = reusable.get(key) || [];
    list.push(row.blockId);
    reusable.set(key, list);
  }

  const used = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.blockId && !used.has(candidate.blockId)) {
      used.add(candidate.blockId);
      continue;
    }
    const key = `${candidate.blockType}:${candidate.contentHash}`;
    const list = reusable.get(key) || [];
    let reused: string | undefined;
    while (list.length > 0 && !reused) {
      const value = list.shift();
      if (value && !used.has(value)) reused = value;
    }
    candidate.blockId = reused || makeBlockId();
    used.add(candidate.blockId);
  }
}

function applyMarkdownIds(content: string, candidates: BlockCandidate[]): string {
  const inserts = candidates
    .filter((candidate) => !candidate.explicitBlockId && candidate.markerInsertOffset != null && candidate.blockId)
    .map((candidate) => ({
      offset: candidate.markerInsertOffset as number,
      text: candidate.markerStyle === "standalone" ? `\n^${candidate.blockId}` : ` ^${candidate.blockId}`,
    }))
    .sort((a, b) => b.offset - a.offset);
  let out = content;
  for (const insert of inserts) out = out.slice(0, insert.offset) + insert.text + out.slice(insert.offset);
  return out;
}

function materializeRows(candidates: BlockCandidate[]): NoteBlockIndexRow[] {
  return candidates.map((candidate) => ({
    noteId: candidate.noteId,
    blockId: candidate.blockId as string,
    blockType: candidate.blockType,
    parentBlockId: candidate.parentBlockId,
    blockOrder: candidate.blockOrder,
    plainText: candidate.plainText,
    contentHash: candidate.contentHash,
    path: candidate.path,
    startOffset: candidate.startOffset,
    endOffset: candidate.endOffset,
  }));
}

function contentTextFromCandidates(candidates: BlockCandidate[]): string {
  return candidates
    .filter((candidate) => candidate.parentBlockId === null)
    .map((candidate) => candidate.plainText)
    .filter(Boolean)
    .join("\n\n");
}

export function syncNoteBlocks(
  db: Database.Database,
  noteId: string,
  content: string,
  contentFormat: string,
): { content: string; contentText: string; blocks: NoteBlockIndexRow[]; changed: boolean } {
  ensureNoteBlockTables(db);
  if (contentFormat.startsWith("encrypted-")) return { content, contentText: "", blocks: [], changed: false };
  if (contentFormat === "plaintext") {
    db.prepare("DELETE FROM note_blocks_index WHERE noteId = ?").run(noteId);
    return { content, contentText: content, blocks: [], changed: false };
  }
  if (contentFormat === "html") {
    db.prepare("DELETE FROM note_blocks_index WHERE noteId = ?").run(noteId);
    return {
      content,
      contentText: content.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      blocks: [],
      changed: false,
    };
  }
  const parsed = contentFormat === "tiptap-json"
    ? parseTiptap(noteId, content)
    : parseMarkdown(noteId, content);
  assignCandidateIds(db, noteId, parsed.candidates);

  let normalizedContent = parsed.normalizedContent;
  if (contentFormat === "markdown") normalizedContent = applyMarkdownIds(normalizedContent, parsed.candidates);
  const changed = normalizedContent !== content;

  // Reparse Markdown after marker insertion so offsets stored in the index match the persisted text.
  let candidates = parsed.candidates;
  if (contentFormat === "markdown" && changed) {
    const reparsed = parseMarkdown(noteId, normalizedContent);
    const byOrder = new Map(parsed.candidates.map((candidate) => [candidate.blockOrder, candidate.blockId]));
    reparsed.candidates.forEach((candidate) => {
      candidate.blockId = candidate.blockId || byOrder.get(candidate.blockOrder) || makeBlockId();
      candidate.explicitBlockId = true;
    });
    candidates = reparsed.candidates;
  }

  const rows = materializeRows(candidates);
  // Parent blocks already contain all descendant text. Including child rows here would
  // duplicate tables, lists and blockquotes in contentText and break DOCX save verification.
  const contentText = contentTextFromCandidates(candidates);
  const insert = db.prepare(`
    INSERT INTO note_blocks_index (
      noteId, blockId, blockType, parentBlockId, blockOrder, plainText,
      contentHash, path, startOffset, endOffset, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM note_blocks_index WHERE noteId = ?").run(noteId);
    for (const row of rows) {
      insert.run(
        row.noteId,
        row.blockId,
        row.blockType,
        row.parentBlockId,
        row.blockOrder,
        row.plainText,
        row.contentHash,
        row.path,
        row.startOffset,
        row.endOffset,
      );
    }
    if (changed) {
      withEncryptedBlockWrite(db, noteId, normalizedContent, contentFormat, () =>
        db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
          .run(normalizedContent, contentText, noteId));
    }
  });
  tx();
  return { content: normalizedContent, contentText, blocks: rows, changed };
}

export function ensureNoteIndexed(db: Database.Database, noteId: string): NoteBlockIndexRow[] {
  ensureNoteBlockTables(db);
  const note = db.prepare("SELECT content, contentFormat FROM notes WHERE id = ?").get(noteId) as
    | { content: string; contentFormat: string }
    | undefined;
  if (!note) return [];
  return syncNoteBlocks(db, noteId, note.content || "", note.contentFormat || "tiptap-json").blocks;
}

export function getNoteBlocks(db: Database.Database, noteId: string, limit = 500): NoteBlockIndexRow[] {
  ensureNoteBlockTables(db);
  return db.prepare(`
    SELECT noteId, blockId, blockType, parentBlockId, blockOrder, plainText,
           contentHash, path, startOffset, endOffset, createdAt, updatedAt
    FROM note_blocks_index
    WHERE noteId = ?
    ORDER BY blockOrder ASC
    LIMIT ?
  `).all(noteId, limit) as NoteBlockIndexRow[];
}

export function getNoteBlock(
  db: Database.Database,
  noteId: string,
  blockId: string,
): NoteBlockIndexRow | null {
  ensureNoteBlockTables(db);
  return (db.prepare(`
    SELECT noteId, blockId, blockType, parentBlockId, blockOrder, plainText,
           contentHash, path, startOffset, endOffset, createdAt, updatedAt
    FROM note_blocks_index
    WHERE noteId = ? AND blockId = ?
  `).get(noteId, blockId) as NoteBlockIndexRow | undefined) || null;
}

export function searchNoteBlocks(
  db: Database.Database,
  query: string,
  options: { notebookId?: string; allowedNotebookIds?: string[]; limit?: number } = {},
): Array<NoteBlockIndexRow & { title: string; notebookId: string; updatedAt: string }> {
  ensureNoteBlockTables(db);
  const limit = Math.min(Math.max(options.limit || 50, 1), 200);
  const clauses = ["n.isTrashed = 0", "b.plainText LIKE ?"];
  const params: unknown[] = [`%${query.replace(/[\\%_]/g, "\\$&")}%`];
  if (options.notebookId) {
    clauses.push("n.notebookId = ?");
    params.push(options.notebookId);
  }
  if (options.allowedNotebookIds) {
    if (options.allowedNotebookIds.length === 0) return [];
    clauses.push(`n.notebookId IN (${options.allowedNotebookIds.map(() => "?").join(",")})`);
    params.push(...options.allowedNotebookIds);
  }
  params.push(limit);
  return db.prepare(`
    SELECT b.noteId, b.blockId, b.blockType, b.parentBlockId, b.blockOrder,
           b.plainText, b.contentHash, b.path, b.startOffset, b.endOffset,
           b.createdAt, b.updatedAt, n.title, n.notebookId, n.updatedAt AS updatedAt
    FROM note_blocks_index b
    JOIN notes n ON n.id = b.noteId
    WHERE ${clauses.join(" AND ")}
    ORDER BY n.updatedAt DESC, b.blockOrder ASC
    LIMIT ?
  `).all(...params) as Array<NoteBlockIndexRow & { title: string; notebookId: string; updatedAt: string }>;
}

export function plainTextFromNoteContent(content: string, contentFormat: string): string {
  if (contentFormat === "plaintext") return content;
  if (contentFormat.startsWith("encrypted-")) return "";
  if (contentFormat === "html") {
    return content.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  const parsed = contentFormat === "tiptap-json"
    ? parseTiptap("", content).candidates
    : parseMarkdown("", content).candidates;
  return contentTextFromCandidates(parsed);
}

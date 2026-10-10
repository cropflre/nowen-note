/**
 * Manual, dependency-free CJK typography tools.
 * NEVER run on editor keystrokes. Ranges are evaluated in the original document
 * so Markdown syntax is never re-created from rendered HTML.
 */
export type CjkTypographyAction = 'spacing' | 'punctuation' | 'cornerQuotes';
export type CjkTypographyFormat = 'plain' | 'markdown';
export interface TextRange { from: number; to: number }

const HAN = /\p{Script=Han}/u;
const TICK = String.fromCharCode(96);

function mergeRanges(input: TextRange[]): TextRange[] {
  const ranges = input.filter((r) => r.from < r.to).sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: TextRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

function escapedAt(text: string, at: number): boolean {
  let escapes = 0;
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) escapes++;
  return escapes % 2 === 1;
}

export function markdownProtectedRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  // Fences and display math span multiple lines and must take precedence over
  // inline parsing (including unmatched backticks in a code sample).
  let offset = 0;
  let fence: { char: string; size: number } | null = null;
  let displayMath = false;
  for (const line of text.split('\n')) {
    const start = offset;
    const end = offset + line.length + (offset + line.length < text.length ? 1 : 0);
    const marker = line.match(/^ {0,3}(\x60{3,}|~{3,})/);
    if (fence) {
      ranges.push({ from: start, to: end });
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size &&
          line.slice(marker[0].length).trim() === '') fence = null;
    } else if (marker) {
      fence = { char: marker[1][0], size: marker[1].length };
      ranges.push({ from: start, to: end });
    } else if (displayMath || /^\s*\$\$/.test(line)) {
      ranges.push({ from: start, to: end });
      const delimiters = line.match(/\$\$/g)?.length || 0;
      if (!displayMath) displayMath = delimiters % 2 !== 0;
      else if (delimiters % 2 !== 0) displayMath = false;
    }
    offset = end;
  }

  const alreadyProtected = (at: number) => ranges.some((r) => at >= r.from && at < r.to);
  function addMatches(regex: RegExp) {
    for (const match of text.matchAll(regex)) {
      const from = match.index;
      if (alreadyProtected(from)) continue;
      ranges.push({ from, to: from + match[0].length });
    }
  }

  // Entire link destination, including nested parentheses and optional title,
  // while keeping the visible [label] available for typography.
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== ']' || text[i + 1] !== '(' || alreadyProtected(i)) continue;
    let depth = 1;
    let j = i + 2;
    while (j < text.length && text[j] !== '\n' && depth > 0) {
      if (!escapedAt(text, j)) {
        if (text[j] === '(') depth++;
        if (text[j] === ')') depth--;
      }
      j++;
    }
    if (depth === 0) {
      ranges.push({ from: i + 1, to: j });
      i = j - 1;
    }
  }

  // Protect non-prose metadata and Nowen-style links: changing a link target
  // would silently invalidate embedded notes/mind maps.
  if (/^---\r?\n/.test(text)) {
    const frontmatter = text.match(/^---\r?\n[\s\S]*?\n---[ \t]*(?:\r?\n|$)/);
    if (frontmatter) ranges.push({ from: 0, to: frontmatter[0].length });
  }
  addMatches(/!?\[\[[^\]\n]+\]\]/g);
  addMatches(/\[\^[^\]\n]+\]/g);

  // URLs, emails, HTML tags and numeric tokens protected before punctuation.
  addMatches(/<\/?[A-Za-z][^>\n]*>/g);
  addMatches(/(?:https?:\/\/|www\.)[^\s<>()[\]"']+/gi);
  addMatches(/[^\s<>()[\]"'@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  addMatches(/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/[^\s]*)?/g);
  addMatches(/\b[vV]?\d+(?:[.,:]\d+)+(?:-[A-Za-z0-9]+)?\b/g);
  addMatches(/\.{3,}/g);
  addMatches(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*[^\n]+/gm);

  // Per-character parsing must not linearly scan thousands of protected
  // ranges for every character in a large notebook.
  const staticProtection = mergeRanges(ranges);
  let protectedCursor = 0;
  const isStaticProtected = (position: number) => {
    while (protectedCursor < staticProtection.length &&
           staticProtection[protectedCursor].to <= position) protectedCursor++;
    const range = staticProtection[protectedCursor];
    return !!range && position >= range.from && position < range.to;
  };

  // Inline code, math and TeX bracket delimiters. Keep unmatched openers
  // untouched rather than stripping a delimiter or consuming following text.
  for (let i = 0; i < text.length; i++) {
    if (isStaticProtected(i) || escapedAt(text, i)) continue;
    if (text[i] === TICK) {
      let size = 1;
      while (text[i + size] === TICK) size++;
      const marker = TICK.repeat(size);
      let end = text.indexOf(marker, i + size);
      while (end >= 0 && (text[end + size] === TICK || escapedAt(text, end))) {
        end = text.indexOf(marker, end + size);
      }
      if (end >= 0) {
        ranges.push({ from: i, to: end + size });
        i = end + size - 1;
      } else i += size - 1;
      continue;
    }
    const open = text.startsWith('\\(', i) ? '\\('
      : text.startsWith('\\[', i) ? '\\['
      : text[i] === '$' ? (text[i + 1] === '$' ? '$$' : '$') : null;
    if (!open) continue;
    const close = open === '\\(' ? '\\)' : open === '\\[' ? '\\]' : open;
    let end = text.indexOf(close, i + open.length);
    while (end >= 0 && escapedAt(text, end) && open[0] === '$') {
      end = text.indexOf(close, end + close.length);
    }
    if (end >= 0 && (open !== '$' || text.slice(i + 1, end).trim())) {
      ranges.push({ from: i, to: end + close.length });
      i = end + close.length - 1;
    }
  }
  return mergeRanges(ranges);
}

function addCjkSpacing(text: string): string {
  return text.replace(/(\p{Script=Han})(?=[A-Za-z0-9])/gu, '$1 ')
    .replace(/([A-Za-z0-9])(?=\p{Script=Han})/gu, '$1 ');
}

const TO_CJK: Record<string, string> = {
  ',': '，', '.': '。', ';': '；', ':': '：',
  '?': '？', '!': '！', '(': '（', ')': '）',
};
const TO_ASCII: Record<string, string> = Object.fromEntries(
  Object.entries(TO_CJK).map(([en, zh]) => [zh, en]),
);

function isEnglishClause(text: string, pos: number): boolean {
  const left = text.slice(Math.max(0, pos - 56), pos);
  const right = text.slice(pos + 1, pos + 56);
  const latinBefore = /[A-Za-z]$/.test(left);
  const latinAfter = /^[ \t]*[A-Za-z]/.test(right);
  if (latinBefore && latinAfter) return true;
  const fragment = left.split(/[\p{Script=Han}，。！？；：\n]/u).pop() || '';
  // "Hello, world!" in a Chinese paragraph remains an English clause.
  return latinBefore && (fragment.match(/[A-Za-z]+/g)?.length || 0) >= 2;
}

function normalizePunctuation(text: string): string {
  return text.split(/(\n)/).map((line) => {
    if (line === '\n') return line;
    const hans = [...line].filter((c) => HAN.test(c)).length;
    const latins = [...line].filter((c) => /[A-Za-z]/.test(c)).length;
    const chinese = hans >= 2 && hans >= latins * 0.35;
    if (!chinese) {
      if (hans > 0) return line; // mixed but ambiguous: do not guess
      return [...line].map((c) => TO_ASCII[c] ?? c).join('');
    }
    return [...line].map((char, i) => {
      if (!(char in TO_CJK)) return char;
      if (isEnglishClause(line, i)) return char;
      if (char === '.') {
        if (/[A-Za-z0-9]/.test(line[i - 1] || '') || /[A-Za-z0-9]/.test(line[i + 1] || '')) return char;
      }
      if (char === '(' && /[A-Za-z]/.test(line[i + 1] || '')) return char;
      if (char === ')' && /[A-Za-z]/.test(line[i - 1] || '')) return char;
      return TO_CJK[char];
    }).join('');
  }).join('');
}

function convertQuotes(text: string): string {
  const chars = [...text];
  const pair = new Map<number, string>();
  const stacks: Record<string, number[]> = { double: [], single: [] };
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const kind = /["“”]/.test(char) ? 'double' : /['‘’]/.test(char) ? 'single' : '';
    if (!kind) continue;
    const previous = chars[i - 1] || '';
    const next = chars[i + 1] || '';
    if (kind === 'single' && /[A-Za-z]/.test(previous) &&
      (/[A-Za-z]/.test(next) || !stacks.single.length)) continue;
    const openings = kind === 'double' ? '“' : '‘';
    const closings = kind === 'double' ? '”' : '’';
    const open = char === openings || (char !== closings && stacks[kind].length === 0);
    if (open) stacks[kind].push(i);
    else if (stacks[kind].length) {
      const start = stacks[kind].pop()!;
      pair.set(start, kind === 'double' ? '「' : '『');
      pair.set(i, kind === 'double' ? '」' : '』');
    }
  }
  return chars.map((char, i) => pair.get(i) ?? char).join('');
}

function plainTransform(text: string, action: CjkTypographyAction): string {
  if (action === 'spacing') return addCjkSpacing(text);
  if (action === 'punctuation') return normalizePunctuation(text);
  return convertQuotes(text);
}

export function transformCjkTypography(
  text: string, action: CjkTypographyAction, format: CjkTypographyFormat = 'plain',
): string {
  if (!text) return text;
  const protectedRanges = format === 'markdown' ? markdownProtectedRanges(text) : [];
  // In plain-text contexts avoid changing numeric, URLs and emails too.
  if (format === 'plain') {
    const re = /(?:https?:\/\/|www\.)[^\s<>()[\]"']+|[^\s<>()[\]"'@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b[vV]?\d+(?:[.,:]\d+)+(?:-[A-Za-z0-9]+)?\b|\.{3,}|\\\([^\n]*?\\\)|\\\[[^\n]*?\\\]|\$\$[^$]*\$\$|\$[^$\n]+\$/gi;
    for (const m of text.matchAll(re)) protectedRanges.push({ from: m.index, to: m.index + m[0].length });
  }
  let result = '';
  let offset = 0;
  for (const range of mergeRanges(protectedRanges)) {
    result += plainTransform(text.slice(offset, range.from), action);
    result += text.slice(range.from, range.to);
    offset = range.to;
  }
  return result + plainTransform(text.slice(offset), action);
}

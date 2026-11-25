import path from "node:path";
import { MIGRATION_LIMITS, type NmfNote } from "./migrationFormat";

const uuid = "(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})";
const suffix = new RegExp(`(?:^|[ -])(${uuid})$`, "i");
const csvFileBytes = 2 * 1024 * 1024;
const csvTotalBytes = 8 * 1024 * 1024;
const normalizedTitle = (value: string) => value.normalize("NFC").trim();

export class NotionMigrationError extends Error {
  readonly status = 400;
  constructor(readonly code: string) { super(code); }
}

/** File names are an export convention, not a guarantee from Notion's public API. */
export function notionPageId(value: string): string | null {
  let candidate = value;
  try { candidate = decodeURIComponent(candidate); } catch { return null; }
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^https?:\/\//i.test(candidate)) return null;
  if (/^https?:\/\//i.test(candidate)) {
    let url: URL;
    try { url = new URL(candidate); } catch { return null; }
    if (!/(?:^|\.)notion\.(?:so|site)$/i.test(url.hostname)) return null;
    candidate = url.pathname;
  }
  candidate = candidate.split(/[?#]/)[0].replace(/\/$/, "");
  const stem = path.posix.basename(candidate).replace(/\.(?:md|markdown|html?|csv)$/i, "");
  return suffix.exec(stem)?.[1].replace(/-/g, "").toLowerCase() || null;
}

export function notionDisplayName(value: string): string {
  return value.replace(suffix, "").trim() || value;
}

/** RFC 4180 quoting, with row/column/cell budgets before allocating unbounded arrays. */
export function parseNotionCsv(content: string): string[][] {
  if (Buffer.byteLength(content, "utf8") > csvFileBytes || content.includes("\0")) throw new NotionMigrationError("NOTION_CSV_LIMIT");
  const input = content.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  const field = () => {
    if (row.length >= 256 || cell.length > 64 * 1024) throw new NotionMigrationError("NOTION_CSV_LIMIT");
    row.push(cell); cell = ""; closed = false;
  };
  const record = () => {
    field();
    if (row.some((value) => value !== "")) rows.push(row);
    row = [];
    if (rows.length > MIGRATION_LIMITS.notes + 1) throw new NotionMigrationError("NOTION_CSV_LIMIT");
  };
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closed = true; }
      } else cell += character;
    } else if (character === ",") field();
    else if (character === "\r" || character === "\n") { record(); if (character === "\r" && input[index + 1] === "\n") index++; }
    else if (character === '"' && !cell && !closed) quoted = true;
    else if (closed || character === '"') throw new NotionMigrationError("NOTION_CSV_INVALID");
    else cell += character;
    if (cell.length > 64 * 1024) throw new NotionMigrationError("NOTION_CSV_LIMIT");
  }
  if (quoted) throw new NotionMigrationError("NOTION_CSV_INVALID");
  if (cell || row.length || closed) record();
  if (rows.length && rows.some((values) => values.length !== rows[0].length)) throw new NotionMigrationError("NOTION_CSV_INVALID");
  return rows;
}

function linkHrefs(note: NmfNote): string[] {
  let content = note.content;
  if (note.contentFormat === "markdown") {
    let fence: { marker: string; length: number } | null = null;
    content = content.split("\n").map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = { marker: marker[0], length: marker.length };
        else if (marker[0] === fence.marker && marker.length >= fence.length) fence = null;
        return "";
      }
      return fence ? "" : line.replace(/`[^`]*`/g, "");
    }).join("\n");
  } else content = content.replace(/<(?:pre|code)\b[^>]*>[\s\S]*?<\/(?:pre|code)>/gi, "");
  return [...new Set([
    ...[...content.matchAll(/\b(?:href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]),
    ...(note.contentFormat === "markdown" ? [...content.matchAll(/(?<!!)\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)].map((match) => match[1].replace(/^<|>$/g, "")) : []),
  ])].slice(0, 400);
}

export interface NotionMigrationContext {
  source: { platform: "notion"; exportId: string };
  warnings: string[];
  decorate(notePath: string, note: NmfNote): NmfNote;
}

export function createNotionMigrationContext(input: {
  notePaths: string[];
  csvPaths: string[];
  source: Pick<NmfNote["source"], "platform" | "exportId">;
  readText: (relativePath: string, maxBytes: number) => string;
}): NotionMigrationContext | null {
  if (!["files", "notion"].includes(input.source.platform)) return null;
  const notePaths = input.notePaths.filter((name) => /\.(?:md|markdown|html?)$/i.test(name));
  const namedId = notePaths.some((name) => new RegExp(`.+[ -]${uuid}\\.(?:md|markdown|html?)$`, "i").test(path.posix.basename(name)));
  let htmlMarker = false;
  if (!namedId && input.source.platform !== "notion") {
    // Inspect at most one small HTML document when filename evidence is absent.
    const html = notePaths.find((name) => /\.html?$/i.test(name));
    if (html) {
      try {
        const content = input.readText(html, MIGRATION_LIMITS.contentBytes);
        htmlMarker = /<meta\b[^>]*name=["']generator["'][^>]*content=["']Notion["']/i.test(content)
          || new RegExp(`<article\\b(?=[^>]*\\bid=["']${uuid}["'])(?=[^>]*\\bclass=["']page\\b)[^>]*>`, "i").test(content);
      }
      catch { /* the generic reader remains authoritative for content errors */ }
    }
  }
  if (input.source.platform !== "notion" && !namedId && !htmlMarker) return null;
  const warnings = new Set<string>([
    "NOTION_COMPONENT_LIMITS; 数据库视图、公式、关系、历史版本和协作权限不转换；保留可读取的正文及原始链接",
  ]);
  if (input.source.platform !== "notion") warnings.add("NOTION_FORMAT_INFERRED; 根据导出文件特征识别为 Notion，请在预览中确认来源");
  const source = { platform: "notion" as const, exportId: input.source.exportId };
  const ids = new Map<string, string>();
  const sourceIds = new Map<string, string>();
  const titles = new Map<string, string[]>();
  for (const name of notePaths) {
    const id = notionPageId(name);
    if (id && ids.has(id)) throw new NotionMigrationError("NOTION_DUPLICATE_PAGE_ID");
    if (id) ids.set(id, name);
    sourceIds.set(name, id || name);
    const title = normalizedTitle(notionDisplayName(path.posix.basename(name).replace(/\.[^.]+$/, "")));
    titles.set(title, [...(titles.get(title) || []), name]);
  }
  const properties = new Map<string, Record<string, string>>();
  const conflicts = new Map<string, Set<string>>();
  let consumedBytes = 0, consumedRows = 0;
  const put = (name: string, key: string, value: string) => {
    const values = properties.get(name) || Object.create(null) as Record<string, string>;
    const blocked = conflicts.get(name) || new Set<string>();
    if (blocked.has(key)) return;
    if (values[key] !== undefined && values[key] !== value) {
      delete values[key]; blocked.add(key); conflicts.set(name, blocked);
      warnings.add("NOTION_CSV_AMBIGUOUS_PROPERTY; 同一页面的冲突属性未选择任一版本，请保留原始 CSV 核对");
    } else {
      const candidate = { ...values, [key]: value };
      if (key.length > 100 || value.length > 2048 || Object.keys(candidate).length > 32 || Buffer.byteLength(JSON.stringify(candidate), "utf8") > 16 * 1024) {
        warnings.add("NOTION_CSV_PROPERTY_LIMIT; 超出 NMF 限额的属性未暂存，请保留原始 CSV 核对"); return;
      }
      values[key] = value;
    }
    properties.set(name, values);
  };
  for (const csvPath of input.csvPaths.slice().sort()) {
    if (consumedBytes >= csvTotalBytes || consumedRows >= MIGRATION_LIMITS.notes) { warnings.add("NOTION_CSV_TOTAL_LIMIT; 剩余 CSV 属性超出批次限额，未转换"); break; }
    let rows: string[][];
    try {
      const content = input.readText(csvPath, Math.min(csvFileBytes, csvTotalBytes - consumedBytes));
      consumedBytes += Buffer.byteLength(content, "utf8");
      rows = parseNotionCsv(content);
    } catch { warnings.add("NOTION_CSV_UNREADABLE; CSV 未能完整解析，页面正文仍可迁移，数据库属性未转换"); continue; }
    if (!rows.length) continue;
    const [headers, ...records] = rows;
    const names = headers.map((header) => header.normalize("NFC").trim());
    const headerCounts = new Map<string, number>();
    for (const name of names) headerCounts.set(name, (headerCounts.get(name) || 0) + 1);
    const folder = csvPath.replace(/\.csv$/i, "") + "/";
    for (const values of records) {
      if (++consumedRows > MIGRATION_LIMITS.notes) { warnings.add("NOTION_CSV_TOTAL_LIMIT; 剩余 CSV 属性超出批次限额，未转换"); break; }
      const first = values[0].trim();
      const explicitId = notionPageId(/^\[[^\]\n]*\]\(([^)]+)\)$/.exec(first)?.[1] || first);
      let candidates = explicitId && ids.has(explicitId) ? [ids.get(explicitId)!] : titles.get(normalizedTitle(first)) || [];
      const local = candidates.filter((name) => name.startsWith(folder));
      if (local.length) candidates = local;
      if (candidates.length !== 1) { warnings.add("NOTION_CSV_UNMAPPED_ROWS; CSV 中有缺少正文或无法唯一匹配的行，未猜测页面对应关系"); continue; }
      const name = candidates[0];
      if (notionPageId(csvPath)) put(name, "notion.databaseId", notionPageId(csvPath)!);
      for (let index = 1; index < headers.length; index++) {
        const header = names[index];
        const key = `notion.csv.${header}`;
        if (!header || /[\u0000-\u001f\u007f]/.test(header) || headerCounts.get(header) !== 1) { warnings.add("NOTION_CSV_INVALID_HEADERS; 空白、重复或控制字符属性名未转换"); continue; }
        put(name, key, values[index]);
      }
    }
    warnings.add("NOTION_CSV_PROPERTIES_STAGED_ONLY; CSV 标量属性只作为来源元数据暂存并报告字段名，不转换为标签、日期、公式或数据库关系");
  }
  const context: NotionMigrationContext = {
    source,
    get warnings() { return [...warnings]; },
    decorate(notePath, note) {
      const links = note.links.map((link) => ({ ...link,
        ...(link.targetSourceId ? { targetSourceId: sourceIds.get(link.targetSourceId) || (notionPageId(link.targetSourceId) && ids.has(notionPageId(link.targetSourceId)!) ? notionPageId(link.targetSourceId)! : link.targetSourceId) } : {}),
      }));
      const seen = new Set(links.map((link) => link.href));
      for (const href of linkHrefs(note)) {
        if (seen.has(href) || !/^https?:\/\//i.test(href)) continue;
        const id = notionPageId(href);
        if (!id) continue;
        if (ids.has(id)) {
          if (links.length >= 200) { warnings.add("NOTION_LINK_LIMIT; 超出引用限额的链接保留原样"); break; }
          links.push({ href, targetSourceId: id }); seen.add(href);
        } else warnings.add("NOTION_UNEXPORTED_LINKS; 有来源页面不在本次导出中，原始链接保留且不会自动抓取");
      }
      const metadata = { ...note.metadata };
      for (const [key, value] of Object.entries(properties.get(notePath) || {})) {
        const candidate = { ...metadata, [key]: value };
        if (Object.keys(candidate).length <= 32 && Buffer.byteLength(JSON.stringify(candidate), "utf8") <= 16 * 1024) metadata[key] = value;
        else warnings.add("NOTION_CSV_PROPERTY_LIMIT; 超出 NMF 限额的属性未暂存，请保留原始 CSV 核对");
      }
      return { ...note, source: { ...source, sourceId: sourceIds.get(notePath) || note.source.sourceId },
        title: notionDisplayName(note.title), path: note.path.map(notionDisplayName), metadata, links };
    },
  };
  return context;
}

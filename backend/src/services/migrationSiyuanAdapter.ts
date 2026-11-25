import crypto from "node:crypto";
import path from "node:path";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { z } from "zod";
import { sanitizeForImport } from "../lib/sanitizeHtml";
import { siyuanSyToMarkdown, type SiyuanNode } from "../lib/siyuanSyParser";
import { MIGRATION_LIMITS, migrationRelativePathSchema, nmfNoteSchema, type NmfNote } from "./migrationFormat";

export type SiyuanMigrationFile = { diskPath: string; size: number; sha256: string };
export interface SiyuanMigrationInput {
  files: ReadonlyMap<string, SiyuanMigrationFile>;
  source: Pick<NmfNote["source"], "platform" | "exportId">;
  readText: (name: string, maxBytes: number) => string;
  managedPath: (file: SiyuanMigrationFile) => string;
  sniffAsset: (diskPath: string, name: string) => Promise<string>;
  onNote: (note: NmfNote) => Promise<void>;
  assertActive?: () => void;
}

export class MigrationSiyuanError extends Error {
  readonly status = 400;
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new MigrationSiyuanError(code); }
const ignored = (name: string) => /(?:^|\/)(?:__MACOSX|\.history|\.trash|history|trash|\.git)(?:\/|$)/i.test(name);
const isDocument = (name: string) => /\.sy$/i.test(name) && !ignored(name) && !/(?:^|\/)\.siyuan\//i.test(name);
export function isSiyuanMigration(files: ReadonlyMap<string, SiyuanMigrationFile>): boolean {
  return [...files.keys()].some(isDocument);
}
function value(node: SiyuanNode, names: string[]): string {
  for (const name of names) {
    const result = node[name] ?? node.Properties?.[name];
    if (typeof result === "string" && result.trim()) return result.trim();
  }
  return "";
}
function titleFor(doc: SiyuanNode, fallback: string): string {
  return (value(doc, ["title", "name", "Title", "Name"]) || fallback)
    .replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#{1,6}\s*$/, "").trim();
}
function document(input: SiyuanMigrationInput, name: string): SiyuanNode {
  const file = input.files.get(name)!;
  if (file.size > MIGRATION_LIMITS.contentBytes) return fail("MIGRATION_SIYUAN_DOCUMENT_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(input.readText(name, MIGRATION_LIMITS.contentBytes)); }
  catch { return fail("MIGRATION_SIYUAN_INVALID_DOCUMENT"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as SiyuanNode).Type !== "NodeDocument") return fail("MIGRATION_SIYUAN_INVALID_DOCUMENT");
  const stack = [{ node: parsed as SiyuanNode, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > 20_000 || depth > 64) return fail("MIGRATION_SIYUAN_AST_LIMIT");
    if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.Type !== "string" || node.Type.length > 128
      || (node.Children != null && !Array.isArray(node.Children))
      || (node.Data != null && typeof node.Data !== "string")
      || (node.Properties != null && (typeof node.Properties !== "object" || Array.isArray(node.Properties) || Object.keys(node.Properties).length > 256))) return fail("MIGRATION_SIYUAN_INVALID_DOCUMENT");
    for (const child of node.Children || []) stack.push({ node: child, depth: depth + 1 });
  }
  return parsed as SiyuanNode;
}

function safeHref(href: string): boolean {
  return !/^[a-z][a-z\d+.-]*:/i.test(href) || /^(?:https?:|mailto:|siyuan:\/\/blocks\/)/i.test(href);
}
function prepare(node: SiyuanNode, warnings: Set<string>): SiyuanNode {
  const children = (node.Children || []).map((child) => prepare(child, warnings));
  const marks = value(node, ["TextMarkType"]).split(/\s+/);
  if (node.Type === "NodeBlockRef" || (node.Type === "NodeTextMark" && marks.includes("block-ref"))) {
    const refId = value(node, ["TextMarkBlockRefID", "BlockRefID", "RefID"])
      || (node.Children || []).filter((child) => /^(?:NodeBlockRefID|NodeRefID)$/.test(child.Type)).map((child) => value(child, ["Data"])).join("");
    const label = value(node, ["TextMarkTextContent", "Text", "text", "Data"])
      || (node.Children || []).filter((child) => /(?:DynamicText|RefText|NodeText)$/.test(child.Type)).map((child) => value(child, ["Data"])).join("") || "块引用";
    if (!refId) { warnings.add("SIYUAN_UNRESOLVED_BLOCK_REFERENCE; 缺少目标 ID 的块引用保留为文本"); return { Type: "NodeText", Data: label }; }
    return { Type: "NodeTextMark", TextMarkType: "a", TextMarkTextContent: label.replace(/[\[\]\r\n]/g, " "), TextMarkAHref: `siyuan://blocks/${encodeURIComponent(refId)}` };
  }
  if (node.Type === "NodeIFrame" || node.Type === "NodeWidget") {
    warnings.add("SIYUAN_EMBED_DOWNGRADED; 嵌入页面与挂件不执行，降级为可用的来源链接");
    const raw = value(node, ["src", "href", "url", "Data", "Tokens", "HTML", "html"]);
    const href = raw.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] || (/^[^<>\s]+$/.test(raw) ? raw : "");
    return href && safeHref(href) ? { Type: "NodeParagraph", Children: [{ Type: "NodeTextMark", TextMarkType: "a", TextMarkTextContent: "思源嵌入内容", TextMarkAHref: href }] }
      : { Type: "NodeParagraph", Children: [{ Type: "NodeText", Data: "[思源嵌入内容未迁移]" }] };
  }
  const result: SiyuanNode = { ...node, Children: children };
  if (["NodeVideo", "NodeAudio"].includes(node.Type)) {
    const explicit = value(node, ["src", "href", "url"]);
    if (explicit && !safeHref(explicit)) {
      warnings.add("SIYUAN_UNSAFE_LINK_REMOVED; 不安全协议已移除并保留链接文本");
      return { Type: "NodeParagraph", Children: [{ Type: "NodeText", Data: "[思源媒体未迁移]" }] };
    }
  }
  if (["NodeHTMLBlock", "NodeInlineHTML", "NodeVideo", "NodeAudio"].includes(node.Type)) {
    const raw = value(node, ["Data", "Tokens", "HTML", "html"]);
    if (raw.includes("<")) {
      result.Data = sanitizeForImport(raw); delete result.Tokens; delete result.HTML; delete result.html;
      if (result.Data !== raw) warnings.add("SIYUAN_HTML_SANITIZED; 来源 HTML 已移除危险脚本和不支持的组件");
    }
  }
  if ((node.Type === "NodeTextMark" && marks.includes("a")) || node.Type === "NodeLink") {
    const href = value(node, ["TextMarkAHref", "href", "url", "dest"]) || (node.Children || []).filter((child) => child.Type === "NodeLinkDest").map((child) => value(child, ["Data"])).join("");
    if (href && !safeHref(href)) { warnings.add("SIYUAN_UNSAFE_LINK_REMOVED; 不安全协议已移除并保留链接文本"); return { Type: "NodeText", Data: value(node, ["TextMarkTextContent", "Text", "Data"]) || (node.Children || []).filter((child) => child.Type === "NodeLinkText").map((child) => value(child, ["Data"])).join("") }; }
    if (node.Type === "NodeLink") return { Type: "NodeTextMark", TextMarkType: "a", TextMarkTextContent: (node.Children || []).filter((child) => child.Type === "NodeLinkText").map((child) => value(child, ["Data"])).join("") || "链接", TextMarkAHref: href };
    if (marks.length > 1) { result.TextMarkType = "a"; warnings.add("SIYUAN_MARK_STYLE_DOWNGRADED; 复合链接样式按普通链接保留"); }
  }
  return result;
}
function rewrite(content: string, href: string, replacement: string): string {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`((?:src|href)\\s*=\\s*["'])${escaped}(["'])`, "gi"), (_all, before, after) => `${before}${replacement}${after}`)
    .replace(new RegExp(`(\\]\\(<?)${escaped}(>?[)\\s])`, "g"), (_all, before, after) => `${before}${replacement}${after}`);
}
function references(content: string): string[] {
  return [...new Set([...content.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)].map((match) => match[1].replace(/^<|>$/g, ""))
    .concat([...content.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1])))];
}
function resolveAsset(files: ReadonlyMap<string, SiyuanMigrationFile>, docPath: string, href: string): string | undefined {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(href)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(href.split(/[?#]/)[0]).replace(/\\/g, "/"); } catch { return undefined; }
  let directory = path.posix.dirname(docPath);
  while (true) {
    const candidate = path.posix.normalize(path.posix.join(directory, decoded));
    if (migrationRelativePathSchema.safeParse(candidate).success && files.has(candidate)) return candidate;
    if (directory === ".") return undefined;
    directory = path.posix.dirname(directory);
  }
}
function timestamps(doc: SiyuanNode, warnings: Set<string>): { createdAt?: string; updatedAt?: string; metadata: NmfNote["metadata"] } {
  const result: { createdAt?: string; updatedAt?: string; metadata: NmfNote["metadata"] } = { metadata: {} };
  for (const [key, aliases] of [["createdAt", ["createdAt", "created", "Created"]], ["updatedAt", ["updatedAt", "updated", "Updated", "UpdateTime"]]] as const) {
    const raw = value(doc, [...aliases]);
    if (!raw) continue;
    if (z.string().datetime({ offset: true }).safeParse(raw).success) result[key] = new Date(raw).toISOString();
    else {
      result.metadata[key === "createdAt" ? "siyuanCreatedLocal" : "siyuanUpdatedLocal"] = raw.slice(0, 100);
      warnings.add("SIYUAN_LOCAL_TIME_UNVERIFIED; 来源时间没有时区或格式不受支持，保留原值于迁移元数据，不猜测时区");
    }
  }
  return result;
}
function segment(raw: string, identity: string, warnings: Set<string>, disambiguate = false): string {
  const clean = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f/\\]/g, " ").trim();
  const changed = clean !== raw || !clean || clean === "." || clean === ".." || clean.length > 100 || disambiguate;
  if (!changed) return clean;
  warnings.add("SIYUAN_FOLDER_NAME_NORMALIZED; 不可用、过长或重复的目录名使用稳定 ID 后缀区分");
  return `${(clean && clean !== "." && clean !== ".." ? clean : "思源目录").slice(0, 88)} [${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 8)}]`;
}

/** Pure Source → NMF adapter. The existing SiYuan Markdown converter owns document semantics. */
export async function stageSiyuanMigration(input: SiyuanMigrationInput): Promise<{ warnings: string[] }> {
  if (!["files", "siyuan"].includes(input.source.platform)) return fail("MIGRATION_SOURCE_MISMATCH");
  if (input.files.size > MIGRATION_LIMITS.files) return fail("MIGRATION_SIYUAN_FILE_LIMIT");
  const paths = [...input.files.keys()].filter(isDocument).sort();
  if (!paths.length || paths.length > MIGRATION_LIMITS.notes) return fail("MIGRATION_SIYUAN_NOTE_LIMIT");
  const warnings = new Set<string>();
  if ([...input.files.keys()].some((name) => /\.sy$/i.test(name) && !isDocument(name))) warnings.add("SIYUAN_NONCURRENT_DOCUMENTS_SKIPPED; 历史、回收站和内部目录中的 .sy 不作为当前笔记导入");
  const docs = new Map<string, { id: string; title: string }>();
  const ids = new Set<string>();
  const boxes = new Map<string, string>();
  for (const name of input.files.keys()) if (/(?:^|\/)\.siyuan\/conf\.json$/i.test(name)) {
    input.assertActive?.();
    let conf: unknown;
    try { conf = JSON.parse(input.readText(name, MIGRATION_LIMITS.contentBytes)); } catch { return fail("MIGRATION_SIYUAN_INVALID_METADATA"); }
    if (!conf || typeof conf !== "object" || Array.isArray(conf)) return fail("MIGRATION_SIYUAN_INVALID_METADATA");
    const prefix = name.slice(0, -"/.siyuan/conf.json".length);
    const label = (conf as { name?: unknown }).name;
    boxes.set(prefix, typeof label === "string" && label.trim() ? label.trim() : path.posix.basename(prefix));
  }
  for (const name of paths) {
    input.assertActive?.(); const doc = document(input, name);
    const id = value(doc, ["ID", "id"]) || path.posix.basename(name).replace(/\.sy$/i, "");
    if (ids.has(id)) return fail("MIGRATION_SIYUAN_DUPLICATE_ID");
    ids.add(id); docs.set(name, { id, title: titleFor(doc, id) });
    if (docs.size % 20 === 0) await yieldEventLoop();
  }
  const folderNames = new Map<string, string>();
  const siblingLabels = new Map<string, number>();
  for (const [name, doc] of docs) {
    const key = `${path.posix.dirname(name)}\0${doc.title.normalize("NFC")}`;
    siblingLabels.set(key, (siblingLabels.get(key) || 0) + 1);
  }
  for (const [name, doc] of docs) folderNames.set(name.slice(0, -3), segment(doc.title, name, warnings,
    (siblingLabels.get(`${path.posix.dirname(name)}\0${doc.title.normalize("NFC")}`) || 0) > 1));
  const boxLabels = new Map<string, number>();
  for (const label of boxes.values()) boxLabels.set(label, (boxLabels.get(label) || 0) + 1);
  const source = { platform: "siyuan", exportId: input.source.exportId };
  let emitted = 0;
  for (const [name, indexed] of docs) {
    input.assertActive?.();
    const ast = document(input, name);
    const converted = siyuanSyToMarkdown(prepare(ast, warnings));
    if (Object.keys(converted.stats.unsupportedNodes).length) warnings.add("SIYUAN_COMPONENTS_DOWNGRADED; 数据库、查询、样式或其他特殊组件按现有 Markdown 转换器降级，未声称无损");
    let content = converted.markdown || indexed.title;
    const attachments: NmfNote["attachments"] = [], links: NmfNote["links"] = [];
    const assetByPath = new Map<string, NmfNote["attachments"][number]>();
    for (const href of [...new Set([...converted.stats.images, ...converted.stats.attachments, ...references(content)])]) {
      if (/^siyuan:\/\/blocks\//i.test(href)) {
        let target: string;
        try { target = decodeURIComponent(href.replace(/^siyuan:\/\/blocks\//i, "").split(/[?#]/)[0]); } catch { target = ""; }
        if (ids.has(target)) links.push({ href, targetSourceId: target });
        else warnings.add("SIYUAN_BLOCK_ANCHOR_PRESERVED; 嵌套块锚点或包外引用保留原始思源链接，不伪造目标锚点");
        continue;
      }
      if (/^(?:https?:|\/\/)/i.test(href)) { warnings.add("SIYUAN_EXTERNAL_RESOURCES_PRESERVED; 远程图片与链接保留，不下载或抓取"); continue; }
      if (/^(?:mailto:|#)/i.test(href)) continue;
      const resolved = resolveAsset(input.files, name, href);
      if (!resolved) { warnings.add("SIYUAN_UNRESOLVED_ASSET; 包内资源未找到或不是安全相对引用，原链接保留"); continue; }
      const targetDoc = docs.get(resolved);
      if (targetDoc) { links.push({ href, targetSourceId: targetDoc.id }); continue; }
      let asset = assetByPath.get(resolved);
      if (!asset) {
        const file = input.files.get(resolved)!;
        if (file.size > MIGRATION_LIMITS.assetBytes) return fail("MIGRATION_SIYUAN_ASSET_TOO_LARGE");
        let mimeType: string;
        try { mimeType = await input.sniffAsset(file.diskPath, resolved); }
        catch (error) {
          if ((error as { code?: string }).code === "MIGRATION_UNSUPPORTED_ASSET") { warnings.add("SIYUAN_UNSUPPORTED_ASSET; 不支持的附件类型保留来源引用"); continue; }
          throw error;
        }
        const assetId = crypto.createHash("sha256").update(resolved).digest("hex");
        asset = { assetId, path: input.managedPath(file), sha256: file.sha256, mimeType, originalPath: `nmf-assets/${assetId}${path.posix.extname(resolved)}` };
        assetByPath.set(resolved, asset); attachments.push(asset);
      }
      content = rewrite(content, href, asset.originalPath!);
    }
    const box = [...boxes.keys()].filter((prefix) => !prefix || name.startsWith(prefix + "/")).sort((a, b) => b.length - a.length)[0];
    const folderPath: string[] = [];
    let prefix = box || "";
    if (box !== undefined) folderPath.push(segment(boxes.get(box)!, box, warnings, (boxLabels.get(boxes.get(box)!) || 0) > 1));
    const relative = box ? name.slice(box.length + 1) : name;
    for (const part of relative.split("/").slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      folderPath.push(folderNames.get(prefix) || segment(part, prefix, warnings));
    }
    const time = timestamps(ast, warnings);
    const propertyNames = Object.keys(ast.Properties || {}).filter((key) => !["id", "title", "name", "type", "created", "updated", "createdat", "updatedat", "tags"].includes(key.toLowerCase()));
    if (propertyNames.length) { time.metadata.siyuanUnsupportedPropertyNames = propertyNames.join(", ").slice(0, 2048); warnings.add("SIYUAN_PROPERTIES_NOT_CONVERTED; 自定义属性仅记录字段名，不当作数据库列或脚本执行"); }
    const propertyTags = value(ast, ["tags"]).split(/[,，]/).map((tag) => tag.trim().replace(/^#|#$/g, "")).filter(Boolean);
    const tags = [...new Set([...converted.stats.tags, ...propertyTags])];
    await input.onNote(nmfNoteSchema.parse({ schemaVersion: 1, source: { ...source, sourceId: indexed.id }, title: indexed.title,
      path: folderPath, contentFormat: "markdown", content, tags, attachments, links, metadata: time.metadata, createdAt: time.createdAt, updatedAt: time.updatedAt }));
    if (++emitted % 20 === 0) await yieldEventLoop();
  }
  return { warnings: [...warnings] };
}

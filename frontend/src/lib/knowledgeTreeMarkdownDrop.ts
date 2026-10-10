import { api } from "@/lib/api";
import {
  createRoundTripPackageImportFile,
  importNotes,
  parseRoundTripPackageManifest,
  type PackageManifestPreview,
} from "@/lib/importService";
import {
  knowledgeTreeApi,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import {
  getKnowledgeTreeExpansionScope,
  getKnowledgeTreeExpansionSnapshot,
  saveKnowledgeTreeExpansion,
} from "@/lib/knowledgeTreeExpansion";
import { revealCreatedKnowledgeTreeNote } from "@/lib/knowledgeTreeCreateVisibility";
import { toast } from "@/lib/toast";

const TREE_SELECTOR = '[data-nowen-knowledge-tree="embedded"]';
const TREE_NODE_SELECTOR = "[data-knowledge-tree-node-id]";
const ACTIVE_DROP_CLASS = "knowledge-tree-markdown-drop-target";
const TREE_CHANGED_EVENT = "nowen:knowledge-tree-changed";

export const MAX_MARKDOWN_DROP_FILES = 100;
export const MAX_MARKDOWN_DROP_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_MARKDOWN_DROP_TOTAL_SIZE = 100 * 1024 * 1024;
export const MAX_MARKDOWN_ZIP_FILE_SIZE = 512 * 1024 * 1024;
const MAX_MARKDOWN_ZIP_ENTRIES = 2_000;
const MAX_MARKDOWN_ZIP_ASSET_BYTES = 512 * 1024 * 1024;

type ImportedMarkdownNote = Awaited<ReturnType<typeof api.getNote>>;

export interface MarkdownBatchImportFailure {
  name: string;
  reason: string;
}

export interface MarkdownBatchImportResult {
  imported: ImportedMarkdownNote[];
  failures: MarkdownBatchImportFailure[];
  importedCount?: number;
  cancelled?: boolean;
}

export function markdownBatchImportedCount(result: MarkdownBatchImportResult): number {
  return result.importedCount ?? result.imported.length;
}

let installed = false;
let importing = false;
let activeDropRow: HTMLElement | null = null;

export function isMarkdownDropFile(file: Pick<File, "name">): boolean {
  return /\.(?:md|markdown)$/i.test(String(file.name || "").trim());
}

export function isWordDropFile(file: Pick<File, "name">): boolean {
  return /\.docx$/i.test(String(file.name || "").trim());
}

export function isMarkdownZipDropFile(file: Pick<File, "name">): boolean {
  return /\.zip$/i.test(String(file.name || "").trim());
}

export function markdownDropTitle(fileName: string): string {
  const normalized = String(fileName || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.(?:md|markdown)$/i, "")
    .trim();
  return normalized || "未命名 Markdown";
}

export function hasExternalFilePayload(dataTransfer: Pick<DataTransfer, "types" | "items">): boolean {
  if (Array.from(dataTransfer.types || []).some((type) => type === "Files")) return true;
  return Array.from(dataTransfer.items || []).some((item) => item.kind === "file");
}

export function markdownFilesFromDataTransfer(dataTransfer: Pick<DataTransfer, "files">): File[] {
  return Array.from(dataTransfer.files || []).filter(isMarkdownDropFile);
}

export function knowledgeTreeFilesFromDataTransfer(dataTransfer: Pick<DataTransfer, "files">): File[] {
  return Array.from(dataTransfer.files || []).filter((file) => (
    isMarkdownDropFile(file) || isMarkdownZipDropFile(file) || isWordDropFile(file)
  ));
}

/** 打开系统文件选择器，支持一次选择多个 Markdown 文件。 */
export function pickMarkdownFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,text/markdown,text/x-markdown";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => input.remove();
    input.onchange = () => {
      settled = true;
      const files = Array.from(input.files || []).filter(isMarkdownDropFile);
      cleanup();
      resolve(files);
    };
    input.oncancel = () => {
      if (settled) return;
      cleanup();
      resolve([]);
    };
    input.click();
  });
}

/** 打开系统文件选择器，选择 Markdown + 附件 ZIP。 */
export function pickMarkdownZipFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => input.remove();
    input.onchange = () => {
      settled = true;
      const files = Array.from(input.files || []).filter(isMarkdownZipDropFile);
      cleanup();
      resolve(files);
    };
    input.oncancel = () => {
      if (settled) return;
      cleanup();
      resolve([]);
    };
    input.click();
  });
}

export function findKnowledgeTreeDropRow(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>(TREE_NODE_SELECTOR);
  if (!row || !row.closest(TREE_SELECTOR)) return null;
  return row;
}

function setActiveDropRow(row: HTMLElement | null): void {
  if (activeDropRow === row) return;
  activeDropRow?.classList.remove(ACTIVE_DROP_CLASS);
  activeDropRow = row;
  activeDropRow?.classList.add(ACTIVE_DROP_CLASS);
}

function clearActiveDropRow(): void {
  setActiveDropRow(null);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

interface KnowledgeTreeDropTarget {
  node: KnowledgeTreeNode;
  nodes: KnowledgeTreeNode[];
}

async function resolveTargetNode(nodeId: string): Promise<KnowledgeTreeDropTarget | null> {
  const [ownedResult, sharedResult] = await Promise.allSettled([
    knowledgeTreeApi.list(),
    knowledgeTreeApi.listShared(),
  ]);
  const nodes: KnowledgeTreeNode[] = [];
  if (ownedResult.status === "fulfilled") nodes.push(...ownedResult.value.nodes);
  if (sharedResult.status === "fulfilled") nodes.push(...sharedResult.value.nodes);
  if (nodes.length === 0) {
    const reason = ownedResult.status === "rejected"
      ? ownedResult.reason
      : sharedResult.status === "rejected"
        ? sharedResult.reason
        : new Error("无法读取内容树");
    throw reason;
  }
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node ? { node, nodes } : null;
}

async function readMarkdownFile(file: File): Promise<string> {
  if (file.size > MAX_MARKDOWN_DROP_FILE_SIZE) {
    throw new Error(`文件超过 ${formatBytes(MAX_MARKDOWN_DROP_FILE_SIZE)} 限制`);
  }
  const text = await file.text();
  return text.replace(/^\uFEFF/, "");
}

interface MarkdownImportDocument {
  title: string | null;
  content: string;
  targetFormat: "markdown" | "tiptap-json";
}

function parseFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

export function parseMarkdownImportDocument(source: string): MarkdownImportDocument {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { title: null, content: source, targetFormat: "markdown" };

  const metadata = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (field) metadata.set(field[1].toLowerCase(), parseFrontmatterValue(field[2]));
  }

  const declaredFormat = (
    metadata.get("sourcecontentformat")
    || metadata.get("contentformat")
    || ""
  ).toLowerCase();
  const isNowenExport = Boolean(declaredFormat);
  const targetFormat = declaredFormat === "tiptap-json"
    || declaredFormat === "html"
    ? "tiptap-json"
    : "markdown";

  return {
    title: isNowenExport ? metadata.get("title")?.trim() || null : null,
    content: isNowenExport ? source.slice(match[0].length) : source,
    targetFormat,
  };
}

interface MarkdownZipDocument {
  path: string;
  fileName: string;
  imported: MarkdownImportDocument;
  assetPaths: string[];
}

interface MarkdownZipEntry {
  name: string;
  dir: boolean;
  unsafeOriginalName?: string;
  async(type: "string"): Promise<string>;
  async(type: "blob"): Promise<Blob>;
}

interface MarkdownZipArchive {
  kind: "markdown";
  entries: Map<string, MarkdownZipEntry>;
  documents: MarkdownZipDocument[];
}

interface NowenPackageZipArchive {
  kind: "nowen-package";
  manifest: PackageManifestPreview;
}

type InspectedMarkdownZipArchive = MarkdownZipArchive | NowenPackageZipArchive;

export interface MarkdownZipImportTarget {
  parentId: string | null;
  targetNotebookId?: string;
  workspaceId?: string;
  targetLabel?: string;
}

interface MarkdownLinkDestination {
  start: number;
  end: number;
  zipPath: string;
}

function normalizeZipEntryPath(rawPath: string): string {
  const unified = String(rawPath || "").normalize("NFC").replace(/\\/g, "/");
  if (!unified || unified.includes("\0")) throw new Error("ZIP 包含无效路径");
  if (unified.startsWith("/") || /^[A-Za-z]:\//.test(unified)) {
    throw new Error(`ZIP 包含绝对路径：${rawPath}`);
  }
  const segments = unified.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`ZIP 包含不安全路径：${rawPath}`);
  }
  return segments.join("/");
}

function decodeZipReferencePath(rawPath: string): string {
  try {
    return decodeURIComponent(rawPath).normalize("NFC");
  } catch {
    throw new Error(`附件路径编码无效：${rawPath}`);
  }
}

function resolveZipReferencePath(markdownPath: string, rawTarget: string): string | null {
  const target = rawTarget.trim();
  if (!target || target.startsWith("#")) return null;
  if (/^(?:blob|file):/i.test(target) || /^[A-Za-z]:[\\/]/.test(target)) {
    throw new Error(`不支持临时或本地磁盘附件路径：${target}`);
  }
  if (/^\/?api\/attachments\//i.test(target)) {
    throw new Error(`ZIP 中仍包含服务器附件地址：${target}`);
  }
  if (/^(?:https?:)?\/\//i.test(target)) {
    if (/\/api\/attachments\//i.test(target)) {
      throw new Error(`ZIP 中仍包含服务器附件地址：${target}`);
    }
    return null;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(target)) return null;
  if (target.startsWith("/")) throw new Error(`ZIP 中包含绝对附件路径：${target}`);

  const pathOnly = target.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  const decoded = decodeZipReferencePath(pathOnly);
  const targetSegments = decoded.split("/").filter((segment) => segment && segment !== ".");
  if (targetSegments.some((segment) => segment === "..")) {
    throw new Error(`不支持包含 .. 的附件路径：${target}`);
  }
  const baseSegments = markdownPath.split("/").slice(0, -1);
  return [...baseSegments, ...targetSegments].join("/");
}

function markdownDestinationCandidates(inner: string): Array<{ start: number; end: number }> {
  const leading = inner.length - inner.trimStart().length;
  const trimmed = inner.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("<")) {
    const closing = trimmed.indexOf(">");
    if (closing > 1) return [{ start: leading + 1, end: leading + closing }];
  }

  const candidates = [{ start: leading, end: leading + trimmed.length }];
  const withTitle = trimmed.match(/^(\S+)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))$/);
  if (withTitle) candidates.unshift({ start: leading, end: leading + withTitle[1].length });
  return candidates;
}

function locateMarkdownDestination(
  inner: string,
  markdownPath: string,
  entries: ReadonlyMap<string, MarkdownZipEntry>,
): MarkdownLinkDestination | null {
  let fallback: MarkdownLinkDestination | null = null;
  for (const candidate of markdownDestinationCandidates(inner)) {
    const rawTarget = inner.slice(candidate.start, candidate.end);
    const zipPath = resolveZipReferencePath(markdownPath, rawTarget);
    if (!zipPath) return null;
    const resolved = { ...candidate, zipPath };
    if (entries.has(zipPath)) return resolved;
    fallback ||= resolved;
  }
  return fallback;
}

function isRequiredPackagedAsset(zipPath: string, isImage: boolean): boolean {
  if (isImage) return true;
  if (/(?:^|\/)(?:assets?|images?|files?)\//i.test(zipPath)) return true;
  const extension = zipPath.split("/").pop()?.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  return Boolean(extension && !["md", "markdown", "html", "htm"].includes(extension));
}

function transformMarkdownZipReferences(
  markdown: string,
  markdownPath: string,
  entries: ReadonlyMap<string, MarkdownZipEntry>,
  replacements?: ReadonlyMap<string, string>,
): { content: string; assetPaths: string[] } {
  const assetPaths = new Set<string>();
  const linkPattern = /(!?\[[^\]\r\n]*\])\(([^)\r\n]+)\)/g;
  const content = markdown.replace(linkPattern, (fullMatch, prefix: string, inner: string) => {
    const destination = locateMarkdownDestination(inner, markdownPath, entries);
    if (!destination) return fullMatch;
    const entry = entries.get(destination.zipPath);
    const isImage = prefix.startsWith("!");
    if (!entry || entry.dir) {
      if (isRequiredPackagedAsset(destination.zipPath, isImage)) {
        throw new Error(`缺少附件：${destination.zipPath}`);
      }
      return fullMatch;
    }
    if (/\.(?:md|markdown)$/i.test(destination.zipPath)) return fullMatch;

    assetPaths.add(destination.zipPath);
    const replacement = replacements?.get(destination.zipPath);
    if (!replacement) return fullMatch;
    const nextInner = `${inner.slice(0, destination.start)}${replacement}${inner.slice(destination.end)}`;
    return `${prefix}(${nextInner})`;
  });
  return { content, assetPaths: Array.from(assetPaths) };
}

function mimeTypeForZipAsset(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  const byExtension: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    avif: "image/avif",
    ico: "image/x-icon",
    pdf: "application/pdf",
    zip: "application/zip",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
  };
  return byExtension[extension] || "application/octet-stream";
}

async function readMarkdownZip(file: File): Promise<InspectedMarkdownZipArchive> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(file);
  const manifestEntry = zip.file("manifest.json");
  if (manifestEntry) {
    const manifest = parseRoundTripPackageManifest(await manifestEntry.async("string"));
    // Markdown round-trip 包同时包含给用户阅读的 Markdown 与 notes/* 私有正文。
    // 必须在枚举 Markdown 前整体分流，避免重复导入并保留服务端附件 ID 重映射契约。
    if (manifest) return { kind: "nowen-package", manifest };
  }

  if (file.size > MAX_MARKDOWN_ZIP_FILE_SIZE) {
    throw new Error(`ZIP 超过 ${formatBytes(MAX_MARKDOWN_ZIP_FILE_SIZE)} 限制`);
  }
  const zipEntries = Object.values(zip.files);
  if (zipEntries.length > MAX_MARKDOWN_ZIP_ENTRIES) {
    throw new Error(`ZIP 条目超过 ${MAX_MARKDOWN_ZIP_ENTRIES} 个限制`);
  }

  const entries = new Map<string, MarkdownZipEntry>();
  for (const entry of zipEntries) {
    const originalPath = entry.unsafeOriginalName || entry.name;
    const normalizedPath = normalizeZipEntryPath(originalPath);
    if (!normalizedPath || entry.dir) continue;
    if (entries.has(normalizedPath)) throw new Error(`ZIP 包含重复路径：${normalizedPath}`);
    entries.set(normalizedPath, entry);
  }

  const markdownEntries = Array.from(entries.entries()).filter(([entryPath]) => /\.(?:md|markdown)$/i.test(entryPath));
  if (markdownEntries.length === 0) throw new Error("ZIP 中没有 Markdown 文件，格式不受支持");
  if (markdownEntries.length > MAX_MARKDOWN_DROP_FILES) {
    throw new Error(`ZIP 中 Markdown 文件超过 ${MAX_MARKDOWN_DROP_FILES} 个限制`);
  }

  const documents: MarkdownZipDocument[] = [];
  for (const [entryPath, entry] of markdownEntries) {
    const source = (await entry.async("string")).replace(/^\uFEFF/, "");
    if (new Blob([source]).size > MAX_MARKDOWN_DROP_FILE_SIZE) {
      throw new Error(`${entryPath} 超过 ${formatBytes(MAX_MARKDOWN_DROP_FILE_SIZE)} 限制`);
    }
    const imported = parseMarkdownImportDocument(source);
    const references = transformMarkdownZipReferences(imported.content, entryPath, entries);
    documents.push({
      path: entryPath,
      fileName: entryPath.split("/").pop() || entryPath,
      imported,
      assetPaths: references.assetPaths,
    });
  }
  return { kind: "markdown", entries, documents };
}

function normalizeMarkdownZipImportTarget(
  target: string | null | MarkdownZipImportTarget,
): MarkdownZipImportTarget {
  return typeof target === "object" && target !== null
    ? target
    : { parentId: target };
}

async function importNowenPackageZip(
  file: File,
  manifest: PackageManifestPreview,
  target: MarkdownZipImportTarget,
): Promise<MarkdownBatchImportResult> {
  if (target.parentId && !target.targetNotebookId) {
    throw new Error("Nowen 数据包只能导入到目录节点，不能导入到文档节点");
  }

  let progressMessage = "Nowen 数据包导入失败";
  const packageEntry = createRoundTripPackageImportFile(file, manifest);
  const result = await importNotes(
    [packageEntry],
    target.targetNotebookId,
    (progress) => { progressMessage = progress.message; },
    {
      workspaceId: target.workspaceId,
      targetLabel: target.targetLabel,
    },
  );
  if (!result.success) {
    if (progressMessage.startsWith("已取消导入")) {
      return { imported: [], failures: [], importedCount: 0, cancelled: true };
    }
    throw new Error(progressMessage.replace(/^导入失败：/, "") || "Nowen 数据包导入失败");
  }
  if (result.count <= 0) throw new Error("Nowen 数据包未创建任何笔记");

  window.dispatchEvent(new CustomEvent(TREE_CHANGED_EVENT, {
    detail: { reason: "roundtrip-markdown-package-imported", imported: result.count },
  }));
  return { imported: [], failures: [], importedCount: result.count };
}

async function importMarkdownZipDocument(
  document: MarkdownZipDocument,
  archive: MarkdownZipArchive,
  parentId: string | null,
  extractedBytes: { value: number },
): Promise<ImportedMarkdownNote> {
  const title = document.imported.title || markdownDropTitle(document.fileName);
  const isRichText = document.imported.targetFormat === "tiptap-json";
  const uploadedIds: string[] = [];
  let createdNode: KnowledgeTreeNode | null = null;

  try {
    createdNode = await knowledgeTreeApi.create({
      parentId,
      nodeType: isRichText ? "note" : "markdown",
      title,
    });
    const replacements = new Map<string, string>();
    for (const assetPath of document.assetPaths) {
      const entry = archive.entries.get(assetPath);
      if (!entry) throw new Error(`缺少附件：${assetPath}`);
      const blob = await entry.async("blob");
      extractedBytes.value += blob.size;
      if (extractedBytes.value > MAX_MARKDOWN_ZIP_ASSET_BYTES) {
        throw new Error(`ZIP 附件累计超过 ${formatBytes(MAX_MARKDOWN_ZIP_ASSET_BYTES)} 限制`);
      }
      const fileName = assetPath.split("/").pop() || "attachment";
      const file = new File([blob], fileName, { type: mimeTypeForZipAsset(fileName) });
      const uploaded = await api.attachments.upload(createdNode.resourceId, file);
      uploadedIds.push(uploaded.id);
      const stableUrl = /^\/?api\/attachments\//i.test(uploaded.url)
        ? uploaded.url.startsWith("/") ? uploaded.url : `/${uploaded.url}`
        : `/api/attachments/${uploaded.id}`;
      replacements.set(assetPath, stableUrl);
    }

    const rewritten = transformMarkdownZipReferences(
      document.imported.content,
      document.path,
      archive.entries,
      replacements,
    ).content;
    const content = isRichText
      ? JSON.stringify((await import("@/lib/contentFormat")).markdownToTiptapJSON(rewritten))
      : rewritten;
    const createdNote = await api.getNote(createdNode.resourceId);
    return await api.updateNoteConfirmed(createdNode.resourceId, {
      title,
      content,
      contentFormat: document.imported.targetFormat,
      version: createdNote.version,
    });
  } catch (error) {
    await Promise.allSettled(uploadedIds.map((attachmentId) => api.attachments.remove(attachmentId)));
    if (createdNode) await knowledgeTreeApi.remove(createdNode.id, "subtree").catch(() => undefined);
    throw error;
  }
}

export async function importMarkdownZipFileIntoKnowledgeTree(
  file: File,
  targetInput: string | null | MarkdownZipImportTarget,
): Promise<MarkdownBatchImportResult> {
  const archive = await readMarkdownZip(file);
  const target = normalizeMarkdownZipImportTarget(targetInput);
  if (archive.kind === "nowen-package") {
    return importNowenPackageZip(file, archive.manifest, target);
  }
  const imported: ImportedMarkdownNote[] = [];
  const failures: MarkdownBatchImportFailure[] = [];
  const extractedBytes = { value: 0 };

  for (const document of archive.documents) {
    try {
      imported.push(await importMarkdownZipDocument(document, archive, target.parentId, extractedBytes));
    } catch (error) {
      failures.push({ name: document.path, reason: errorMessage(error) });
    }
  }
  return { imported, failures, importedCount: imported.length };
}

export async function importMarkdownZipFilesIntoKnowledgeTree(
  files: Iterable<File>,
  target: string | null | MarkdownZipImportTarget,
): Promise<MarkdownBatchImportResult> {
  const imported: ImportedMarkdownNote[] = [];
  const failures: MarkdownBatchImportFailure[] = [];
  let importedCount = 0;
  let cancelled = false;
  for (const file of Array.from(files).filter(isMarkdownZipDropFile)) {
    try {
      const result = await importMarkdownZipFileIntoKnowledgeTree(file, target);
      imported.push(...result.imported);
      importedCount += markdownBatchImportedCount(result);
      failures.push(...result.failures);
      cancelled ||= result.cancelled === true;
    } catch (error) {
      failures.push({ name: file.name, reason: errorMessage(error) });
    }
  }
  return {
    imported,
    failures,
    importedCount,
    cancelled: cancelled && importedCount === 0 && failures.length === 0,
  };
}

export async function importMarkdownFileIntoKnowledgeTree(
  file: File,
  parentId: string | null,
): Promise<Awaited<ReturnType<typeof api.getNote>>> {
  const imported = parseMarkdownImportDocument(await readMarkdownFile(file));
  const title = imported.title || markdownDropTitle(file.name);
  const isRichText = imported.targetFormat === "tiptap-json";
  const content = isRichText
    ? JSON.stringify((await import("@/lib/contentFormat")).markdownToTiptapJSON(imported.content))
    : imported.content;
  let createdNode: KnowledgeTreeNode | null = null;

  try {
    createdNode = await knowledgeTreeApi.create({
      parentId,
      nodeType: isRichText ? "note" : "markdown",
      title,
    });
    const createdNote = await api.getNote(createdNode.resourceId);
    return await api.updateNoteConfirmed(createdNode.resourceId, {
      title,
      content,
      contentFormat: imported.targetFormat,
      version: createdNote.version,
    });
  } catch (error) {
    if (createdNode) {
      await knowledgeTreeApi.remove(createdNode.id, "subtree").catch(() => undefined);
    }
    throw error;
  }
}

export async function importMarkdownFilesIntoKnowledgeTree(
  files: Iterable<File>,
  parentId: string | null,
): Promise<MarkdownBatchImportResult> {
  const selected = Array.from(files).filter(isMarkdownDropFile);
  const imported: ImportedMarkdownNote[] = [];
  const failures: MarkdownBatchImportFailure[] = [];
  let acceptedBytes = 0;

  for (const [index, file] of selected.entries()) {
    if (index >= MAX_MARKDOWN_DROP_FILES) {
      failures.push({
        name: file.name,
        reason: `单次最多导入 ${MAX_MARKDOWN_DROP_FILES} 个 Markdown 文件`,
      });
      continue;
    }
    if (file.size > MAX_MARKDOWN_DROP_FILE_SIZE) {
      failures.push({
        name: file.name,
        reason: `文件超过 ${formatBytes(MAX_MARKDOWN_DROP_FILE_SIZE)} 限制`,
      });
      continue;
    }
    if (acceptedBytes + file.size > MAX_MARKDOWN_DROP_TOTAL_SIZE) {
      failures.push({
        name: file.name,
        reason: `本次累计大小超过 ${formatBytes(MAX_MARKDOWN_DROP_TOTAL_SIZE)} 限制`,
      });
      continue;
    }
    acceptedBytes += file.size;

    try {
      imported.push(await importMarkdownFileIntoKnowledgeTree(file, parentId));
    } catch (error) {
      failures.push({ name: file.name, reason: errorMessage(error) });
    }
  }

  return { imported, failures };
}

export function formatMarkdownImportFailures(
  failures: readonly MarkdownBatchImportFailure[],
  limit = 3,
): string {
  const visible = failures.slice(0, limit).map(({ name, reason }) => `${name}：${reason}`);
  const omitted = failures.length - visible.length;
  return `${visible.join("；")}${omitted > 0 ? `；另有 ${omitted} 个失败` : ""}`;
}

async function importWordFileIntoKnowledgeTree(
  file: File,
  target: KnowledgeTreeNode,
  nodes: KnowledgeTreeNode[],
): Promise<void> {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>();
  let cursor: KnowledgeTreeNode | undefined = target;
  let notebookId: string | null = null;

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (cursor.resourceType === "notebook") {
      notebookId = cursor.resourceId;
      break;
    }
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  if (!notebookId && target.resourceType === "note") {
    notebookId = (await api.getNote(target.resourceId)).notebookId;
  }
  if (!notebookId) throw new Error("无法确定 Word 文档的目标目录");

  const { importDocxAsNote } = await import("@/lib/wordNoteService");
  const { note } = await importDocxAsNote({ notebookId, file });
  if (target.id !== `notebook:${notebookId}`) {
    await knowledgeTreeApi.move(`note:${note.id}`, { parentId: target.id });
  }
}

function emitTreeChanged(targetNodeId: string, imported: number): void {
  window.dispatchEvent(new CustomEvent(TREE_CHANGED_EVENT, {
    detail: {
      reason: "knowledge-tree-files-dropped",
      targetNodeId,
      imported,
    },
  }));
}

function expandImportedTarget(target: KnowledgeTreeNode): void {
  if (target.nodeType !== "folder") return;
  const scope = getKnowledgeTreeExpansionScope();
  const expanded = new Set(getKnowledgeTreeExpansionSnapshot(scope).expandedNodeIds);
  expanded.add(target.id);
  saveKnowledgeTreeExpansion(scope, expanded);
}

async function handleKnowledgeTreeFileDrop(row: HTMLElement, dataTransfer: DataTransfer): Promise<void> {
  const nodeId = row.dataset.knowledgeTreeNodeId || "";
  const allFiles = Array.from(dataTransfer.files || []);
  const supportedFiles = knowledgeTreeFilesFromDataTransfer(dataTransfer);
  const skippedCount = allFiles.length - supportedFiles.length;

  if (!nodeId) return;
  if (supportedFiles.length === 0) {
    toast.warning("这里只支持拖入 .md、.markdown、Markdown 附件 ZIP 或 .docx 文件");
    return;
  }
  if (importing) {
    toast.warning("已有文档正在导入，请稍后再试");
    return;
  }

  importing = true;
  const progressToast = toast.info(`正在导入 ${supportedFiles.length} 个文档…`, 0);
  let target: KnowledgeTreeNode | null = null;
  let successCount = 0;
  const failures: MarkdownBatchImportFailure[] = supportedFiles
    .slice(MAX_MARKDOWN_DROP_FILES)
    .map((file) => ({
      name: file.name,
      reason: `单次最多导入 ${MAX_MARKDOWN_DROP_FILES} 个文档`,
    }));
  const filesToImport = supportedFiles.slice(0, MAX_MARKDOWN_DROP_FILES);

  try {
    const resolvedTarget = await resolveTargetNode(nodeId);
    if (!resolvedTarget) throw new Error("目标目录已不存在，请刷新后重试");
    target = resolvedTarget.node;
    if (!target.access.capabilities.canCreate) {
      throw new Error("你没有在该目录下创建文档的权限");
    }

    const markdownFiles = filesToImport.filter(isMarkdownDropFile);
    const markdownZipFiles = filesToImport.filter(isMarkdownZipDropFile);
    const wordFiles = filesToImport.filter(isWordDropFile);
    const markdownResult = await importMarkdownFilesIntoKnowledgeTree(markdownFiles, target.id);
    successCount += markdownResult.imported.length;
    failures.push(...markdownResult.failures);

    const markdownZipResult = await importMarkdownZipFilesIntoKnowledgeTree(markdownZipFiles, {
      parentId: target.id,
      targetNotebookId: target.resourceType === "notebook" ? target.resourceId : undefined,
      workspaceId: target.workspaceId || "personal",
      targetLabel: target.title,
    });
    successCount += markdownBatchImportedCount(markdownZipResult);
    failures.push(...markdownZipResult.failures);
    if (markdownZipResult.cancelled && successCount === 0 && failures.length === 0) {
      toast.info("已取消导入，未写入任何数据");
      return;
    }

    for (const file of wordFiles) {
      try {
        await importWordFileIntoKnowledgeTree(file, target, resolvedTarget.nodes);
        successCount += 1;
      } catch (error) {
        failures.push({ name: file.name, reason: errorMessage(error) });
      }
    }

    if (successCount > 0) {
      expandImportedTarget(target);
      revealCreatedKnowledgeTreeNote(target.id);
      emitTreeChanged(target.id, successCount);
    }
  } catch (error) {
    failures.push({ name: "导入", reason: errorMessage(error) });
  } finally {
    importing = false;
    toast.dismiss(progressToast);
  }

  if (failures.length === 0 && successCount > 0) {
    const skippedHint = skippedCount > 0 ? `，已忽略 ${skippedCount} 个不支持的文件` : "";
    toast.success(`已将 ${successCount} 个文档导入“${target?.title || "目标目录"}”${skippedHint}`);
    return;
  }

  if (successCount > 0) {
    toast.warning(
      `成功导入 ${successCount} 个文件，${failures.length} 个失败：${formatMarkdownImportFailures(failures)}`,
      8000,
    );
    return;
  }

  toast.error(
    failures.length > 0 ? formatMarkdownImportFailures(failures) : "文档导入失败",
    8000,
  );
}

export function installKnowledgeTreeMarkdownDrop(): () => void {
  if (installed || typeof document === "undefined") return () => undefined;
  installed = true;

  const onDragOver = (event: DragEvent) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !hasExternalFilePayload(dataTransfer)) return;
    const row = findKnowledgeTreeDropRow(event.target);
    setActiveDropRow(row);
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: DragEvent) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !hasExternalFilePayload(dataTransfer)) return;
    const row = findKnowledgeTreeDropRow(event.target);
    clearActiveDropRow();
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    void handleKnowledgeTreeFileDrop(row, dataTransfer);
  };

  const onDragLeave = (event: DragEvent) => {
    if (event.relatedTarget === null) clearActiveDropRow();
  };

  const onDragEnd = () => clearActiveDropRow();

  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop, true);
  document.addEventListener("dragleave", onDragLeave, true);
  document.addEventListener("dragend", onDragEnd, true);

  return () => {
    document.removeEventListener("dragover", onDragOver, true);
    document.removeEventListener("drop", onDrop, true);
    document.removeEventListener("dragleave", onDragLeave, true);
    document.removeEventListener("dragend", onDragEnd, true);
    clearActiveDropRow();
    installed = false;
  };
}

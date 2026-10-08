import { sha256 } from "hash-wasm";
import { parser } from "@lezer/markdown";
import { api } from "./api";
import { scanObsidianFolder, scanObsidianZip } from "./obsidianScan";
import { buildObsidianAssetIndex, collectObsidianReferences, rewriteObsidianMarkdown } from "./obsidianReferences";
import { getOfflineQueueStorageKey } from "./offlineScope";
import type { Note, Notebook } from "@/types";

export interface YuqueFileDocument {
  key: string;
  title: string;
  book: string;
  path: string[];
  content: string;
  contentHash: string;
  images: number;
  warnings: string[];
}
export interface YuqueFileResult {
  created: number;
  skipped: number;
  failed: { key: string; title: string; message: string }[];
  firstNoteId?: string;
  notebookId?: string;
}

function readFile(file: File, mode: "text" | "dataURL"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("FILE_READ_FAILED"));
    if (mode === "text") reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

// References written as code examples must remain literal Markdown.
function markdownSections(source: string): { text: string; code: boolean }[] {
  const sections: { text: string; code: boolean }[] = [];
  let end = 0;
  parser.parse(source).iterate({ enter(node) {
    if (!["FencedCode", "CodeBlock", "InlineCode"].includes(node.name)) return;
    sections.push({ text: source.slice(end, node.from), code: false }, { text: source.slice(node.from, node.to), code: true });
    end = node.to;
    return false;
  } });
  sections.push({ text: source.slice(end), code: false });
  return sections;
}

/** Only the documented Markdown route is accepted; a native Yuque package is not guessed. */
export async function readYuqueExport(files: File[]): Promise<YuqueFileDocument[]> {
  if (!files.length || files.some((file) => !/\.(md|markdown|zip)$/i.test(file.name))) throw new Error("YUQUE_UNSUPPORTED_FILE");
  if (files.some((file) => file.size > 100 * 1024 * 1024)) throw new Error("YUQUE_FILE_TOO_LARGE");
  const documents: YuqueFileDocument[] = [];
  const scans = [];
  const loose = files.filter((file) => !/\.zip$/i.test(file.name));
  if (loose.length) scans.push(scanObsidianFolder(loose));
  for (const file of files.filter((item) => /\.zip$/i.test(item.name))) scans.push(await scanObsidianZip(file));
  for (const scan of scans) {
    const index = buildObsidianAssetIndex(scan.entries);
    const imageUrls = new Map<string, string>();
    for (const entry of scan.entries.filter((item) => item.kind === "note")) {
      const source = await readFile(entry.file, "text");
      const sections = markdownSections(source);
      const references = sections.filter((section) => !section.code).flatMap((section) => collectObsidianReferences(section.text, entry.vaultPath, index));
      const urls = new Map<string, string>();
      const warnings = new Set<string>();
      for (const reference of references) {
        const { resolution } = reference;
        if (resolution.entry?.kind === "image" && !/\.svg$/i.test(resolution.entry.fileName)) {
          const asset = resolution.entry;
          if (!imageUrls.has(asset.vaultPath)) imageUrls.set(asset.vaultPath, await readFile(asset.file, "dataURL"));
          urls.set(asset.vaultPath, imageUrls.get(asset.vaultPath)!);
        } else if (resolution.status === "missing" || resolution.status === "ambiguous") warnings.add("missingAsset");
        else if (resolution.entry) warnings.add("linkedAsset");
        else if (resolution.status === "external" && reference.syntax !== "markdown-link" && !/^data:/i.test(resolution.rawTarget)) warnings.add("remoteImage");
      }
      const content = sections.map((section) => section.code ? section.text : rewriteObsidianMarkdown(section.text, entry.vaultPath, index, urls)).join("");
      // Source identity uses the package directory and relative file path, never its title alone.
      const book = scan.source === "zip" ? scan.rootFolderName : "";
      documents.push({
        key: JSON.stringify([book, entry.vaultPath]), book,
        title: entry.fileName.replace(/\.(?:md|markdown)$/i, ""),
        path: [...(book ? [book] : []), ...entry.notebookPath],
        content, contentHash: await sha256(content), images: urls.size, warnings: [...warnings],
      });
    }
  }
  if (!documents.length) throw new Error("YUQUE_NO_MARKDOWN");
  const unique = new Map<string, YuqueFileDocument>();
  for (const doc of documents) {
    const previous = unique.get(doc.key);
    if (previous && previous.contentHash !== doc.contentHash) throw new Error("YUQUE_DUPLICATE_SOURCE");
    unique.set(doc.key, doc);
  }
  return [...unique.values()];
}

export async function yuqueImportNoteId(document: YuqueFileDocument, userId: string, workspaceId: string, target: string): Promise<string> {
  const hash = await sha256(JSON.stringify(["yuque-markdown-v1", userId, workspaceId, target, document.key, document.contentHash]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function notFound(error: unknown): boolean {
  return (error as { status?: number })?.status === 404 || (error as Error)?.message === "笔记不存在";
}

export async function importYuqueFiles(documents: YuqueFileDocument[], options: {
  userId: string; workspaceId: string; rootName: string; targetNotebookId?: string;
  onProgress?: (current: number, total: number, title: string) => void;
  shouldContinue?: () => boolean;
}): Promise<YuqueFileResult> {
  const result: YuqueFileResult = { created: 0, skipped: 0, failed: [] };
  if (!options.userId || !options.workspaceId) throw new Error("YUQUE_TARGET_REQUIRED");
  const accountScope = getOfflineQueueStorageKey();
  const canContinue = () => options.shouldContinue?.() !== false && getOfflineQueueStorageKey() === accountScope;
  let notebooks: Notebook[] | null = null;
  const ensureNotebook = async (name: string, parentId: string | null) => {
    if (!canContinue()) throw new Error("YUQUE_IMPORT_STOPPED");
    notebooks ??= await api.getNotebooks(options.workspaceId);
    if (!canContinue()) throw new Error("YUQUE_IMPORT_STOPPED");
    const existing = notebooks.find((item) => item.name === name && (item.parentId || null) === parentId);
    if (existing) return existing.id;
    const created = await api.createNotebook({ name, parentId, icon: "📥", workspaceId: options.workspaceId === "personal" ? null : options.workspaceId });
    notebooks.push(created);
    return created.id;
  };
  for (let index = 0; index < documents.length; index++) {
    if (!canContinue()) break;
    const document = documents[index];
    options.onProgress?.(index, documents.length, document.title);
    try {
      const id = await yuqueImportNoteId(document, options.userId, options.workspaceId, options.targetNotebookId || options.rootName);
      let existing: Note | null = null;
      try { existing = await api.getNote(id); } catch (error) { if (!notFound(error)) throw error; }
      if (existing) {
        result.skipped++;
        result.firstNoteId ??= existing.id;
        result.notebookId ??= existing.notebookId;
        continue;
      }
      let notebookId = options.targetNotebookId || await ensureNotebook(options.rootName, null);
      for (const segment of document.path) notebookId = await ensureNotebook(segment, notebookId);
      if (!canContinue()) break;
      let created: Note;
      try {
        created = await api.createNoteConfirmed({ id, notebookId, title: document.title, content: document.content, contentFormat: "markdown" });
        result.created++;
      } catch (error) {
        // A lost response or concurrent import may already have committed this exact source.
        if ((error as { status?: number })?.status !== 409) throw error;
        created = await api.getNote(id);
        result.skipped++;
      }
      result.firstNoteId ??= created.id;
      result.notebookId ??= created.notebookId;
    } catch (error) {
      result.failed.push({ key: document.key, title: document.title, message: error instanceof Error ? error.message : String(error) });
    } finally { options.onProgress?.(index + 1, documents.length, document.title); }
  }
  return result;
}

import { api } from "./api";
import { convertToTiptapJson, extractPlainText, type ImportFileInfo } from "./importService";
import type { ObsidianEntry, ObsidianImportOptions, ObsidianImportResult, ObsidianScanResult } from "./obsidianImportTypes";
import { obsidianMime, sanitizeNotebookSegment } from "./obsidianPath";
import { buildObsidianAssetIndex, collectObsidianReferences, rewriteObsidianMarkdown } from "./obsidianReferences";

export * from "./obsidianImportTypes";
export * from "./obsidianPath";
export * from "./obsidianScan";
export * from "./obsidianReferences";

function titleFrom(markdown: string, fallback: string): string {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || "";
  const title = frontmatter.match(/^title:\s*(.+?)\s*$/im)?.[1] || markdown.match(/^\s*#\s+(.+?)\s*$/m)?.[1] || fallback;
  return title.trim().replace(/^['"]|['"]$/g, "").slice(0, 120) || "未命名笔记";
}

function tiptap(markdown: string, entry: ObsidianEntry): { content: string; text: string } {
  const info: ImportFileInfo = { name: entry.vaultPath, title: entry.fileName.replace(/\.(?:md|markdown)$/i, ""), content: markdown, size: entry.size, selected: true, source: "md" };
  return { content: convertToTiptapJson(info), text: extractPlainText(info).slice(0, 20_000) };
}

function uploadName(name: string): string {
  return (name.split(/[\\/]/).pop() || name).replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, "_") || "file";
}

export async function runObsidianImport(scan: ObsidianScanResult, options: ObsidianImportOptions): Promise<ObsidianImportResult> {
  const root = sanitizeNotebookSegment(options.rootName || scan.rootFolderName || "Obsidian Vault");
  const notes = scan.entries.filter((entry) => entry.selected && entry.kind === "note");
  const assets = scan.entries.filter((entry) => entry.selected && entry.kind !== "note" && entry.kind !== "skipped");
  const index = buildObsidianAssetIndex(assets);
  const errors: string[] = [], warnings: string[] = [];
  const missing = new Set<string>(), ambiguous = new Set<string>(), used = new Set<string>();
  let noteCount = 0, attachmentCount = 0;
  if (!notes.length) return { success: false, noteCount, attachmentCount, errors: ["没有选择可导入的 Markdown 笔记"], warnings, missingReferences: [], ambiguousReferences: [], unusedAttachmentCount: assets.length };

  for (let i = 0; i < notes.length; i++) {
    const entry = notes[i];
    options.onProgress?.({ phase: "reading", current: i, total: notes.length, message: `解析 ${i + 1}/${notes.length}: ${entry.vaultPath}` });
    let noteId = "";
    try {
      const source = await entry.file.text();
      const title = titleFrom(source, entry.fileName.replace(/\.(?:md|markdown)$/i, ""));
      const notebookPath = [root, ...entry.notebookPath.map(sanitizeNotebookSegment)].filter(Boolean);
      const placeholder = tiptap(`# ${title}\n\n正在导入 Obsidian 笔记及附件…`, entry);
      const createdResult = await api.importNotes([{ title, content: placeholder.content, contentText: title, contentFormat: "tiptap-json", notebookPath, notebookName: notebookPath.at(-1), updatedAt: entry.lastModified ? new Date(entry.lastModified).toISOString() : undefined }]);
      const created = createdResult.notes?.[0];
      if (!createdResult.success || !created?.id) throw new Error("创建笔记占位记录失败");
      noteId = created.id;

      const resolvedAssets = new Map<string, ObsidianEntry>();
      for (const plan of collectObsidianReferences(source, entry.vaultPath, index)) {
        if (plan.resolution.status === "resolved" && plan.resolution.entry) {
          resolvedAssets.set(plan.resolution.entry.vaultPath, plan.resolution.entry);
          used.add(plan.resolution.entry.vaultPath);
        } else if (plan.resolution.status === "missing") missing.add(`${entry.vaultPath} → ${plan.rawTarget}`);
        else if (plan.resolution.status === "ambiguous") ambiguous.add(`${entry.vaultPath} → ${plan.rawTarget}（${(plan.resolution.candidates || []).join("、")}）`);
      }

      const urls = new Map<string, string>();
      let cursor = 0;
      for (const asset of resolvedAssets.values()) {
        cursor++;
        options.onProgress?.({ phase: "uploading", current: i, total: notes.length, message: `上传附件 ${cursor}/${resolvedAssets.size}: ${asset.fileName}` });
        try {
          const file = new File([asset.file], uploadName(asset.fileName), { type: asset.file.type || obsidianMime(asset.fileName), lastModified: asset.lastModified || Date.now() });
          const uploaded = await api.attachments.upload(noteId, file);
          if (!uploaded?.url) throw new Error("附件接口未返回 URL");
          urls.set(asset.vaultPath, uploaded.url);
          attachmentCount++;
        } catch (error) {
          errors.push(`${entry.vaultPath}: 附件 ${asset.vaultPath} 上传失败：${(error as Error).message}`);
        }
      }

      const final = tiptap(rewriteObsidianMarkdown(source, entry.vaultPath, index, urls), entry);
      await api.updateNote(noteId, { content: final.content, contentText: final.text, contentFormat: "tiptap-json", version: typeof created.version === "number" ? created.version : 1 });
      noteCount++;
    } catch (error) {
      const message = `${entry.vaultPath}: ${(error as Error).message}`;
      errors.push(message);
      if (noteId) {
        try {
          const latest = await api.getNote(noteId);
          const failed = tiptap(`# 导入未完成\n\n${message}`, entry);
          await api.updateNote(noteId, { content: failed.content, contentText: message, version: latest.version });
        } catch { /* keep primary error */ }
      }
    }
  }

  const unusedAttachmentCount = assets.filter((entry) => !used.has(entry.vaultPath)).length;
  if (unusedAttachmentCount) warnings.push(`${unusedAttachmentCount} 个未被笔记引用的附件未上传`);
  if (missing.size) warnings.push(`${missing.size} 个附件引用未找到源文件`);
  if (ambiguous.size) warnings.push(`${ambiguous.size} 个同名附件引用无法唯一匹配`);
  options.onProgress?.({ phase: errors.length ? "error" : "done", current: notes.length, total: notes.length, message: errors.length ? `完成：${noteCount} 篇成功，${errors.length} 条错误` : `成功导入 ${noteCount} 篇笔记和 ${attachmentCount} 个附件` });
  return { success: noteCount > 0, noteCount, attachmentCount, errors, warnings, missingReferences: [...missing], ambiguousReferences: [...ambiguous], unusedAttachmentCount };
}

export function formatObsidianFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

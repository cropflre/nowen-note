import { api } from "./api";
import {
  convertToTiptapJson,
  extractPlainText,
  type ImportFileInfo,
  type ImportTargetContentFormat,
} from "./importService";
import { knowledgeTreeApi } from "./knowledgeTreeApi";
import type {
  ObsidianEntry,
  ObsidianImportOptions,
  ObsidianImportResult,
  ObsidianScanResult,
} from "./obsidianImportTypes";
import {
  normalizeObsidianPath,
  obsidianMime,
  sanitizeNotebookSegment,
} from "./obsidianPath";
import {
  buildObsidianAssetIndex,
  collectObsidianReferences,
  rewriteObsidianMarkdown,
} from "./obsidianReferences";

export * from "./obsidianImportTypes";
export * from "./obsidianPath";
export * from "./obsidianScan";
export * from "./obsidianReferences";

const OBSIDIAN_ORIGIN_SOURCE = "obsidian-vault";

function titleFrom(markdown: string, fallback: string): string {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || "";
  const title = frontmatter.match(/^title:\s*(.+?)\s*$/im)?.[1]
    || markdown.match(/^\s*#\s+(.+?)\s*$/m)?.[1]
    || fallback;
  return title.trim().replace(/^['"]|['"]$/g, "").slice(0, 120) || "未命名笔记";
}

function formatNote(
  markdown: string,
  entry: ObsidianEntry,
  contentFormat: ImportTargetContentFormat,
): { content: string; text: string } {
  const info: ImportFileInfo = {
    name: entry.vaultPath,
    title: entry.fileName.replace(/\.(?:md|markdown)$/i, ""),
    content: markdown,
    size: entry.size,
    selected: true,
    source: "md",
  };
  return {
    content: contentFormat === "markdown" ? markdown : convertToTiptapJson(info),
    text: extractPlainText(info).slice(0, 20_000),
  };
}

function uploadName(name: string): string {
  return (name.split(/[\\/]/).pop() || name)
    // eslint-disable-next-line no-control-regex -- Control characters must be rejected or stripped at this data boundary.
    .replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, "_")
    || "file";
}

export function obsidianExternalId(scan: ObsidianScanResult, entry: ObsidianEntry): string {
  const root = normalizeObsidianPath(scan.rootFolderName || "Obsidian Vault") || "Obsidian Vault";
  return normalizeObsidianPath(`${root}/${entry.vaultPath}`);
}

type PreparedNote = {
  entry: ObsidianEntry;
  source: string;
  title: string;
  notebookPath: string[];
  externalId: string;
};

function emptyResult(
  assets: ObsidianEntry[],
  errors: string[],
  warnings: string[] = [],
): ObsidianImportResult {
  return {
    success: false,
    noteCount: 0,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    attachmentCount: 0,
    fileNodeCount: 0,
    errors,
    warnings,
    missingReferences: [],
    ambiguousReferences: [],
    unusedAttachmentCount: assets.length,
  };
}

export async function runObsidianImport(
  scan: ObsidianScanResult,
  options: ObsidianImportOptions,
): Promise<ObsidianImportResult> {
  const root = sanitizeNotebookSegment(options.rootName || scan.rootFolderName || "Obsidian Vault");
  const duplicateStrategy = options.duplicateStrategy || "skip";
  const notes = scan.entries.filter((entry) => entry.selected && entry.kind === "note");
  const assets = scan.entries.filter(
    (entry) => entry.selected && entry.kind !== "note" && entry.kind !== "skipped",
  );
  const index = buildObsidianAssetIndex(assets);
  const errors: string[] = [];
  const warnings: string[] = [];
  const missing = new Set<string>();
  const ambiguous = new Set<string>();
  const used = new Set<string>();
  const prepared: PreparedNote[] = [];

  if (!notes.length) {
    return emptyResult(assets, ["没有选择可导入的 Markdown 笔记"]);
  }

  // Pass 1: read every selected note and build one global attachment plan.
  // This fixes the old 0-based progress mismatch and prevents the same asset
  // from being uploaded once per referencing note.
  for (let i = 0; i < notes.length; i += 1) {
    const entry = notes[i];
    options.onProgress?.({
      phase: "reading",
      current: i + 1,
      total: notes.length,
      message: `解析 ${i + 1}/${notes.length}: ${entry.vaultPath}`,
    });
    try {
      const source = await entry.file.text();
      const title = titleFrom(source, entry.fileName.replace(/\.(?:md|markdown)$/i, ""));
      const notebookPath = [root, ...entry.notebookPath.map(sanitizeNotebookSegment)].filter(Boolean);
      prepared.push({
        entry,
        source,
        title,
        notebookPath,
        externalId: obsidianExternalId(scan, entry),
      });

      for (const plan of collectObsidianReferences(source, entry.vaultPath, index)) {
        if (plan.resolution.status === "resolved" && plan.resolution.entry) {
          used.add(plan.resolution.entry.vaultPath);
        } else if (plan.resolution.status === "missing") {
          missing.add(`${entry.vaultPath} → ${plan.rawTarget}`);
        } else if (plan.resolution.status === "ambiguous") {
          ambiguous.add(
            `${entry.vaultPath} → ${plan.rawTarget}（${(plan.resolution.candidates || []).join("、")}）`,
          );
        }
      }
    } catch (error) {
      errors.push(`${entry.vaultPath}: 读取失败：${(error as Error).message}`);
    }
  }

  if (!prepared.length) {
    return {
      ...emptyResult(assets, errors),
      missingReferences: [...missing],
      ambiguousReferences: [...ambiguous],
    };
  }

  let origins: Record<string, {
    externalId: string;
    noteId: string;
    title: string;
    notebookId: string;
    version: number;
    updatedAt: string;
    isTrashed: number;
  }> = {};
  if (duplicateStrategy !== "duplicate") {
    try {
      origins = (await api.resolveImportOrigins(
        OBSIDIAN_ORIGIN_SOURCE,
        prepared.map((item) => item.externalId),
      )).origins;
    } catch (error) {
      throw new Error(`重复导入检测失败：${(error as Error).message}`);
    }
  }

  const assetEntries = options.includeUnusedAttachments
    ? assets
    : assets.filter((entry) => used.has(entry.vaultPath));
  const urls = new Map<string, string>();
  const linkedFileIds = new Map<string, string>();
  let attachmentCount = 0;
  let fileNodeCount = 0;

  // Pass 2: upload each physical source asset once. File-manager upload is hash
  // deduplicated and does not require a placeholder note, so repeated imports
  // reuse the same stored bytes instead of multiplying attachments.
  for (let i = 0; i < assetEntries.length; i += 1) {
    const asset = assetEntries[i];
    options.onProgress?.({
      phase: "uploading",
      current: i + 1,
      total: assetEntries.length,
      message: `上传附件 ${i + 1}/${assetEntries.length}: ${asset.fileName}`,
    });
    try {
      const file = new File([asset.file], uploadName(asset.fileName), {
        type: asset.file.type || obsidianMime(asset.fileName),
        lastModified: asset.lastModified || Date.now(),
      });
      const uploaded = await api.files.upload(file);
      if (!uploaded?.url || !uploaded?.id) throw new Error("文件接口未返回完整信息");
      urls.set(asset.vaultPath, uploaded.url);
      attachmentCount += 1;

      const treePath = [root, ...asset.notebookPath.map(sanitizeNotebookSegment)].filter(Boolean);
      const pathKey = treePath.join("/");
      const previousPath = linkedFileIds.get(uploaded.id);
      if (!previousPath) {
        try {
          await knowledgeTreeApi.linkFile({ fileId: uploaded.id, notebookPath: treePath });
          linkedFileIds.set(uploaded.id, pathKey);
          fileNodeCount += 1;
        } catch (error) {
          warnings.push(`${asset.vaultPath}: 已上传，但加入知识树失败：${(error as Error).message}`);
        }
      } else if (previousPath !== pathKey) {
        warnings.push(
          `${asset.vaultPath}: 与 ${previousPath} 内容相同，已复用同一附件文件，目录中保留首次出现的位置`,
        );
      }
    } catch (error) {
      errors.push(`附件 ${asset.vaultPath} 上传失败：${(error as Error).message}`);
    }
  }

  let noteCount = 0;
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  // Pass 3: apply the duplicate strategy using the persistent source mapping.
  for (let i = 0; i < prepared.length; i += 1) {
    const item = prepared[i];
    options.onProgress?.({
      phase: "uploading",
      current: i + 1,
      total: prepared.length,
      message: `写入笔记 ${i + 1}/${prepared.length}: ${item.entry.vaultPath}`,
    });

    const origin = origins[item.externalId];
    if (origin?.isTrashed) {
      skippedCount += 1;
      warnings.push(`${item.entry.vaultPath}: 上次导入的笔记位于回收站，已跳过`);
      continue;
    }
    if (origin && duplicateStrategy === "skip") {
      skippedCount += 1;
      continue;
    }

    const rewritten = rewriteObsidianMarkdown(
      item.source,
      item.entry.vaultPath,
      index,
      urls,
    );
    const final = formatNote(rewritten, item.entry, options.contentFormat);

    try {
      if (origin && duplicateStrategy === "update") {
        const current = await api.getNote(origin.noteId);
        await api.updateNote(origin.noteId, {
          title: item.title,
          content: final.content,
          contentText: final.text,
          contentFormat: options.contentFormat,
          version: current.version,
        });
        updatedCount += 1;
        noteCount += 1;
        continue;
      }

      const createdResult = await api.importNotes([{
        title: item.title,
        content: final.content,
        contentText: final.text,
        contentFormat: options.contentFormat,
        notebookPath: item.notebookPath,
        notebookName: item.notebookPath.at(-1),
        updatedAt: item.entry.lastModified
          ? new Date(item.entry.lastModified).toISOString()
          : undefined,
      }]);
      const created = createdResult.notes?.[0];
      if (!createdResult.success || !created?.id) {
        throw new Error("创建笔记失败");
      }
      createdCount += 1;
      noteCount += 1;

      // First import establishes the stable server-side mapping. When the user
      // explicitly chooses "keep a copy" for an existing source, keep the
      // original mapping untouched so future skip/update remains deterministic.
      if (!origin) {
        const registered = await api.registerImportOrigin({
          sourceType: OBSIDIAN_ORIGIN_SOURCE,
          externalId: item.externalId,
          noteId: created.id,
          metadata: {
            vaultRoot: scan.rootFolderName,
            vaultPath: item.entry.vaultPath,
          },
        });
        if (registered.conflict && registered.noteId !== created.id) {
          warnings.push(`${item.entry.vaultPath}: 来源映射发生并发冲突，已保留本次导入副本`);
        }
      }
    } catch (error) {
      errors.push(`${item.entry.vaultPath}: ${(error as Error).message}`);
    }
  }

  const unusedAttachmentCount = assets.filter((entry) => !used.has(entry.vaultPath)).length;
  if (unusedAttachmentCount && !options.includeUnusedAttachments) {
    warnings.push(`${unusedAttachmentCount} 个未被笔记引用的附件未上传`);
  } else if (unusedAttachmentCount && options.includeUnusedAttachments) {
    warnings.push(`${unusedAttachmentCount} 个未引用附件已作为独立文件导入目录树`);
  }
  if (missing.size) warnings.push(`${missing.size} 个附件引用未找到源文件`);
  if (ambiguous.size) warnings.push(`${ambiguous.size} 个同名附件引用无法唯一匹配`);

  const success = noteCount > 0 || skippedCount > 0;
  const summary = [
    createdCount ? `新建 ${createdCount}` : "",
    updatedCount ? `更新 ${updatedCount}` : "",
    skippedCount ? `跳过 ${skippedCount}` : "",
  ].filter(Boolean).join("，");
  options.onProgress?.({
    phase: errors.length ? "error" : "done",
    current: prepared.length,
    total: prepared.length,
    message: errors.length
      ? `完成：${summary || "无成功笔记"}，${errors.length} 条错误`
      : `完成：${summary || "无变更"}；${attachmentCount} 个附件`,
  });

  return {
    success,
    noteCount,
    createdCount,
    updatedCount,
    skippedCount,
    attachmentCount,
    fileNodeCount,
    errors,
    warnings,
    missingReferences: [...missing],
    ambiguousReferences: [...ambiguous],
    unusedAttachmentCount,
  };
}

export function formatObsidianFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

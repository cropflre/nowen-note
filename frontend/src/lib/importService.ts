import { getBaseUrl } from "./api";
import {
  readMarkdownFromZipWithMeta as readMarkdownFromZipWithMetaBase,
  importNotes as importNotesBase,
} from "./importService.base";
import type {
  ImportFileInfo,
  ImportOptions,
  ImportProgress,
  ZipImportMeta,
} from "./importService.base";
import {
  requestRoundTripImportReview,
  type RoundTripPackagePreview,
} from "./roundTripImportReview";

export {
  tiptapExtensions,
  MAX_PDF_SIZE,
  PDF_NO_TEXT_LAYER_FLAG,
  PDF_TOO_LARGE_FLAG,
  deriveNotebookNameFromFile,
  readMarkdownFiles,
  markdownToSimpleHtml,
  convertToTiptapJson,
  extractPlainText,
  importMarkdownAsNote,
} from "./importService.base";
export type {
  ImportFileInfo,
  ImportOptions,
  ImportProgress,
  ZipImportMeta,
  ImportMarkdownAsNoteResult,
} from "./importService.base";

type RoundTripImportFile = ImportFileInfo & {
  __nowenRoundTripPackage?: File;
  __nowenPackageVersion?: number;
  __nowenPackageKind?: string;
};

interface PackageManifestPreview {
  format?: string;
  formatVersion?: number;
  packageKind?: string;
  app?: string;
  exportedAt?: string;
  counts?: {
    notebooks?: number;
    notes?: number;
    attachments?: number;
  };
}

async function readRoundTripManifest(file: File): Promise<PackageManifestPreview | null> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(file);
    const entry = zip.file("manifest.json");
    if (!entry) return null;
    const manifest = JSON.parse(await entry.async("string")) as PackageManifestPreview;
    if (
      manifest?.format !== "nowen-package" ||
      manifest?.app !== "nowen-note" ||
      ![1, 2].includes(Number(manifest.formatVersion))
    ) return null;
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Nowen 自己导出的 Markdown ZIP 和 .nowen.zip 都携带 round-trip manifest。
 * 这类包不能再走“逐个 Markdown 文件推断目录”的旧链路，否则空目录、普通附件、
 * 排序和稳定 ID 映射都会丢失。这里只返回一个包级占位项，正式导入交给服务端事务。
 */
export async function readMarkdownFromZipWithMeta(
  file: File,
): Promise<{ files: ImportFileInfo[]; meta: ZipImportMeta | null }> {
  const manifest = await readRoundTripManifest(file);
  if (!manifest) return readMarkdownFromZipWithMetaBase(file);

  const title = file.name.replace(/(?:\.nowen)?\.zip$/i, "") || "Nowen 数据包";
  const packageEntry: RoundTripImportFile = {
    name: file.name,
    title,
    content: "",
    size: file.size,
    selected: true,
    source: "nowen-package",
    __nowenRoundTripPackage: file,
    __nowenPackageVersion: Number(manifest.formatVersion),
    __nowenPackageKind: manifest.packageKind || "nowen",
  };
  const meta = {
    version: String(manifest.formatVersion || ""),
    app: "nowen-note",
    exportedAt: manifest.exportedAt,
    totalNotes: manifest.counts?.notes,
    notebooks: [],
  } as ZipImportMeta;
  return { files: [packageEntry], meta };
}

export async function readMarkdownFromZip(file: File): Promise<ImportFileInfo[]> {
  return (await readMarkdownFromZipWithMeta(file)).files;
}

async function postRoundTripPackage(
  file: File,
  workspaceId: string | undefined,
  dryRun: boolean,
): Promise<RoundTripPackagePreview> {
  const token = localStorage.getItem("nowen-token");
  const params = new URLSearchParams();
  if (workspaceId && workspaceId !== "personal") params.set("workspaceId", workspaceId);
  params.set("importMode", "new-root");
  if (dryRun) params.set("dryRun", "1");
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${getBaseUrl()}/export/import/nowen-package?${params.toString()}`, {
    method: "POST",
    credentials: "include",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form,
  });
  const payload = await response.json().catch(() => ({})) as RoundTripPackagePreview & { error?: string };
  if (!response.ok || payload?.success === false) {
    const detail = Array.isArray(payload?.errors) && payload.errors.length
      ? payload.errors.join("；")
      : payload?.error;
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return payload;
}

function targetLabel(workspaceId?: string): string {
  if (!workspaceId || workspaceId === "personal") return "个人空间";
  return "所选工作区";
}

/**
 * Round-trip package import is atomic and defaults to an independent copy. A conflicting source
 * root is renamed by the server to “名称 (2)”, while the subtree itself remains unchanged.
 */
export async function importNotes(
  fileInfos: ImportFileInfo[],
  notebookId?: string,
  onProgress?: (progress: ImportProgress) => void,
  options?: ImportOptions,
): Promise<{ success: boolean; count: number }> {
  const selected = fileInfos.filter((item) => item.selected) as RoundTripImportFile[];
  const packageItems = selected.filter((item) => item.__nowenRoundTripPackage instanceof File);
  if (!packageItems.length) return importNotesBase(fileInfos, notebookId, onProgress, options);
  if (packageItems.length !== 1 || selected.length !== 1) {
    onProgress?.({ phase: "error", current: 0, total: selected.length, message: "Nowen 数据包必须单独导入" });
    return { success: false, count: 0 };
  }

  const file = packageItems[0].__nowenRoundTripPackage!;
  try {
    onProgress?.({ phase: "reading", current: 0, total: 1, message: "正在校验目录、附件和冲突…" });
    const preview = await postRoundTripPackage(file, options?.workspaceId, true);
    const accepted = await requestRoundTripImportReview(preview, {
      fileName: file.name,
      targetLabel: targetLabel(options?.workspaceId),
      source: "shared-import",
    });
    if (!accepted) {
      onProgress?.({ phase: "error", current: 0, total: 1, message: "已取消导入，未写入任何数据" });
      return { success: false, count: 0 };
    }

    const conflicts = Array.isArray(preview?.conflicts) ? preview.conflicts.length : 0;
    onProgress?.({
      phase: "uploading",
      current: 0,
      total: 1,
      message: conflicts > 0
        ? `已确认 ${conflicts} 个根目录重命名方案，正在创建独立副本`
        : "预检已确认，正在原样恢复目录和附件…",
    });
    const result = await postRoundTripPackage(file, options?.workspaceId, false);
    const importedCount = Number(result?.counts?.notes || 0);
    const warningCount = Array.isArray(result?.warnings) ? result.warnings.length : 0;
    onProgress?.({
      phase: "done",
      current: importedCount,
      total: importedCount,
      message: warningCount > 0
        ? `导入完成，共 ${importedCount} 篇笔记，${warningCount} 项需要检查`
        : `导入完成，共 ${importedCount} 篇笔记`,
    });
    return { success: true, count: importedCount };
  } catch (error) {
    onProgress?.({
      phase: "error",
      current: 0,
      total: 1,
      message: `导入失败：${error instanceof Error ? error.message : String(error)}`,
    });
    return { success: false, count: 0 };
  }
}

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
  submitRoundTripPackage,
  type RoundTripImportStrategy,
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

function targetLabel(workspaceId?: string): string {
  if (!workspaceId || workspaceId === "personal") return "个人空间";
  return "所选工作区";
}

/**
 * Round-trip package import is atomic. Copy remains the safe default; merge reuses exact sibling
 * folders; sync only updates stable source mappings that have no local edits.
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
  const submitOptionsFor = (strategy: RoundTripImportStrategy) => ({
    workspaceId: options?.workspaceId,
    // Sync always follows the source→target mappings recorded by the first import. A folder
    // currently selected in the import UI must not relocate mapped resources accidentally.
    targetNotebookId: strategy === "sync" ? undefined : notebookId || undefined,
  });
  try {
    onProgress?.({ phase: "reading", current: 0, total: 1, message: "正在校验目录、附件、来源映射和成员清单…" });
    const copyPreview = await submitRoundTripPackage(file, {
      ...submitOptionsFor("copy"),
      dryRun: true,
      strategy: "copy",
    });
    const decision = await requestRoundTripImportReview(copyPreview, {
      fileName: file.name,
      targetLabel: targetLabel(options?.workspaceId),
      source: "shared-import",
      initialStrategy: "copy",
      loadPreview: (strategy) => submitRoundTripPackage(file, {
        ...submitOptionsFor(strategy),
        dryRun: true,
        strategy,
      }),
    });
    if (!decision.accepted) {
      onProgress?.({ phase: "error", current: 0, total: 1, message: "已取消导入，未写入任何数据" });
      return { success: false, count: 0 };
    }

    const selectedPreview = decision.strategy === "copy"
      ? copyPreview
      : await submitRoundTripPackage(file, {
        ...submitOptionsFor(decision.strategy),
        dryRun: true,
        strategy: decision.strategy,
      });
    const conflicts = Array.isArray(selectedPreview?.conflicts) ? selectedPreview.conflicts.length : 0;
    const permissionSuffix = decision.applyPermissions
      ? `，并恢复 ${Object.keys(decision.permissionMappings).length} 个已映射成员`
      : "";
    onProgress?.({
      phase: "uploading",
      current: 0,
      total: 1,
      message: decision.strategy === "sync"
        ? `正在执行安全增量同步${conflicts ? `（${conflicts} 项变更或冲突）` : ""}${permissionSuffix}…`
        : decision.strategy === "merge"
          ? `正在按合并计划导入${conflicts ? `（${conflicts} 项处理）` : ""}${permissionSuffix}…`
          : conflicts > 0
            ? `已确认 ${conflicts} 个重名处理方案，正在创建独立副本${permissionSuffix}`
            : `预检已确认，正在原样恢复目录和附件${permissionSuffix}…`,
    });
    const result = await submitRoundTripPackage(file, {
      ...submitOptionsFor(decision.strategy),
      dryRun: false,
      strategy: decision.strategy,
      applyPermissions: decision.applyPermissions,
      permissionMappings: decision.permissionMappings,
    });

    const createdNotes = Number(result?.counts?.notes || 0);
    const updatedNotes = Number(result?.counts?.updatedNotes || 0);
    const affectedCount = createdNotes + updatedNotes;
    const warningCount = Array.isArray(result?.warnings) ? result.warnings.length : 0;
    const mergedCount = Number(result?.counts?.mergedNotebooks || 0);
    const renamedCount = Number(result?.counts?.renamedNotes || 0);
    const unchangedCount = Number(result?.counts?.unchangedNotes || 0);
    const localConflictCount = Number(result?.counts?.localConflicts || 0);
    const permissionReport = result.permissionImport;
    const appliedPermissionCount = Number(permissionReport?.counts?.workspaceAdded || 0)
      + Number(permissionReport?.counts?.workspaceUpgraded || 0)
      + Number(permissionReport?.counts?.notebookAdded || 0)
      + Number(permissionReport?.counts?.notebookUpgraded || 0);
    const permissionDoneSuffix = decision.applyPermissions
      ? appliedPermissionCount > 0
        ? `，已应用 ${appliedPermissionCount} 项成员权限`
        : "，成员权限未产生变更"
      : "";

    onProgress?.({
      phase: "done",
      current: affectedCount,
      total: affectedCount,
      message: decision.strategy === "sync"
        ? `同步完成，新增 ${createdNotes} 篇、更新 ${updatedNotes} 篇、无需变更 ${unchangedCount} 篇${localConflictCount ? `，${localConflictCount} 项本地修改已保留` : ""}${permissionDoneSuffix}`
        : decision.strategy === "merge"
          ? `导入完成，共 ${createdNotes} 篇笔记，复用 ${mergedCount} 个目录${renamedCount ? `，${renamedCount} 篇同名笔记已编号` : ""}${permissionDoneSuffix}`
          : warningCount > 0
            ? `导入完成，共 ${createdNotes} 篇笔记，${warningCount} 项需要检查${permissionDoneSuffix}`
            : `导入完成，共 ${createdNotes} 篇笔记${permissionDoneSuffix}`,
    });
    return { success: true, count: decision.strategy === "sync" ? affectedCount : createdNotes };
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

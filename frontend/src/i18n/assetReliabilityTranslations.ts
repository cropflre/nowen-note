export const zhCNAssetReliabilityTranslations = {
  assetTrash: {
    title: "文件回收站", move: "移入回收站", moveHint: "将 {{count}} 个文件移入回收站，保留原件以便恢复。被笔记引用或仍有有效分享的文件会受到保护。",
    moved: "已将 {{count}} 个文件移入回收站", restore: "恢复所选文件", purge: "永久删除所选文件",
    purgeHint: "永久删除 {{count}} 个文件后无法从回收站恢复。系统会再次检查引用和分享，仍在使用的文件不会被删除。",
    hint: "回收站保留原始文件和附件 ID，不会自动清空。恢复时返回原文件夹；原文件夹已删除则回到未归档。公开外链需重新手动开启。",
    empty: "回收站为空", fallback: "原文件夹已不存在，文件已恢复到未归档。", cleanupPending: "记录已删除，部分存储对象清理失败，请检查存储服务。",
    nativeUnavailable: "Native 模式暂不支持文件回收站，请在服务器网页端管理。",
  },
};
export const enAssetReliabilityTranslations = {
  assetTrash: {
    title: "File recycle bin", move: "Move to recycle bin", moveHint: "Move {{count}} files to the recycle bin, keeping their originals recoverable. Files used by notes or active shares are protected.",
    moved: "Moved {{count}} files to the recycle bin", restore: "Restore selected", purge: "Permanently delete selected",
    purgeHint: "Permanently delete {{count}} files? This cannot be undone. References and shares are checked again; files still in use will be retained.",
    hint: "Original files and attachment IDs are retained with no automatic expiry. Restore returns files to their original folders, or Unorganized if the folder was removed. Public links must be explicitly enabled again.",
    empty: "The recycle bin is empty", fallback: "The original folder no longer exists. Files were restored to Unorganized.", cleanupPending: "Records were deleted but some storage objects could not be removed. Check the storage service.",
    nativeUnavailable: "The file recycle bin is unavailable in Native mode. Manage it in the server web app.",
  },
};

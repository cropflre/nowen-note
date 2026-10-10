interface FolderSyncAttachmentContentInput {
  title: string;
  filename: string;
  relativePath: string;
  sha256: string;
  attachmentId: string;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1");
}

/** 构建同步附件笔记的可见正文；内部同步标记由路由统一追加。 */
export function buildFolderSyncAttachmentBaseContent({
  title,
  filename,
  relativePath,
  sha256,
  attachmentId,
}: FolderSyncAttachmentContentInput): string {
  return [
    `# ${title}`,
    "",
    "此文件来自桌面端文件夹同步。",
    "",
    `[📎 ${escapeMarkdownLabel(filename)}](/api/attachments/${attachmentId})`,
    "",
    `- 文件名：${filename}`,
    `- 相对路径：${relativePath}`,
    `- SHA-256：${sha256}`,
  ].join("\n");
}

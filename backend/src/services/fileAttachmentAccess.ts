import { getUserWorkspaceRole, hasRole } from "../middleware/acl";
import {
  hasKnowledgeCapability,
  resolveResourceKnowledgeAccess,
} from "./knowledgeCapabilities";

export const FILE_MANAGER_UPLOAD_SOURCE = "file_manager";

export interface FileAttachmentAccessRow {
  id?: string;
  noteId: string;
  userId: string;
  workspaceId: string | null;
  uploadSource?: string | null;
}

export interface FileAttachmentAccess {
  canView: boolean;
  canDownload: boolean;
  canWrite: boolean;
  source: "manual-upload" | "note";
}

export function isManualFileManagerUpload(
  row: Pick<FileAttachmentAccessRow, "uploadSource">,
): boolean {
  return row.uploadSource === FILE_MANAGER_UPLOAD_SOURCE;
}

/**
 * 文件管理手动上传是独立资产，不应把隐藏 holder note 当成真实授权主体。
 *
 * - 个人空间：上传者本人可见/下载/管理；
 * - 工作区：当前工作区成员可见/下载；上传者本人且 editor+ 可管理；
 * - 其他附件：继续沿用所属笔记的 Knowledge Tree capability。
 *
 * 这样旧数据库即使缺失 holder note 的 knowledge_tree projection，也不会出现
 * “统计有数量、磁盘有文件、文件管理列表为空”的假性数据丢失。
 */
export function resolveFileAttachmentAccess(
  row: FileAttachmentAccessRow,
  userId: string,
): FileAttachmentAccess {
  if (isManualFileManagerUpload(row)) {
    if (!row.workspaceId) {
      const ownsFile = row.userId === userId;
      return {
        canView: ownsFile,
        canDownload: ownsFile,
        canWrite: ownsFile,
        source: "manual-upload",
      };
    }

    const role = getUserWorkspaceRole(row.workspaceId, userId);
    const canView = role !== null;
    return {
      canView,
      canDownload: canView,
      canWrite: row.userId === userId && hasRole(role, "editor"),
      source: "manual-upload",
    };
  }

  if (!row.noteId) {
    return {
      canView: false,
      canDownload: false,
      canWrite: false,
      source: "note",
    };
  }

  const access = resolveResourceKnowledgeAccess("note", row.noteId, userId);
  return {
    canView: hasKnowledgeCapability(access, "canView"),
    canDownload: hasKnowledgeCapability(access, "canDownload"),
    canWrite: hasKnowledgeCapability(access, "canEdit"),
    source: "note",
  };
}

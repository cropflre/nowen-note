/**
 * Attachment Query Service
 *
 * 职责：
 * - 承接附件域跨表复杂查询（UNION ALL / EXISTS / 多表 JOIN）
 * - 不处理 HTTP / 鉴权 / 文件删除 / 对象存储
 * - 数据库访问统一委托给 Repository 边界
 * - 返回与原 SQL 一致的数据结构
 *
 * 设计原则：
 * - 单表 CRUD 仍由各 Repository 负责
 * - 跨表查询、复杂搜索、统计归 QueryService
 * - PostgreSQL 同步/异步双库实现由 #249 统一推进
 */

import { attachmentQueryRepository } from "../repositories/attachmentQueryRepository";

export interface AttachmentPathEntry {
  path: string;
  size: number;
  refs: number;
}

export interface NoteReference {
  id: string;
  title: string;
  notebookId: string | null;
  isTrashed: number;
  updatedAt: string;
  notebookName: string | null;
  notebookIcon: string | null;
}

export interface MyUploadsSummary {
  total: number;
  referenced: number;
  unreferenced: number;
}

export const attachmentQueryService = {
  /** 获取所有已注册附件的唯一路径列表（含引用计数）。 */
  getUniqueAttachmentPaths(limit: number): AttachmentPathEntry[] {
    return attachmentQueryRepository.getUniqueAttachmentPaths(limit);
  },

  /** 统计所有已注册附件的唯一路径数量。 */
  countUniqueAttachmentPaths(): number {
    return attachmentQueryRepository.countUniqueAttachmentPaths();
  },

  /** 统计“我的上传”的引用状态摘要。 */
  getMyUploadsSummary(
    scope: "personal" | "workspace",
    userId: string,
    workspaceId?: string,
  ): MyUploadsSummary {
    return attachmentQueryRepository.getMyUploadsSummary(scope, userId, workspaceId);
  },

  /** 获取引用指定附件的笔记列表（含笔记本信息）。 */
  getNotesReferencingAttachment(
    attachmentId: string,
    scope: "personal" | "workspace",
    userId: string,
    workspaceId?: string,
  ): NoteReference[] {
    return attachmentQueryRepository.getNotesReferencingAttachment(
      attachmentId,
      scope,
      userId,
      workspaceId,
    );
  },
};

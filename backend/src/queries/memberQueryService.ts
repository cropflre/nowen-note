/**
 * Member Query Service
 *
 * 职责：
 * - 承接成员 / 权限相关复杂查询（notebook_members / notes / notebooks JOIN）
 * - 不处理 HTTP / 鉴权 / 业务日志
 * - 数据库访问统一委托给 Repository 边界
 * - 返回与原 SQL 一致的数据结构
 *
 * 设计原则：
 * - 单表 CRUD 仍由各 Repository 负责
 * - 跨表权限查询归 QueryService
 * - notebook-permissions.ts 作为服务层薄包装，内部调用 memberQueryService
 * - PostgreSQL 同步/异步双库实现由 #249 统一推进
 */

import { memberQueryRepository } from "../repositories/memberQueryRepository";

export const memberQueryService = {
  /** 获取用户在指定笔记本中的角色。 */
  getNotebookMemberRole(
    notebookId: string,
    userId: string,
  ): { role: string } | undefined {
    return memberQueryRepository.getNotebookMemberRole(notebookId, userId);
  },

  /** 获取用户在指定笔记所属笔记本中的角色。 */
  getNoteNotebookMemberRole(
    noteId: string,
    userId: string,
  ): { role: string } | undefined {
    return memberQueryRepository.getNoteNotebookMemberRole(noteId, userId);
  },

  /** 列出用户参与的共享笔记本 ID。 */
  listSharedNotebookIds(userId: string): string[] {
    return memberQueryRepository.listSharedNotebookIds(userId);
  },
};

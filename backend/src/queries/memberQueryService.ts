/**
 * Member Query Service
 *
 * Complex member and inherited ACL queries are delegated to a Repository boundary.
 */
import {
  memberQueryRepository,
  type NotebookMemberAccessRow,
} from "../repositories/memberQueryRepository";

export type { NotebookMemberAccessRow } from "../repositories/memberQueryRepository";

export const memberQueryService = {
  getNotebookMemberAccess(
    notebookId: string,
    userId: string,
  ): NotebookMemberAccessRow | undefined {
    return memberQueryRepository.getNotebookMemberAccess(notebookId, userId);
  },

  getNotebookMemberRole(
    notebookId: string,
    userId: string,
  ): { role: string } | undefined {
    return memberQueryRepository.getNotebookMemberRole(notebookId, userId);
  },

  getNoteNotebookMemberAccess(
    noteId: string,
    userId: string,
  ): NotebookMemberAccessRow | undefined {
    return memberQueryRepository.getNoteNotebookMemberAccess(noteId, userId);
  },

  getNoteNotebookMemberRole(
    noteId: string,
    userId: string,
  ): { role: string } | undefined {
    return memberQueryRepository.getNoteNotebookMemberRole(noteId, userId);
  },

  listSharedNotebookIds(userId: string): string[] {
    return memberQueryRepository.listSharedNotebookIds(userId);
  },
};

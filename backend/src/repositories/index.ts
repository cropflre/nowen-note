import "./noteWriteSafety";

/**
 * Repositories 统一导出
 *
 * 职责：
 * - 提供统一的导入入口
 * - 便于后续扩展其他 Repository
 */

export { systemSettingsRepository } from "./systemSettingsRepository";
export { customFontsRepository } from "./customFontsRepository";
export { apiTokensRepository } from "./apiTokensRepository";
export { calendarExportTargetsRepository } from "./calendarExportTargetsRepository";
export { noteLinksRepository } from "./noteLinksRepository";
export { tagsRepository } from "./tagsRepository";
export { noteTagsRepository } from "./noteTagsRepository";
export { tagOperationsRepository } from "./tagOperationsRepository";
export { aiCustomPromptsRepository } from "./aiCustomPromptsRepository";
export { noteVersionsRepository } from "./noteVersionsRepository";
export { favoritesRepository } from "./favoritesRepository";
export { userSessionsRepository } from "./userSessionsRepository";
export { userSecurityRepository } from "./userSecurityRepository";
export { taskRemindersRepository } from "./taskRemindersRepository";
export { taskProjectsRepository } from "./taskProjectsRepository";
export { taskTemplatesRepository } from "./taskTemplatesRepository";
export { taskTemplateApplyRepository } from "./taskTemplateApplyRepository";
export { folderSyncFilesRepository } from "./folderSyncFilesRepository";
export { attachmentFoldersRepository } from "./attachmentFoldersRepository";
export { attachmentFolderOperationsRepository } from "./attachmentFolderOperationsRepository";
export { attachmentMediaRepository } from "./attachmentMediaRepository";
export { mindmapFoldersRepository } from "./mindmapFoldersRepository";
export { mindmapFolderOperationsRepository } from "./mindmapFolderOperationsRepository";
export { taskCalendarFeedsRepository } from "./taskCalendarFeedsRepository";
export { taskDependenciesRepository } from "./taskDependenciesRepository";
export { taskDependencyOperationsRepository } from "./taskDependencyOperationsRepository";
export { workspaceInvitesRepository } from "./workspaceInvitesRepository";
export { notebookShareLinksRepository } from "./notebookShareLinksRepository";
export { noteAclRepository } from "./noteAclRepository";
export { taskAttachmentsRepository } from "./taskAttachmentsRepository";
export { taskAttachmentOperationsRepository } from "./taskAttachmentOperationsRepository";
export { attachmentReferencesRepository } from "./attachmentReferencesRepository";
export { noteYsnapshotsRepository } from "./noteYsnapshotsRepository";
export { attachmentChunksRepository } from "./attachmentChunksRepository";
export { noteYupdatesRepository } from "./noteYupdatesRepository";
export { workspaceMembersRepository } from "./workspaceMembersRepository";
export { notebookMembersRepository } from "./notebookMembersRepository";
export { shareCommentsRepository } from "./shareCommentsRepository";
export { diaryAttachmentsRepository } from "./diaryAttachmentsRepository";
export { embeddingQueueRepository } from "./embeddingQueueRepository";

// 类型导出
export type {
  SystemSetting,
  CustomFont,
  ApiTokenRecord,
  ApiTokenListItem,
  ApiTokenLookupRow,
  ApiTokenUsageRow,
  CreateApiTokenInput,
  CalendarExportTargetRecord,
  CalendarExportTargetRecordBoolean,
  CreateCalendarExportTargetInput,
  UpdateCalendarExportTargetInput,
  UpdateCalendarExportTargetStatusInput,
  BacklinkItem,
  NoteLinkEntry,
  Tag,
  TagWithCount,
  UpdateTagInput,
} from "./types";
export type { AiCustomPromptRecord } from "./aiCustomPromptsRepository";
export type { NoteVersionListItem, NoteVersionRecord } from "./noteVersionsRepository";

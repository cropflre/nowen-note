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
} from "./types";

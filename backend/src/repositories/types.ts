/**
 * Repository 共享类型定义
 *
 * 职责：
 * - 定义 Repository 方法的参数/返回值类型
 * - 确保类型在整个项目中一致使用
 */

/** system_settings 表结构 */
export interface SystemSetting {
  key: string;
  value: string;
  updatedAt: string;
}

/** custom_fonts 表结构 */
export interface CustomFont {
  id: string;
  name: string;
  fileName: string;
  format: string;
  fileSize: number;
  createdAt: string;
}

/** api_tokens 表结构（完整记录） */
export interface ApiTokenRecord {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  scopes: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** api_tokens 列表项（不含 tokenHash） */
export interface ApiTokenListItem {
  id: string;
  name: string;
  scopes: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** api_token_usage 聚合行 */
export interface ApiTokenUsageRow {
  day: string;
  count: number;
}

/** 创建 api_token 输入 */
export interface CreateApiTokenInput {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  expiresAt: string | null;
}

/** api_token 查询结果（用于鉴权链路） */
export interface ApiTokenLookupRow {
  id: string;
  userId: string;
  scopes: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

// ===== Calendar Export Targets =====

/** calendar_export_targets 表结构（SQLite 原始值） */
export interface CalendarExportTargetRecord {
  id: string;
  userId: string;
  feedId: string;
  type: string;
  enabled: number; // SQLite 0/1
  name: string;
  configJson: string;
  publicUrl: string | null;
  lastExportAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** calendar_export_targets 表结构（enabled 转为 boolean） */
export interface CalendarExportTargetRecordBoolean extends Omit<CalendarExportTargetRecord, "enabled"> {
  enabled: boolean;
}

/** 创建 calendar_export_target 输入 */
export interface CreateCalendarExportTargetInput {
  id: string;
  userId: string;
  feedId: string;
  type: string;
  enabled: number;
  name: string;
  configJson: string;
}

/** 更新 calendar_export_target 输入（按 id + userId） */
export interface UpdateCalendarExportTargetInput {
  name?: string;
  enabled?: number;
  configJson?: string;
}

/** 更新 calendar_export_target 状态输入（按 id，不含 userId） */
export interface UpdateCalendarExportTargetStatusInput {
  lastStatus?: string;
  publicUrl?: string;
  lastError?: string;
}

// ===== Note Links =====

/** 反向链接条目 */
export interface BacklinkItem {
  sourceNoteId: string;
  sourceBlockId: string | null;
  sourceNotebookId: string;
  title: string;
  updatedAt: string;
  linkText: string | null;
  linkType: string;
  targetBlockId: string | null;
  excerpt: string | null;
}

/** 笔记引用链接条目（用于 syncNoteLinks） */
export interface NoteLinkEntry {
  targetNoteId: string;
  targetBlockId: string | null;
  sourceBlockId: string | null;
  linkType: "note" | "block";
  linkText: string | null;
  excerpt: string | null;
}

// ===== Tags =====

/** 标签条目 */
export interface Tag {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  color: string;
  createdAt: string;
}

/** 标签条目（含笔记数） */
export interface TagWithCount extends Tag {
  noteCount: number;
}

/** 更新标签输入 */
export interface UpdateTagInput {
  name?: string;
  color?: string;
}

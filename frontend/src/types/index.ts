export interface User {
  id: string;
  username: string;
  email: string | null;
  avatarUrl: string | null;
  displayName?: string | null;
  role?: "admin" | "user";
  isDisabled?: 0 | 1 | number;
  createdAt: string;
  updatedAt?: string;
  lastLoginAt?: string | null;
  noteCount?: number;
  notebookCount?: number;
}

/** 搜索用户（用于 @提及、邀请等公开场景，只包含公开字段） */
export interface UserPublicInfo {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

// ========== 多用户协作（Phase 1） ==========

export type WorkspaceRole = "owner" | "admin" | "editor" | "commenter" | "viewer";
export type WorkspacePermission = "read" | "comment" | "write" | "manage";

export interface Workspace {
  id: string;
  name: string;
  description: string;
  icon: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  role?: WorkspaceRole;     // 当前用户在该工作区的角色
  memberCount?: number;
  notebookCount?: number;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAt: string;
  username: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  code: string;
  role: WorkspaceRole;
  maxUses: number;
  useCount: number;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface Notebook {
  id: string;
  userId: string;
  workspaceId: string | null;   // Phase 1 新增
  parentId: string | null;
  name: string;
  description: string | null;
  icon: string;
  color: string | null;
  sortOrder: number;
  isExpanded: number;
  createdAt: string;
  updatedAt: string;
  noteCount?: number;
  children?: Notebook[];
}

export interface Note {
  id: string;
  userId: string;
  notebookId: string;
  workspaceId: string | null;   // Phase 1 新增
  title: string;
  content: string;
  contentText: string;
  isPinned: number;
  isFavorite: number;
  isLocked: number;
  isArchived: number;
  isTrashed: number;
  trashedAt: string | null;
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  tags?: Tag[];
  permission?: WorkspacePermission; // Phase 1 新增
}

export interface NoteListItem {
  id: string;
  userId: string;
  notebookId: string;
  workspaceId: string | null;   // Phase 1 新增
  title: string;
  contentText: string;
  isPinned: number;
  isFavorite: number;
  isLocked: number;
  isArchived: number;
  isTrashed: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Tag {
  id: string;
  userId: string;
  name: string;
  color: string;
  createdAt: string;
  noteCount?: number;
}

export interface SearchResult {
  id: string;
  title: string;
  notebookId: string;
  updatedAt: string;
  isFavorite: number;
  isPinned: number;
  snippet: string;
}

export type ViewMode = "notebook" | "favorites" | "trash" | "all" | "search" | "tasks" | "tag" | "mindmaps" | "ai-chat" | "diary";







export type TaskPriority = 1 | 2 | 3; // 1=低, 2=中, 3=高

export type TaskFilter = "all" | "today" | "week" | "overdue" | "completed";

export interface Task {
  id: string;
  userId: string;
  title: string;
  isCompleted: number;
  priority: TaskPriority;
  dueDate: string | null;
  noteId: string | null;
  parentId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  children?: Task[];
}

export interface TaskStats {
  total: number;
  completed: number;
  pending: number;
  today: number;
  overdue: number;
}

export interface CustomFont {
  id: string;
  name: string;
  fileName: string;
  format: string;
  fileSize?: number;
  createdAt: string;
}

export interface MindMapNode {
  id: string;
  text: string;
  children: MindMapNode[];
  collapsed?: boolean;
}

export interface MindMapData {
  root: MindMapNode;
}

export interface MindMap {
  id: string;
  userId: string;
  title: string;
  data: string; // JSON string of MindMapData
  createdAt: string;
  updatedAt: string;
}

export interface MindMapListItem {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Diary {
  id: string;
  userId: string;
  contentText: string;
  mood: string;
  createdAt: string;
}

export interface DiaryTimeline {
  items: Diary[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface DiaryStats {
  total: number;
  todayCount: number;
}

// 分享
export type SharePermission = "view" | "comment" | "edit";

export interface Share {
  id: string;
  noteId: string;
  ownerId: string;
  shareToken: string;
  shareType: string;
  permission: SharePermission;
  hasPassword: boolean;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
  isActive: number;
  createdAt: string;
  updatedAt: string;
  noteTitle?: string;
}

export interface ShareInfo {
  id: string;
  noteTitle: string;
  ownerName: string;
  permission: SharePermission;
  needPassword: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface SharedNoteContent {
  /** 关联的笔记 ID（访客编辑时作为伪 Note.id 使用） */
  noteId?: string;
  title: string;
  content: string;
  contentText: string;
  permission: SharePermission;
  updatedAt: string;
  version?: number;
  /** 笔记是否被所有者锁定，锁定时即使 permission=edit 也禁止访客写入 */
  isLocked?: 0 | 1;
}

// 版本历史
export interface NoteVersion {
  id: string;
  noteId: string;
  userId: string;
  username?: string;
  title: string;
  content?: string;
  contentText?: string;
  version: number;
  changeType: string;
  changeSummary: string | null;
  createdAt: string;
}

// 评论批注
export interface ShareComment {
  id: string;
  noteId: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  parentId: string | null;
  content: string;
  anchorData: string | null;
  isResolved: number;
  createdAt: string;
  updatedAt: string;
}

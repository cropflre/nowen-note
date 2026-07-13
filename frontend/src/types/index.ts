export interface User {
  id: string;
  username: string;
  email: string | null;
  avatarUrl: string | null;
  displayName?: string | null;
  role?: "admin" | "user";
  isDisabled?: 0 | 1 | number;
  /**
   * 体验账号标记（v15）。
   *   - 后端同名列 isDemo INTEGER (0/1)，返回时统一转为 boolean。
   *   - 账号被标为体验账号后，后端会拒绝 修改密码 / 用户名 / 启停 2FA 的请求；
   *     前端据此隐藏 SecuritySettings 里的相关入口，避免点击后才看到 403。
   *   - 老后端未迁移补列时不下发该字段，前端允许 undefined，按 false 处理。
   */
  isDemo?: boolean;
  /**
   * 个人空间导出/导入开关（v6 per-user 开关，从原来的全站 system_settings 下沉）。
   *   - 由管理员在「用户管理 → 编辑用户」里为每个用户独立控制；
   *   - 管理员本人不受此开关约束，后端 export 路由对 role=admin 无条件放行；
   *   - /api/me 和 /api/users（列表）都会返回布尔值；旧接口若缺失（老后端），
   *     前端应兜底视作 true 以维持原行为。
   */
  personalExportEnabled?: boolean;
  personalImportEnabled?: boolean;
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

/**
 * 系统管理员"工作区管理"面板用：在 Workspace 之上额外携带 owner 的展示信息。
 * 后端 GET /workspaces/all 返回此结构。
 */
export interface WorkspaceAdminItem extends Workspace {
  ownerUsername?: string;
  ownerName?: string;
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

export type NotebookRole = "owner" | "editor" | "viewer";
export type NotebookMemberStatus = "active" | "invited" | "removed";

export interface NotebookMember {
  id: string;
  notebookId: string;
  userId: string;
  role: NotebookRole;
  status: NotebookMemberStatus;
  invitedBy: string | null;
  createdAt: string;
  updatedAt: string;
  username?: string;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface NotebookShareLink {
  id: string;
  notebookId: string;
  token: string;
  role: Exclude<NotebookRole, "owner">;
  enabled: 0 | 1 | number;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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

/**
 * 工作区功能开关（Phase 1 数据隔离）
 *   每个键代表一个可独立启用/禁用的功能模块。
 *   后端 GET 会返回 normalized 结构（所有键都是 boolean），未显式设置视作 true。
 *   前端根据此结构决定侧边栏是否展示该模块、以及对应路由是否可进入。
 */
export interface WorkspaceFeatures {
  notes: boolean;
  diaries: boolean;
  tasks: boolean;
  mindmaps: boolean;
  files: boolean;
  favorites: boolean;
}

/** 功能开关的稳定排序 + 展示元信息，UI 渲染列表用。 */
export const WORKSPACE_FEATURE_META: Array<{
  key: keyof WorkspaceFeatures;
  label: string;
  description: string;
}> = [
  { key: "notes", label: "笔记", description: "笔记本、正文、标签等核心功能" },
  { key: "diaries", label: "说说", description: "时间线式短内容" },
  { key: "tasks", label: "待办", description: "任务清单与看板" },
  { key: "mindmaps", label: "思维导图", description: "节点式思维导图" },
  { key: "files", label: "文件", description: "独立文件管理" },
  { key: "favorites", label: "收藏", description: "快速收藏的笔记集合" },
];

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
  myRole?: NotebookRole;
  permission?: WorkspacePermission;
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
  /** 内容格式：tiptap-json | markdown | html。用于区分原生 Markdown 笔记与富文本笔记 */
  contentFormat?: string;
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
  /** 内容格式：tiptap-json | markdown | html。用于区分原生 Markdown 笔记与富文本笔记 */
  contentFormat?: string;
  isPinned: number;
  isFavorite: number;
  isLocked: number;
  isArchived: number;
  isTrashed: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  /**
   * 创建者用户名（后端 LEFT JOIN users.username）。
   * 仅 list 接口返回；个人空间下也会有值（恒为自己），前端通常仅在工作区视图展示。
   * null/undefined 表示用户已被删除或后端老版本未带该字段。
   */
  creatorName?: string | null;
  titleHtml?: string;
  snippetHtml?: string;
  /** 搜索结果中命中的字段：title, content, title+content */
  matchedField?: string;
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
  titleHtml?: string;
  snippetHtml?: string;
  userId?: string;
  workspaceId?: string | null;
  /** 搜索结果中命中的字段：title, content, title+content */
  matchedField?: string;
}

export type ViewMode = "notebook" | "favorites" | "trash" | "all" | "search" | "tasks" | "tag" | "mindmaps" | "ai-chat" | "diary" | "files";

// ========== 文件管理（/api/files 聚合视图） ==========

/** 文件分类：按 MIME 粗分，UI 用图标/筛选。 */
export type FileCategory = "image" | "file";

/**
 * 文件视图筛选（与 category 正交）：
 *   - "unreferenced"：scope 内"没有任何笔记引用"的附件（含 24h 宽限期）。
 *   - "myUploads"   ：scope 内"用户从文件管理页直接上传"的附件
 *                     （即 attachments.noteId 指向 isArchived=1 的 holder note）。
 *                     可与 myUploadsRef 子筛选搭配使用——见下方类型。
 *
 * 前端单独维护 UI 选择（"孤儿" / "我的上传"两个 tab），传给后端 `filter=...`；
 * 与 category=image/file 可并存（"孤儿图片" / "我的上传里的文件"）。
 */
export type FileFilter = "unreferenced" | "myUploads";

/**
 * "我的上传"子筛选：仅当 filter=myUploads 时由前端发送。
 *   - "referenced"   ：上传后已经被任意笔记引用过（attachment_references 有行）。
 *   - "unreferenced" ：上传后还没被任何笔记引用。
 *   不传 = 不再细分（返回我的上传全部）。
 *
 * 注意：这里的 "unreferenced" 与 FileFilter.unreferenced 不同——后者是全集合的孤儿
 * （包括编辑器里粘贴后又删除的图，且有 24h 宽限期）；本字段是"我的上传"子集内的
 * "还没用过的"，没有宽限期，刚上传的也立刻可见。
 */
export type FileMyUploadsRef = "referenced" | "unreferenced";

/** 文件排序键（与后端 resolveOrderBy 白名单一致）。 */
export type FileSortKey =
  | "created_desc"
  | "created_asc"
  | "name_asc"
  | "name_desc"
  | "size_asc"
  | "size_desc";

/**
 * 文件管理列表 / 详情共用的基础行。
 *
 * - `url` 永远是相对路径 `/api/attachments/<id>`；前端消费时走 resolveAttachmentUrl()
 *   补 origin，避免把变动端口 / 多域部署写死进持久化数据。
 * - `primaryNote` 是首次归属的笔记；对"从文件管理直传"的附件，这里指向
 *   holder note（isArchived=1 的"未归档文件"占位笔记）。
 */
export interface FileItem {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  category: FileCategory;
  url: string;
  /** 当前会话展示使用的短期签名地址；持久化时仍使用 url 裸链。 */
  accessUrls?: Record<string, string>;
  /**
   * v12：图片缩略图 URL（可选）。
   * - 仅 category === "image" 且 MIME 是 raster（png/jpeg/webp/bmp/gif）时由后端下发；
   * - 形如 `/api/attachments/<id>?w=240`，后端按需生成 webp 缩略图并落盘缓存；
   * - 前端 GridCard / ListView 缩略图位置优先用它，回退 url（svg / ico / 老服务端）；
   * - DetailDrawer 的大图预览仍用 url（原图）；
   * - 复制到 Markdown / HTML 的也是 url（外链给别人用必然要原图）。
   */
  thumbnailUrl?: string;
  /**
   * SHA-256 hex；v11 起新上传/抽取的附件会带；v11 之前的老附件为 null
   * （懒迁移策略，不强制回填）。仅在文件管理详情视图里供"复制 hash / 排查重复"用。
   */
  hash: string | null;
  /** 附件文件夹 ID。未归档时为 null。 */
  folderId: string | null;
  /** 附件文件夹名称。未归档时为 null。 */
  folderName: string | null;
  primaryNote: {
    id: string;
    title: string;
    notebookId: string | null;
    notebookName: string | null;
    notebookIcon: string | null;
    isTrashed: number;
  } | null;
}

/** 引用该附件的一条笔记（反向关联）。 */
export interface FileReference {
  id: string;
  title: string;
  notebookId: string | null;
  notebookName: string | null;
  notebookIcon: string | null;
  isTrashed: number;
  updatedAt: string;
  /** 是否为"首次归属"笔记（attachments.noteId 指向的那一条）。 */
  isPrimary: boolean;
}

export interface FileDetail extends FileItem {
  references: FileReference[];
}

export interface FileListResponse {
  items: FileItem[];
  /** 本页附件对应的短期签名地址。 */
  accessUrls?: Record<string, string>;
  total: number;
  page: number;
  pageSize: number;
}

export interface FileStats {
  total: number;
  totalBytes: number;
  images: { count: number; bytes: number };
  files: { count: number; bytes: number };
  /** 孤儿视图徽标：scope 内没有被任何笔记引用的附件数 / 占用。 */
  unreferenced: { count: number; bytes: number };
  /**
   * "我的上传"徽标（v12 文件管理新增）：
   *   - total       ：用户从文件管理页直接上传的全部附件数；
   *   - referenced  ：其中已被任意笔记引用过的；
   *   - unreferenced：其中还没被任何笔记引用的。
   * 老后端可能不下发该字段，前端按需要做兜底（视作三个 0）。
   */
  myUploads?: { total: number; referenced: number; unreferenced: number };
  /** 当前附件全局存储模式。只包含非敏感摘要，不包含密钥。 */
  storage?: {
    mode: "local" | "object" | "fallback";
    driver: "local" | "s3";
    source: "settings" | "env" | "default";
    bucket?: string;
    endpoint?: string;
    prefix?: string;
  };
  byMime: Array<{ mime: string; count: number; bytes: number }>;
}







export type TaskPriority = 1 | 2 | 3; // 1=低, 2=中, 3=高

export type TaskFilter = "all" | "today" | "week" | "overdue" | "completed";

export interface Task {
  id: string;
  userId: string;
  /** Y3: 任务归属的工作区 id；null = 个人空间。 */
  workspaceId: string | null;
  title: string;
  description: string;
  isCompleted: number;
  completedAt?: string | null;
  priority: TaskPriority;
  dueDate: string | null;
  /** Phase 2: 精确到分钟的截止时间，ISO 8601 格式（如 2026-06-12T18:00）。兼容旧 dueDate */
  dueAt: string | null;
  startDate?: string | null;
  noteId: string | null;
  parentId: string | null;
  sortOrder: number;
  projectId: string | null;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  children?: Task[];
  activeReminderCount?: number;
  /** 创建者用户名；仅 list/single read 时由后端 LEFT JOIN 返回。 */
  creatorName?: string | null;
  repeatRule?: "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";
  repeatInterval?: number;
  repeatEndDate?: string | null;
  /** 循环任务按总次数结束；null 表示不按次数限制。 */
  repeatEndCount?: number | null;
  /** 当前循环序号，避免删除历史任务后按 COUNT 计算回退。 */
  repeatSequenceIndex?: number | null;
  repeatGroupId?: string | null;
  repeatGeneratedFromId?: string | null;
  repeatNextGeneratedId?: string | null;
  repeatRuleJson?: string | null;
}

export interface TaskStats {
  total: number;
  completed: number;
  pending: number;
  today: number;
  overdue: number;
  week: number;
}

export type HabitCheckinStatus = "success" | "partial" | "failure";

export interface Habit {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  icon: string;
  color: string;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  creatorName?: string | null;
  todayStatus?: HabitCheckinStatus | null;
  todayNote?: string | null;
  todayCheckinDate?: string | null;
  canManage?: boolean;
}

export interface HabitCheckin {
  id: string;
  habitId: string;
  userId: string;
  workspaceId: string | null;
  checkinDate: string;
  status: HabitCheckinStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface HabitCheckinListItem extends HabitCheckin {
  habitTitle: string;
  habitColor: string;
  habitIcon: string;
  habitArchivedAt: string | null;
  creatorName?: string | null;
  canManage?: boolean;
}

export interface HabitStats {
  totalCheckins: number;
  checkinDays: number;
  currentStreak: number;
  successCount: number;
  partialCount: number;
  failureCount: number;
  habitCount?: number;
}

/** Task reminder config */
export interface TaskReminder {
  id: string;
  taskId: string;
  userId: string;
  offsetMinutes: number;
  enabled: number;
  lastNotifiedAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReminderOverviewItem {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  taskStatus: TaskStatus;
  isCompleted: number;
  dueDate: string | null;
  dueAt: string | null;
  offsetMinutes: number;
  enabled: number;
  lastNotifiedAt: string | null;
  reminderAt: string | null;
  group: "missed" | "today" | "upcoming" | "disabled";
  snoozedUntil: string | null;
}

export interface ReminderOverview {
  missed: ReminderOverviewItem[];
  today: ReminderOverviewItem[];
  upcoming: ReminderOverviewItem[];
  disabled: ReminderOverviewItem[];
}

/** Task status for kanban board */
export type TaskStatus = "todo" | "doing" | "done" | "blocked";

/** Task project / project list */
export interface TaskProject {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** populated by backend via subquery */
  taskCount?: number;
  /** populated by backend via subquery */
  completedCount?: number;
  /** progress percentage 0-100, computed by backend */
  progress?: number;
}

/** Task template item */
export interface TaskTemplateItem {
  title: string;
  description?: string;
  priority: number;
  relativeDueDays: number | null;
  parentIndex: number | null;
  sortOrder: number;
}

/** Task template */
export interface TaskTemplate {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  items: TaskTemplateItem[];
  createdAt: string;
  updatedAt: string;
}


export interface TaskDependency {
  id: string;
  userId: string;
  workspaceId: string | null;
  predecessorTaskId: string;
  successorTaskId: string;
  type: "finish_to_start";
  createdAt: string;
  updatedAt: string;
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
  width?: number;
  children: MindMapNode[];
  collapsed?: boolean;
  markers?: Array<"done" | "todo" | "priority-high" | "warning" | "idea" | "pin">;
  note?: string;
  link?: string;
  style?: {
    bg?: string;
    color?: string;
    border?: string;
  };
}

export interface MindMapRelation {
  id: string;
  fromId: string;
  toId: string;
  label?: string;
}

export interface MindMapBoundary {
  id: string;
  nodeIds: string[];
  color?: string;
  label?: string;
}

export interface MindMapViewport {
  x: number;
  y: number;
  zoom: number;
  userSet?: boolean;
}

export interface MindMapData {
  root: MindMapNode;
  layout?: "right" | "left-right";
  relations?: MindMapRelation[];
  boundaries?: MindMapBoundary[];
  theme?: string;
  viewport?: MindMapViewport;
}

export interface MindMap {
  id: string;
  userId: string;
  /** Y4: 思维导图归属的工作区 id；null = 个人空间。 */
  workspaceId: string | null;
  title: string;
  data: string; // JSON string of MindMapData
  createdAt: string;
  updatedAt: string;
}

export interface MindMapListItem {
  id: string;
  userId: string;
  /** Y4: 同 MindMap.workspaceId。 */
  workspaceId: string | null;
  title: string;
  starred?: number;
  folderId?: string | null;
  createdAt: string;
  updatedAt: string;
  /** 创建者用户名；仅 list 接口返回。 */
  creatorName?: string | null;
}


export interface MindMapFolder {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  name: string;
  sortOrder: number;
  mindmapCount?: number;
  createdAt: string;
  updatedAt: string;
}
export interface DiaryMediaItem {
  id: string;
  type: "image" | "video";
  url?: string;
  mimeType?: string;
  size?: number;
}

export interface Diary {
  id: string;
  userId: string;
  /** Y2: 说说归属的工作区 id；null = 个人空间。 */
  workspaceId: string | null;
  contentText: string;
  mood: string;
  /** 已绑定的说说图片 id 数组（顺序即展示顺序）。需要 URL 时拼 /api/diary/attachments/<id>。 */
  images: string[];
  /** 已绑定的说说媒体。旧数据可能为空，此时前端用 images 兜底。 */
  media: DiaryMediaItem[];
  createdAt: string;
  /** 创建者用户名；后端 LEFT JOIN users 返回，工作区视图下用于展示"谁发的"。 */
  creatorName?: string | null;
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
//
// SharePermission 取值：
//   - 'view'      仅查看
//   - 'comment'   可查看 + 留言（未登录访客填昵称即可评论；留言板模式：所有访客互见）
//   - 'edit'      可编辑（允许匿名访客填昵称编辑，无需注册）
//   - 'edit_auth' 可编辑（需登录）；未登录访问到带此权限的 PUT 内容接口会返回
//                 401 + code='LOGIN_REQUIRED'，前端引导跳转 /login?redirect=/share/<token>
//                 登录回来后再次提交即可。
export type SharePermission = "view" | "comment" | "edit" | "edit_auth";

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
  contentFormat?: string | null;
  permission: SharePermission;
  updatedAt: string;
  version?: number;
  /** 笔记是否被所有者锁定，锁定时即使 permission=edit 也禁止访客写入 */
  isLocked?: 0 | 1;
  /**
   * 笔记所有者（作者）id。前端拿来跟当前登录用户对比，
   * 若访问者就是作者本人，则跳过"请填写访客昵称"弹窗，
   * 直接进入编辑模式（自动以作者身份保存）。
   */
  ownerId?: string;
}

// 版本历史
export interface NoteVersion {
  id: string;
  noteId: string;
  userId: string;
  username?: string;
  title: string;
  content?: string | null;
  contentText?: string | null;
  contentFormat?: string | null;
  version: number;
  changeType: string;
  changeSummary: string | null;
  createdAt: string;
}

// 评论批注
//
// userId 为 null 表示未登录访客评论（公开分享 + comment 权限场景）；
// 此时 guestName 是访客自填的昵称，前端显示用 displayName（后端合成的统一字段）。
// isGuest=true 时 UI 上可以加"访客"标记或不同颜色，与登录用户区分。
export interface ShareComment {
  id: string;
  noteId: string;
  userId: string | null;
  /** 显示用的统一名（后端 COALESCE(guestName, users.username) 合成，永远非空） */
  displayName?: string;
  /** 是否为未登录访客留言（userId IS NULL） */
  isGuest?: boolean;
  /** 访客填写的昵称；登录用户为 null */
  guestName?: string | null;
  /** 兼容旧字段：登录用户的用户名（前端优先用 displayName，其次用 username） */
  username?: string | null;
  avatarUrl: string | null;
  parentId: string | null;
  content: string;
  anchorData: string | null;
  isResolved: number;
  createdAt: string;
  updatedAt: string;
}

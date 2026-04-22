/**
 * Nowen Note SDK 类型定义
 */

// ===== 配置 =====
export interface NowenConfig {
  /** Nowen Note 后端地址，例如 http://localhost:3001 */
  baseUrl: string;
  /** 登录用户名 */
  username: string;
  /** 登录密码 */
  password: string;
  /** 请求超时（毫秒），默认 30000 */
  timeout?: number;
  /** 自定义 fetch 实现（用于测试或特殊环境） */
  fetch?: typeof fetch;
}

// ===== 笔记本 =====
export interface Notebook {
  id: string;
  userId: string;
  name: string;
  icon: string;
  color: string;
  parentId: string | null;
  sortOrder: number;
  noteCount: number;
  createdAt: string;
  updatedAt: string;
  children?: Notebook[];
}

export interface CreateNotebookParams {
  name: string;
  parentId?: string;
  icon?: string;
  color?: string;
}

export interface UpdateNotebookParams {
  name?: string;
  icon?: string;
  color?: string;
  parentId?: string;
  sortOrder?: number;
}

// ===== 笔记 =====
export interface Note {
  id: string;
  userId: string;
  notebookId: string;
  title: string;
  content: string;
  contentText: string;
  isPinned: number;
  isFavorite: number;
  isLocked: number;
  isTrashed: number;
  version: number;
  tags?: Tag[];
  createdAt: string;
  updatedAt: string;
}

export interface NoteSummary {
  id: string;
  notebookId: string;
  title: string;
  contentText: string;
  isPinned: number;
  isFavorite: number;
  isLocked: number;
  isTrashed: number;
  version: number;
  updatedAt: string;
}

export interface ListNotesParams {
  notebookId?: string;
  isFavorite?: boolean;
  isTrashed?: boolean;
  tagId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface CreateNoteParams {
  notebookId: string;
  title?: string;
  content?: string;
  contentText?: string;
}

export interface UpdateNoteParams {
  title?: string;
  content?: string;
  contentText?: string;
  notebookId?: string;
  isPinned?: number;
  isFavorite?: number;
  isLocked?: number;
  isTrashed?: number;
  version?: number;
}

// ===== 标签 =====
export interface Tag {
  id: string;
  userId: string;
  name: string;
  color: string;
  noteCount?: number;
  createdAt: string;
}

export interface CreateTagParams {
  name: string;
  color?: string;
}

// ===== 任务 =====
export interface Task {
  id: string;
  userId: string;
  noteId: string | null;
  title: string;
  content: string;
  status: "todo" | "doing" | "done";
  priority: "low" | "medium" | "high";
  dueDate: string | null;
  completedAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStats {
  total: number;
  todo: number;
  doing: number;
  done: number;
  overdue: number;
}

export interface ListTasksParams {
  status?: string;
  priority?: string;
  noteId?: string;
}

export interface CreateTaskParams {
  title: string;
  content?: string;
  noteId?: string;
  status?: string;
  priority?: string;
  dueDate?: string;
}

export interface UpdateTaskParams {
  title?: string;
  content?: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  sortOrder?: number;
}

// ===== 思维导图 =====
export interface MindMap {
  id: string;
  userId: string;
  noteId: string | null;
  title: string;
  data: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMindMapParams {
  title: string;
  noteId?: string;
  data?: string;
}

export interface UpdateMindMapParams {
  title?: string;
  data?: string;
}

// ===== 日记 =====
export interface DiaryEntry {
  id: string;
  userId: string;
  date: string;
  content: string;
  mood: string;
  weather: string;
  createdAt: string;
  updatedAt: string;
}

// ===== AI =====
export interface AISettings {
  ai_api_url: string;
  ai_api_key: string;
  ai_model: string;
  ai_provider: string;
}

export type AIAction =
  | "continue" | "rewrite" | "polish" | "shorten" | "expand"
  | "translate_en" | "translate_zh" | "summarize" | "explain"
  | "fix_grammar" | "format_markdown" | "format_code" | "custom";

export interface AIChatParams {
  action: AIAction;
  text: string;
  context?: string;
  customPrompt?: string;
}

export interface AIAskResult {
  answer: string;
  references: { id: string; title: string }[];
}

export interface KnowledgeStats {
  totalNotes: number;
  totalNotebooks: number;
  totalTags: number;
  totalCharacters: number;
  ftsEnabled: boolean;
}

// ===== 搜索 =====
export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  notebookId: string;
  updatedAt: string;
}

// ===== 导出 =====
export type ExportFormat = "markdown" | "html" | "json" | "txt";

// ===== 分享 =====
export interface Share {
  id: string;
  noteId: string;
  userId: string;
  shareCode: string;
  isPublic: number;
  hasPassword: number;
  expiresAt: string | null;
  viewCount: number;
  createdAt: string;
}

export interface CreateShareParams {
  noteId: string;
  isPublic?: boolean;
  password?: string;
  expiresAt?: string;
}

// ===== 系统设置 =====
export interface SystemSettings {
  site_title?: string;
  site_favicon?: string;
  editor_font_family?: string;
  [key: string]: string | undefined;
}

// ===== 插件/Skill =====
export interface NowenSkill {
  /** 技能唯一标识 */
  name: string;
  /** 版本号 */
  version: string;
  /** 描述 */
  description: string;
  /** 作者 */
  author?: string;
  /** 能力声明 */
  capabilities: SkillCapability[];
  /** 初始化钩子（加载时调用） */
  init?(context: SkillContext): Promise<void>;
  /** 执行入口 */
  execute(context: SkillContext, params: Record<string, any>): Promise<SkillResult>;
  /** 清理钩子（卸载时调用） */
  destroy?(): Promise<void>;
}

export interface SkillCapability {
  /** 操作名称，如 "format", "translate", "analyze" */
  action: string;
  /** 操作描述 */
  description: string;
  /** 接受的输入类型 */
  inputTypes: string[];
  /** 输出类型 */
  outputTypes: string[];
  /** 参数定义 */
  params?: SkillParam[];
}

export interface SkillParam {
  name: string;
  type: "string" | "number" | "boolean" | "select";
  description: string;
  required?: boolean;
  default?: any;
  options?: { label: string; value: any }[];
}

export interface SkillContext {
  /** SDK 客户端实例，可调用所有 API */
  api: import("./client.js").NowenClient;
  /** 日志输出 */
  log: (message: string) => void;
  /** 当前用户 ID */
  userId: string;
}

export interface SkillResult {
  success: boolean;
  data?: any;
  text?: string;
  error?: string;
}

// ===== Skill Manifest =====
export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  main: string;
  capabilities: SkillCapability[];
  permissions?: string[];
}

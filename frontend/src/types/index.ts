export interface User {
  id: string;
  username: string;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface Notebook {
  id: string;
  userId: string;
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
  title: string;
  content: string;
  contentText: string;
  isPinned: number;
  isFavorite: number;
  isArchived: number;
  isTrashed: number;
  trashedAt: string | null;
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  tags?: Tag[];
}

export interface NoteListItem {
  id: string;
  userId: string;
  notebookId: string;
  title: string;
  contentText: string;
  isPinned: number;
  isFavorite: number;
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

export type ViewMode = "notebook" | "favorites" | "trash" | "all" | "search" | "tasks" | "tag" | "mindmaps" | "documents";

export type DocType = "word" | "cell" | "slide";

export interface DocumentItem {
  id: string;
  userId: string;
  title: string;
  docType: DocType;
  fileKey: string;
  fileSize: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentListItem {
  id: string;
  userId: string;
  title: string;
  docType: DocType;
  fileSize: number;
  createdAt: string;
  updatedAt: string;
}

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

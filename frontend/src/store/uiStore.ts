/**
 * UI 状态管理（Zustand）
 * ---------------------------------------------------------------------------
 * 管理全局 UI 状态：侧栏、导航、视图模式、移动端布局。
 *
 * 使用方式：
 *   import { useUIStore } from "@/store/uiStore";
 *
 *   // 在组件中读取
 *   const viewMode = useUIStore((s) => s.viewMode);
 *   const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
 *
 *   // 写入操作
 *   useUIStore.getState().setViewMode("diary");
 *
 * 迁移说明：
 *   此 store 与 AppContext 共存。新组件可以直接使用 Zustand，
 *   旧组件通过 AppContext 读取（AppContext 内部包裹 Zustand）。
 *   最终目标是 AppContext 完全依赖 Zustand stores 作为单一数据源。
 */

import { create } from "zustand";
import type { ViewMode, MobileView } from "@/types";

export interface UIState {
  // ---- 视图 ----
  viewMode: ViewMode;
  selectedNotebookId: string | null;
  selectedTagId: string | null;
  searchQuery: string;

  // ---- 侧栏 ----
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  noteListWidth: number;
  noteListCollapsed: boolean;

  // ---- 移动端 ----
  mobileView: MobileView;
  mobileSidebarOpen: boolean;
  mobileSidebarAnimating: boolean;

  // ---- 编辑器 ----
  notesRefreshToken: number;
  isLoading: boolean;
  noteLoading: boolean;

  // ---- Actions ----
  setViewMode: (mode: ViewMode) => void;
  setSelectedNotebook: (id: string | null) => void;
  setSelectedTag: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setNoteListWidth: (w: number) => void;
  toggleNoteListCollapsed: () => void;
  setMobileView: (v: MobileView) => void;
  setMobileSidebar: (v: boolean) => void;
  triggerRefreshNotes: () => void;
  setLoading: (v: boolean) => void;
  setNoteLoading: (v: boolean) => void;
}

// localStorage 持久化辅助
const LS_KEYS = {
  sidebarWidth: "nowen-sidebar-width",
  noteListWidth: "nowen-notelist-width",
  noteListCollapsed: "nowen-notelist-collapsed",
  sidebarCollapsed: "nowen-sidebar-collapsed",
} as const;

function loadNum(key: string, fallback: number): number {
  try { const v = Number(localStorage.getItem(key)); return isNaN(v) ? fallback : v; } catch { return fallback; }
}
function loadBool(key: string, fallback: boolean): boolean {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === "1"; } catch { return fallback; }
}

export const useUIStore = create<UIState>()((set) => ({
  // 默认值
  viewMode: "home",
  selectedNotebookId: null,
  selectedTagId: null,
  searchQuery: "",
  sidebarCollapsed: loadBool(LS_KEYS.sidebarCollapsed, false),
  sidebarWidth: loadNum(LS_KEYS.sidebarWidth, 260),
  noteListWidth: loadNum(LS_KEYS.noteListWidth, 300),
  noteListCollapsed: loadBool(LS_KEYS.noteListCollapsed, false),
  mobileView: "list",
  mobileSidebarOpen: false,
  mobileSidebarAnimating: false,
  notesRefreshToken: 0,
  isLoading: false,
  noteLoading: false,

  // Actions
  setViewMode: (mode) => set({ viewMode: mode }),
  setSelectedNotebook: (id) => set({ selectedNotebookId: id }),
  setSelectedTag: (id) => set({ selectedTagId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  toggleSidebar: () => set((s) => {
    const next = !s.sidebarCollapsed;
    try { localStorage.setItem(LS_KEYS.sidebarCollapsed, next ? "1" : "0"); } catch {}
    return { sidebarCollapsed: next };
  }),
  setSidebarWidth: (w) => {
    try { localStorage.setItem(LS_KEYS.sidebarWidth, String(w)); } catch {}
    set({ sidebarWidth: w });
  },
  setNoteListWidth: (w) => {
    try { localStorage.setItem(LS_KEYS.noteListWidth, String(w)); } catch {}
    set({ noteListWidth: w });
  },
  toggleNoteListCollapsed: () => set((s) => {
    const next = !s.noteListCollapsed;
    try { localStorage.setItem(LS_KEYS.noteListCollapsed, next ? "1" : "0"); } catch {}
    return { noteListCollapsed: next };
  }),
  setMobileView: (v) => set({ mobileView: v }),
  setMobileSidebar: (v) => set({ mobileSidebarOpen: v }),
  triggerRefreshNotes: () => set((s) => ({ notesRefreshToken: s.notesRefreshToken + 1 })),
  setLoading: (v) => set({ isLoading: v }),
  setNoteLoading: (v) => set({ noteLoading: v }),
}));

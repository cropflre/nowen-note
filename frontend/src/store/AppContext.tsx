import React, { createContext, useContext, useReducer, useMemo } from "react";
import { Notebook, NoteListItem, Note, Tag, ViewMode } from "@/types";
import { api } from "@/lib/api";

export type SyncStatus = "idle" | "saving" | "saved" | "error" | "offline" | "queued";
export type MobileView = "list" | "editor";

interface AppState {
  notebooks: Notebook[];
  notes: NoteListItem[];
  activeNote: Note | null;
  tags: Tag[];
  selectedNotebookId: string | null;
  selectedTagId: string | null;          // 已废弃，保留兼容；优先使用 selectedTagIds
  selectedTagIds: string[];              // TAG-FILTER-MULTI-01: 多标签联合筛选
  viewMode: ViewMode;
  searchQuery: string;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  noteListWidth: number;
  /** 桌面端：笔记列表面板是否折叠（折叠后整列消失，编辑器占满）。
   *  与 sidebarCollapsed 完全平行的开关，互不影响。 */
  noteListCollapsed: boolean;
  /** 桌面端：编辑器专注全屏。仅临时隐藏外侧导航，不改写各面板折叠偏好。 */
  editorFullscreen: boolean;
  isLoading: boolean;
  /** 笔记切换时的加载状态：正在从后端获取完整笔记内容 */
  noteLoading: boolean;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  mobileView: MobileView;
  mobileSidebarOpen: boolean;
  /** 全局"笔记列表刷新"令牌：递增时 NoteList 会重新拉取当前视图的列表 */
  notesRefreshToken: number;
}

type Action =
  | { type: "SET_NOTEBOOKS"; payload: Notebook[] }
  | { type: "SET_NOTES"; payload: NoteListItem[] }
  | { type: "SET_ACTIVE_NOTE"; payload: Note | null }
  | { type: "SET_TAGS"; payload: Tag[] }
  | { type: "SET_SELECTED_NOTEBOOK"; payload: string | null }
  | { type: "SET_SELECTED_TAG"; payload: string | null }
  | { type: "SET_SELECTED_TAGS"; payload: string[] }        // TAG-FILTER-MULTI-01
  | { type: "TOGGLE_SELECTED_TAG"; payload: string }        // TAG-FILTER-MULTI-01
  | { type: "CLEAR_SELECTED_TAGS" }                         // TAG-FILTER-MULTI-01
  | { type: "SET_VIEW_MODE"; payload: ViewMode }
  | { type: "SET_SEARCH_QUERY"; payload: string }
  | { type: "TOGGLE_SIDEBAR" }
  | { type: "SET_SIDEBAR_WIDTH"; payload: number }
  | { type: "SET_NOTELIST_WIDTH"; payload: number }
  | { type: "TOGGLE_NOTELIST_COLLAPSED" }
  | { type: "SET_EDITOR_FULLSCREEN"; payload: boolean }
  | { type: "TOGGLE_EDITOR_FULLSCREEN" }
  | { type: "SET_LOADING"; payload: boolean }
  | { type: "SET_NOTE_LOADING"; payload: boolean }
  | { type: "UPDATE_NOTE_IN_LIST"; payload: Partial<NoteListItem> & { id: string } }
  | { type: "REMOVE_NOTE_FROM_LIST"; payload: string }
  | { type: "ADD_NOTE_TO_LIST"; payload: NoteListItem }
  | { type: "SET_SYNC_STATUS"; payload: SyncStatus }
  | { type: "SET_LAST_SYNCED"; payload: string }
  | { type: "SET_MOBILE_VIEW"; payload: MobileView }
  | { type: "SET_MOBILE_SIDEBAR"; payload: boolean }
  | { type: "TRIGGER_REFRESH_NOTES" };

const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

const DEFAULT_NOTELIST_WIDTH = 300;
const MIN_NOTELIST_WIDTH = 220;
const MAX_NOTELIST_WIDTH = 500;

function getSavedSidebarWidth(): number {
  try {
    const saved = localStorage.getItem("nowen-sidebar-width");
    if (saved) {
      const w = Number(saved);
      if (w >= MIN_SIDEBAR_WIDTH && w <= MAX_SIDEBAR_WIDTH) return w;
    }
  } catch {}
  return DEFAULT_SIDEBAR_WIDTH;
}

function getSavedNoteListWidth(): number {
  try {
    const saved = localStorage.getItem("nowen-notelist-width");
    if (saved) {
      const w = Number(saved);
      if (w >= MIN_NOTELIST_WIDTH && w <= MAX_NOTELIST_WIDTH) return w;
    }
  } catch {}
  return DEFAULT_NOTELIST_WIDTH;
}

function getSavedNoteListCollapsed(): boolean {
  try {
    return localStorage.getItem("nowen-notelist-collapsed") === "1";
  } catch {
    return false;
  }
}

const initialState: AppState = {
  notebooks: [],
  notes: [],
  activeNote: null,
  tags: [],
  selectedNotebookId: null,
  selectedTagId: null,
  selectedTagIds: [],
  viewMode: "all",
  searchQuery: "",
  sidebarCollapsed: false,
  sidebarWidth: getSavedSidebarWidth(),
  noteListWidth: getSavedNoteListWidth(),
  noteListCollapsed: getSavedNoteListCollapsed(),
  editorFullscreen: false,
  isLoading: false,
  noteLoading: false,
  syncStatus: "idle",
  lastSyncedAt: null,
  mobileView: "list",
  mobileSidebarOpen: false,
  notesRefreshToken: 0,
};

export { MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, MIN_NOTELIST_WIDTH, MAX_NOTELIST_WIDTH, DEFAULT_NOTELIST_WIDTH };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_NOTEBOOKS":
      return { ...state, notebooks: action.payload };
    case "SET_NOTES":
      return { ...state, notes: action.payload };
    case "SET_ACTIVE_NOTE":
      return { ...state, activeNote: action.payload };
    case "SET_TAGS":
      return { ...state, tags: action.payload };
    case "SET_SELECTED_NOTEBOOK":
      return { ...state, selectedNotebookId: action.payload };
    case "SET_SELECTED_TAG": {
      // 兼容旧调用：同步更新 selectedTagId + selectedTagIds
      const id = action.payload;
      return {
        ...state,
        selectedTagId: id,
        selectedTagIds: id ? [id] : [],
      };
    }
    case "SET_SELECTED_TAGS": {
      const ids = action.payload;
      return {
        ...state,
        selectedTagIds: ids,
        selectedTagId: ids.length === 1 ? ids[0] : null,
      };
    }
    case "TOGGLE_SELECTED_TAG": {
      const tagId = action.payload;
      const exists = state.selectedTagIds.includes(tagId);
      const next = exists
        ? state.selectedTagIds.filter((id) => id !== tagId)
        : [...state.selectedTagIds, tagId];
      return {
        ...state,
        selectedTagIds: next,
        selectedTagId: next.length === 1 ? next[0] : null,
      };
    }
    case "CLEAR_SELECTED_TAGS":
      return {
        ...state,
        selectedTagIds: [],
        selectedTagId: null,
      };
    case "SET_VIEW_MODE":
      return { ...state, viewMode: action.payload };
    case "SET_SEARCH_QUERY":
      return { ...state, searchQuery: action.payload };
    case "TOGGLE_SIDEBAR":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case "SET_SIDEBAR_WIDTH": {
      const w = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, action.payload));
      try { localStorage.setItem("nowen-sidebar-width", String(w)); } catch {}
      return { ...state, sidebarWidth: w };
    }
    case "SET_NOTELIST_WIDTH": {
      const w = Math.max(MIN_NOTELIST_WIDTH, Math.min(MAX_NOTELIST_WIDTH, action.payload));
      try { localStorage.setItem("nowen-notelist-width", String(w)); } catch {}
      return { ...state, noteListWidth: w };
    }
    case "TOGGLE_NOTELIST_COLLAPSED": {
      const next = !state.noteListCollapsed;
      try { localStorage.setItem("nowen-notelist-collapsed", next ? "1" : "0"); } catch {}
      return { ...state, noteListCollapsed: next };
    }
    case "SET_EDITOR_FULLSCREEN":
      return { ...state, editorFullscreen: action.payload };
    case "TOGGLE_EDITOR_FULLSCREEN":
      return { ...state, editorFullscreen: !state.editorFullscreen };
    case "SET_LOADING":
      return { ...state, isLoading: action.payload };
    case "SET_NOTE_LOADING":
      return { ...state, noteLoading: action.payload };
    case "UPDATE_NOTE_IN_LIST":
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === action.payload.id ? { ...n, ...action.payload } : n
        ),
      };
    case "REMOVE_NOTE_FROM_LIST":
      return {
        ...state,
        notes: state.notes.filter((n) => n.id !== action.payload),
      };
    case "ADD_NOTE_TO_LIST":
      return {
        ...state,
        notes: [action.payload, ...state.notes],
      };
    case "SET_SYNC_STATUS":
      return { ...state, syncStatus: action.payload };
    case "SET_LAST_SYNCED":
      return { ...state, lastSyncedAt: action.payload };
    case "SET_MOBILE_VIEW":
      return { ...state, mobileView: action.payload };
    case "SET_MOBILE_SIDEBAR":
      return { ...state, mobileSidebarOpen: action.payload };
    case "TRIGGER_REFRESH_NOTES":
      return { ...state, notesRefreshToken: state.notesRefreshToken + 1 };
    default:
      return state;
  }
}

const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used within AppProvider");
  return context;
}

export function useAppActions() {
  const { dispatch } = useApp();

  // 用 useMemo 让返回对象保持稳定引用 —— 只要 dispatch 不变，整个 actions 对象也稳定。
  // 这样依赖 `[actions]` 的 useCallback / useEffect 不会在每次 render 都失效，
  // 从而避免保存期间频繁 dispatch 导致的编辑器状态抖动（如光标跳行）。
  return useMemo(() => ({
    setNotebooks: (v: Notebook[]) => dispatch({ type: "SET_NOTEBOOKS", payload: v }),
    setNotes: (v: NoteListItem[]) => dispatch({ type: "SET_NOTES", payload: v }),
    setActiveNote: (v: Note | null) => dispatch({ type: "SET_ACTIVE_NOTE", payload: v }),
    setTags: (v: Tag[]) => dispatch({ type: "SET_TAGS", payload: v }),
    setSelectedNotebook: (v: string | null) => dispatch({ type: "SET_SELECTED_NOTEBOOK", payload: v }),
    setSelectedTag: (v: string | null) => dispatch({ type: "SET_SELECTED_TAG", payload: v }),
    setSelectedTags: (v: string[]) => dispatch({ type: "SET_SELECTED_TAGS", payload: v }),
    toggleSelectedTag: (v: string) => dispatch({ type: "TOGGLE_SELECTED_TAG", payload: v }),
    clearSelectedTags: () => dispatch({ type: "CLEAR_SELECTED_TAGS" }),
    setViewMode: (v: ViewMode) => dispatch({ type: "SET_VIEW_MODE", payload: v }),
    setSearchQuery: (v: string) => dispatch({ type: "SET_SEARCH_QUERY", payload: v }),
    toggleSidebar: () => dispatch({ type: "TOGGLE_SIDEBAR" }),
    setSidebarWidth: (v: number) => dispatch({ type: "SET_SIDEBAR_WIDTH", payload: v }),
    setNoteListWidth: (v: number) => dispatch({ type: "SET_NOTELIST_WIDTH", payload: v }),
    toggleNoteListCollapsed: () => dispatch({ type: "TOGGLE_NOTELIST_COLLAPSED" }),
    setEditorFullscreen: (v: boolean) => dispatch({ type: "SET_EDITOR_FULLSCREEN", payload: v }),
    toggleEditorFullscreen: () => dispatch({ type: "TOGGLE_EDITOR_FULLSCREEN" }),
    setLoading: (v: boolean) => dispatch({ type: "SET_LOADING", payload: v }),
    setNoteLoading: (v: boolean) => dispatch({ type: "SET_NOTE_LOADING", payload: v }),
    updateNoteInList: (v: Partial<NoteListItem> & { id: string }) => dispatch({ type: "UPDATE_NOTE_IN_LIST", payload: v }),
    removeNoteFromList: (id: string) => dispatch({ type: "REMOVE_NOTE_FROM_LIST", payload: id }),
    addNoteToList: (v: NoteListItem) => dispatch({ type: "ADD_NOTE_TO_LIST", payload: v }),
    setSyncStatus: (v: SyncStatus) => dispatch({ type: "SET_SYNC_STATUS", payload: v }),
    setLastSynced: (v: string) => dispatch({ type: "SET_LAST_SYNCED", payload: v }),
    setMobileView: (v: MobileView) => dispatch({ type: "SET_MOBILE_VIEW", payload: v }),
    setMobileSidebar: (v: boolean) => dispatch({ type: "SET_MOBILE_SIDEBAR", payload: v }),
    refreshNotebooks: () => {
      api.getNotebooks().then((v) => dispatch({ type: "SET_NOTEBOOKS", payload: v })).catch(console.error);
    },
    /** 触发 NoteList 重新拉取当前视图的笔记列表 */
    refreshNotes: () => dispatch({ type: "TRIGGER_REFRESH_NOTES" }),
  }), [dispatch]);
}

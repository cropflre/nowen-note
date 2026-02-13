import React, { createContext, useContext, useReducer, useCallback } from "react";
import { Notebook, NoteListItem, Note, Tag, ViewMode } from "@/types";

export type SyncStatus = "idle" | "saving" | "saved" | "error";
export type MobileView = "list" | "editor";

interface AppState {
  notebooks: Notebook[];
  notes: NoteListItem[];
  activeNote: Note | null;
  tags: Tag[];
  selectedNotebookId: string | null;
  selectedTagId: string | null;
  viewMode: ViewMode;
  searchQuery: string;
  sidebarCollapsed: boolean;
  isLoading: boolean;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  mobileView: MobileView;
  mobileSidebarOpen: boolean;
}

type Action =
  | { type: "SET_NOTEBOOKS"; payload: Notebook[] }
  | { type: "SET_NOTES"; payload: NoteListItem[] }
  | { type: "SET_ACTIVE_NOTE"; payload: Note | null }
  | { type: "SET_TAGS"; payload: Tag[] }
  | { type: "SET_SELECTED_NOTEBOOK"; payload: string | null }
  | { type: "SET_SELECTED_TAG"; payload: string | null }
  | { type: "SET_VIEW_MODE"; payload: ViewMode }
  | { type: "SET_SEARCH_QUERY"; payload: string }
  | { type: "TOGGLE_SIDEBAR" }
  | { type: "SET_LOADING"; payload: boolean }
  | { type: "UPDATE_NOTE_IN_LIST"; payload: Partial<NoteListItem> & { id: string } }
  | { type: "SET_SYNC_STATUS"; payload: SyncStatus }
  | { type: "SET_LAST_SYNCED"; payload: string }
  | { type: "SET_MOBILE_VIEW"; payload: MobileView }
  | { type: "SET_MOBILE_SIDEBAR"; payload: boolean };

const initialState: AppState = {
  notebooks: [],
  notes: [],
  activeNote: null,
  tags: [],
  selectedNotebookId: null,
  selectedTagId: null,
  viewMode: "all",
  searchQuery: "",
  sidebarCollapsed: false,
  isLoading: false,
  syncStatus: "idle",
  lastSyncedAt: null,
  mobileView: "list",
  mobileSidebarOpen: false,
};

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
    case "SET_SELECTED_TAG":
      return { ...state, selectedTagId: action.payload };
    case "SET_VIEW_MODE":
      return { ...state, viewMode: action.payload };
    case "SET_SEARCH_QUERY":
      return { ...state, searchQuery: action.payload };
    case "TOGGLE_SIDEBAR":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case "SET_LOADING":
      return { ...state, isLoading: action.payload };
    case "UPDATE_NOTE_IN_LIST":
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === action.payload.id ? { ...n, ...action.payload } : n
        ),
      };
    case "SET_SYNC_STATUS":
      return { ...state, syncStatus: action.payload };
    case "SET_LAST_SYNCED":
      return { ...state, lastSyncedAt: action.payload };
    case "SET_MOBILE_VIEW":
      return { ...state, mobileView: action.payload };
    case "SET_MOBILE_SIDEBAR":
      return { ...state, mobileSidebarOpen: action.payload };
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

  return {
    setNotebooks: useCallback((v: Notebook[]) => dispatch({ type: "SET_NOTEBOOKS", payload: v }), [dispatch]),
    setNotes: useCallback((v: NoteListItem[]) => dispatch({ type: "SET_NOTES", payload: v }), [dispatch]),
    setActiveNote: useCallback((v: Note | null) => dispatch({ type: "SET_ACTIVE_NOTE", payload: v }), [dispatch]),
    setTags: useCallback((v: Tag[]) => dispatch({ type: "SET_TAGS", payload: v }), [dispatch]),
    setSelectedNotebook: useCallback((v: string | null) => dispatch({ type: "SET_SELECTED_NOTEBOOK", payload: v }), [dispatch]),
    setSelectedTag: useCallback((v: string | null) => dispatch({ type: "SET_SELECTED_TAG", payload: v }), [dispatch]),
    setViewMode: useCallback((v: ViewMode) => dispatch({ type: "SET_VIEW_MODE", payload: v }), [dispatch]),
    setSearchQuery: useCallback((v: string) => dispatch({ type: "SET_SEARCH_QUERY", payload: v }), [dispatch]),
    toggleSidebar: useCallback(() => dispatch({ type: "TOGGLE_SIDEBAR" }), [dispatch]),
    setLoading: useCallback((v: boolean) => dispatch({ type: "SET_LOADING", payload: v }), [dispatch]),
    updateNoteInList: useCallback((v: Partial<NoteListItem> & { id: string }) => dispatch({ type: "UPDATE_NOTE_IN_LIST", payload: v }), [dispatch]),
    setSyncStatus: useCallback((v: SyncStatus) => dispatch({ type: "SET_SYNC_STATUS", payload: v }), [dispatch]),
    setLastSynced: useCallback((v: string) => dispatch({ type: "SET_LAST_SYNCED", payload: v }), [dispatch]),
    setMobileView: useCallback((v: MobileView) => dispatch({ type: "SET_MOBILE_VIEW", payload: v }), [dispatch]),
    setMobileSidebar: useCallback((v: boolean) => dispatch({ type: "SET_MOBILE_SIDEBAR", payload: v }), [dispatch]),
  };
}

import React, {
  Suspense,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";

import LazyWorkspaceFallback from "./LazyWorkspaceFallback";
import { useApp, useAppActions } from "@/store/AppContext";
import type { NoteListItem } from "@/types";

const LazyNoteList = React.lazy(() => import("./NoteList"));

function normalizeDirectorySearchQuery(query: string): string[] {
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 当前目录搜索只过滤 NoteList 已经加载的结果集，不切换全局 search view。
 * 因此它天然继承当前笔记本 / 知识树目录 / “当前层级或包含子文件夹” / 日期筛选范围。
 */
export function filterCurrentDirectoryNotes(
  notes: NoteListItem[],
  query: string,
): NoteListItem[] {
  const terms = normalizeDirectorySearchQuery(query);
  if (terms.length === 0) return notes;

  return notes.filter((note) => {
    const searchable = `${note.title || ""}\n${note.contentText || ""}`.toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

function noteListSignature(notes: NoteListItem[]): string {
  return notes.map((note) => [
    note.id,
    note.version || 0,
    note.updatedAt || "",
    note.title || "",
    note.contentText?.length || 0,
    note.notebookId || "",
    note.isTrashed || 0,
  ].join(":"))
    .join("|");
}

type AppliedFilterSnapshot = {
  signature: string;
  ids: Set<string>;
};

function findDesktopNoteListHeader(shell: HTMLElement): HTMLElement | null {
  const noteRoot = Array.from(shell.children).find((child) => (
    child instanceof HTMLElement
    && child.classList.contains("w-full")
    && child.classList.contains("h-full")
    && child.classList.contains("border-r")
  ));
  if (!(noteRoot instanceof HTMLElement)) return null;

  return Array.from(noteRoot.children).find((child) => (
    child instanceof HTMLElement
    && child.tagName === "DIV"
    && child.classList.contains("hidden")
    && child.classList.contains("md:flex")
    && child.classList.contains("border-b")
  )) as HTMLElement | null;
}

export default function LazyNoteListRuntime() {
  const { state } = useApp();
  const actions = useAppActions();
  const shellRef = useRef<HTMLDivElement>(null);
  const [directoryQuery, setDirectoryQuery] = useState("");
  const deferredDirectoryQuery = useDeferredValue(directoryQuery);
  const [desktopHeaderTarget, setDesktopHeaderTarget] = useState<HTMLElement | null>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);

  // 保存“未做本目录搜索”时的完整列表。搜索期间只把筛选结果临时写回 notes，
  // 清空搜索即可即时恢复；NoteList 的网络刷新仍然是最终权威来源。
  const sourceNotesRef = useRef<NoteListItem[]>(state.notes);
  const lastAppliedFilterRef = useRef<AppliedFilterSnapshot | null>(null);
  const sourceRefreshPendingRef = useRef(false);

  const searchContextKey = `${state.viewMode}:${state.selectedNotebookId || ""}:${
    state.selectedKnowledgeTreeParentId === undefined
      ? "legacy"
      : state.selectedKnowledgeTreeParentId ?? "root"
  }`;
  const searchContextKeyRef = useRef(searchContextKey);
  const showDirectorySearch = state.viewMode === "notebook" && !!state.selectedNotebookId;
  const searchActive = showDirectorySearch && deferredDirectoryQuery.trim().length > 0;

  // NoteList 是 lazy chunk。等它真实挂载后定位桌面 header，把搜索框通过 portal
  // 放到“目录标题”和右侧排序/新建按钮之间；不复制/重写 NoteList 的大块布局代码。
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    let annotatedHeader: HTMLElement | null = null;
    let titleGroup: HTMLElement | null = null;
    let actionGroup: HTMLElement | null = null;

    const clearAnnotation = () => {
      titleGroup?.style.removeProperty("order");
      actionGroup?.style.removeProperty("order");
      annotatedHeader?.removeAttribute("data-note-directory-search-header");
      annotatedHeader = null;
      titleGroup = null;
      actionGroup = null;
    };

    const locateHeader = () => {
      const header = findDesktopNoteListHeader(shell);
      if (!header || header === annotatedHeader) return;

      clearAnnotation();
      annotatedHeader = header;
      titleGroup = header.firstElementChild instanceof HTMLElement
        ? header.firstElementChild
        : null;
      actionGroup = header.lastElementChild instanceof HTMLElement
        ? header.lastElementChild
        : null;

      // Portal 节点会被追加到 header 末尾，用 flex order 把它稳定放到左右两组控件中间。
      if (titleGroup) titleGroup.style.order = "0";
      if (actionGroup) actionGroup.style.order = "2";
      header.setAttribute("data-note-directory-search-header", "");
      setDesktopHeaderTarget(header);
    };

    locateHeader();
    const observer = new MutationObserver(locateHeader);
    observer.observe(shell, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      clearAnnotation();
      setDesktopHeaderTarget(null);
    };
  }, []);

  // 切换目录/笔记本/视图时，本目录搜索必须自动清空，避免把上一个目录的关键词
  // 带到新目录后造成“文档消失”的错觉。此时不恢复旧 source，交给 NoteList 的新请求接管。
  useEffect(() => {
    if (searchContextKeyRef.current === searchContextKey) return;
    searchContextKeyRef.current = searchContextKey;
    sourceNotesRef.current = state.notes;
    lastAppliedFilterRef.current = null;
    sourceRefreshPendingRef.current = false;
    setMatchCount(null);
    setDirectoryQuery("");
  }, [searchContextKey, state.notes]);

  // 搜索结果仍复用 NoteList 自己的虚拟列表、右键菜单、多选和打开笔记逻辑。
  // 这里只维护一个可恢复的“源列表 -> 本地筛选结果”视图层，不触发全局 FTS 搜索。
  useEffect(() => {
    const normalizedQuery = deferredDirectoryQuery.trim();

    if (!showDirectorySearch || !normalizedQuery) {
      setMatchCount(null);
      if (lastAppliedFilterRef.current) {
        const source = sourceNotesRef.current;
        lastAppliedFilterRef.current = null;
        sourceRefreshPendingRef.current = false;
        if (noteListSignature(state.notes) !== noteListSignature(source)) {
          actions.setNotes(source);
        }
        // 立即恢复本地快照后再请求一次权威列表，吸收搜索期间其它端的更新。
        actions.refreshNotes();
      } else {
        sourceNotesRef.current = state.notes;
      }
      return;
    }

    // NoteList 每次切换当前层级/递归范围、日期、排序或主动刷新时都会进入 loading。
    // 等请求结束后把服务端返回结果整体替换为新的 source，避免把旧目录/旧范围混进来。
    if (state.isLoading) {
      sourceRefreshPendingRef.current = true;
      return;
    }

    const currentSignature = noteListSignature(state.notes);
    const previousFilter = lastAppliedFilterRef.current;

    if (sourceRefreshPendingRef.current) {
      sourceRefreshPendingRef.current = false;
      sourceNotesRef.current = state.notes;
    } else if (!previousFilter) {
      sourceNotesRef.current = state.notes;
    } else if (currentSignature !== previousFilter.signature) {
      // 搜索期间的新增、删除、标题/摘要更新先合并回 source，再重新过滤。
      // 这样保存笔记或 WebSocket 列表更新不会把搜索结果卡在旧数据上。
      const currentIds = new Set(state.notes.map((note) => note.id));
      const removedVisibleIds = new Set(
        Array.from(previousFilter.ids).filter((id) => !currentIds.has(id)),
      );
      const merged = new Map<string, NoteListItem>();
      for (const note of sourceNotesRef.current) {
        if (!removedVisibleIds.has(note.id)) merged.set(note.id, note);
      }
      for (const note of state.notes) merged.set(note.id, note);
      sourceNotesRef.current = Array.from(merged.values());
    }

    const filtered = filterCurrentDirectoryNotes(sourceNotesRef.current, normalizedQuery);
    const filteredSignature = noteListSignature(filtered);
    setMatchCount(filtered.length);
    lastAppliedFilterRef.current = {
      signature: filteredSignature,
      ids: new Set(filtered.map((note) => note.id)),
    };

    if (filteredSignature !== currentSignature) {
      actions.setNotes(filtered);
    }
  }, [
    actions,
    deferredDirectoryQuery,
    showDirectorySearch,
    state.isLoading,
    state.notes,
  ]);

  // 搜索结果只是一个子集，不能在子集里做手动拖拽排序，否则会把未命中的文档
  // 从 reorder payload 中漏掉。搜索期间仅拦截“从列表内部发起”的 dragstart；
  // 从操作系统拖文件进来没有经过这个事件，因此文件导入不受影响。
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !searchActive) return;
    const preventInternalReorder = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    shell.addEventListener("dragstart", preventInternalReorder, true);
    return () => shell.removeEventListener("dragstart", preventInternalReorder, true);
  }, [searchActive]);

  const directorySearch = desktopHeaderTarget && showDirectorySearch
    ? createPortal(
        <div
          data-note-directory-search=""
          className={[
            "hidden min-w-0 md:flex",
            desktopHeaderTarget.dataset.noteWorkspaceLayout === "three-column"
              ? "order-3 basis-full w-full max-w-none px-0"
              : "order-1 max-w-[190px] flex-1 px-2",
          ].join(" ")}
          title={directoryQuery.trim() && matchCount !== null
            ? `当前目录匹配 ${matchCount} 篇文档`
            : "搜索本目录文档"}
        >
          <div className="relative w-full min-w-0">
            <Search
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-tx-tertiary"
            />
            <input
              value={directoryQuery}
              onChange={(event) => setDirectoryQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && directoryQuery) {
                  event.preventDefault();
                  setDirectoryQuery("");
                }
              }}
              placeholder="搜索本目录…"
              aria-label="搜索本目录文档"
              className="h-7 w-full rounded-md border border-app-border bg-app-elevated/70 pl-7 pr-7 text-xs text-tx-primary outline-none transition-colors placeholder:text-tx-tertiary focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20"
            />
            {directoryQuery && (
              <button
                type="button"
                onClick={() => setDirectoryQuery("")}
                className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-secondary"
                title="清空本目录搜索"
                aria-label="清空本目录搜索"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>,
        desktopHeaderTarget,
      )
    : null;

  return (
    <div ref={shellRef} className="h-full w-full min-h-0">
      <Suspense fallback={<LazyWorkspaceFallback label="正在加载笔记列表…" />}>
        <LazyNoteList />
      </Suspense>
      {directorySearch}
    </div>
  );
}

/**
 * 笔记流（笔记 tab 的首页）
 *
 * 设计取向：**默认扁平，可选文件夹**。
 *   旧版是「笔记本列表 → 笔记列表 → 笔记」三级收纳，手机上每看一篇都要点三层。
 *   所以默认是平铺全部笔记，点一条就是那一篇。
 *   但要在一千多篇里找"那一本里的东西"时，扁平流是没法用的 ——
 *   所以顶部加了视图切换：`仅看笔记`（默认）/ `文件夹排布`（按笔记本层级分组，可折叠）。
 *
 *   两个视图**共用同一份数据与同一套过滤**（隐藏名单 + 关键词），
 *   所以切换视图不会出现"条数变了"的错觉。
 *   想整体缩小范围 → 去「设置 · 笔记展示」勾掉不想看的笔记本（偏好存在本地，见 notebookPrefs.ts）。
 *
 * 数据：`GET /api/notes`（不带 notebookId 时服务端返回该用户的全部个人笔记）
 *   —— 实测 backend/src/routes/notes.ts 在个人空间下会拼 `AND notes.userId = ?`。
 */
import { useEffect, useMemo, useState } from "react";
import { getClient } from "../api/client";
import { noteEditHref, noteHref } from "../lib/router";
import { getHiddenNotebookIds, subscribeNotebookPrefs } from "../lib/notebookPrefs";
import {
  getExpandedNotebookIds,
  getNotesViewMode,
  setNotesViewMode,
  toggleNotebookExpanded,
  type NotesViewMode,
} from "../lib/noteViewPrefs";
import { excerpt, relativeTime } from "../lib/noteFormat";
import { parseServerTime } from "../lib/time";
import { cacheNoteList, getCachedNoteList } from "../lib/preloadCache";
import { buildNotebookFolders } from "../lib/notebookFolders";
import { flattenNotebooks, type FlatNotebook } from "../lib/notebookTree";
import { SearchBar, highlight } from "../shell/SearchBar";
import { ViewSwitch } from "../shell/ViewSwitch";
import { NotebookFolders, type FolderScope } from "../shell/NotebookFolders";
import { NotebookPicker } from "../shell/NotebookPicker";
import { Fab } from "../shell/Fab";
import { TopBar } from "../App";
import type { Note, NoteSummary, Notebook } from "../../sdk/types";
import { useI18n } from "../lib/i18n";

export function NotesFeedScreen() {
  const { t } = useI18n();
  /**
   * 预加载：先用上次缓存的列表**立刻**渲染（stale-while-revalidate），
   * 网络回来后覆盖。用户看到的是「打开就有内容」，而不是白屏转圈。
   */
  const [notes, setNotes] = useState<NoteSummary[] | null>(() => getCachedNoteList());
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [hidden, setHidden] = useState<string[]>(() => getHiddenNotebookIds());
  const [viewMode, setViewMode] = useState<NotesViewMode>(() => getNotesViewMode());
  const [expanded, setExpanded] = useState<string[]>(() => getExpandedNotebookIds());
  /**
   * 从「文件夹排布」点进来时只看这个文件夹（含子孙）。
   * 文件夹视图里**不列笔记**，所以「进文件夹看笔记」必须落到「仅看笔记」上。
   */
  const [scope, setScope] = useState<FolderScope | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [noteList, notebookList] = await Promise.all([
          getClient().listNotes() as Promise<NoteSummary[]>,
          getClient().listNotebooks() as Promise<Notebook[]>,
        ]);
        if (cancelled) return;
        setNotes(noteList);
        cacheNoteList(noteList);
        setNotebooks(notebookList);
        setHidden(getHiddenNotebookIds());
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 设置页改了「笔记展示」后立刻生效（两个 tab 同时存在，不能只靠挂载时读一次）
  useEffect(() => subscribeNotebookPrefs(() => setHidden(getHiddenNotebookIds())), []);

  /** id → 笔记本名（平铺后仍需要让用户知道这篇属于哪儿，但只作为次要信息） */
  const notebookName = useMemo(() => {
    const map = new Map<string, string>();
    const walk = (list: Notebook[]) => {
      for (const nb of list) {
        map.set(nb.id, nb.name || t("notes.unnamedNotebook"));
        if (nb.children?.length) walk(nb.children);
      }
    };
    if (notebooks) walk(notebooks);
    return map;
  }, [notebooks]);

  const flatNotebooks: FlatNotebook[] = useMemo(
    () => (notebooks ? flattenNotebooks(notebooks) : []),
    [notebooks],
  );

  /** 两个视图共用的过滤结果：先按隐藏名单剪掉，再按关键词过滤，最后置顶 + 时间倒序 */
  const visible = useMemo(() => {
    if (!notes) return null;
    const kw = keyword.trim().toLowerCase();
    const filtered = notes.filter((n) => {
      if (hidden.includes(n.notebookId)) return false;
      if (!kw) return true;
      return (
        (n.title || "").toLowerCase().includes(kw) ||
        (n.contentText || "").toLowerCase().includes(kw)
      );
    });
    return [...filtered].sort((a, b) => {
      const pin = (b.isPinned ?? 0) - (a.isPinned ?? 0);
      if (pin !== 0) return pin;
      return (parseServerTime(b.updatedAt)?.getTime() ?? 0) - (parseServerTime(a.updatedAt)?.getTime() ?? 0);
    });
  }, [notes, keyword, hidden]);

  /**
   * 文件夹视图：**基于 visible（未按 scope 收窄）** 建树。
   * 否则进了某个文件夹后，树里就只剩那一个分支，等于没法再导航回去。
   */
  const folders = useMemo(
    () => (visible ? buildNotebookFolders(flatNotebooks, visible) : null),
    [visible, flatNotebooks],
  );

  /** scope 对应的笔记本集合（含子孙）；未归类时返回 null（走另一条判断） */
  const scopeIds = useMemo(() => {
    if (!scope || scope.kind !== "notebook" || !folders) return null;
    const ids = new Set<string>();
    const gather = (node: { id: string; children: typeof folders.tree }) => {
      ids.add(node.id);
      for (const child of node.children as unknown as Array<{ id: string; children: unknown }>) {
        gather(child as never);
      }
    };
    const find = (nodes: typeof folders.tree): boolean => {
      for (const node of nodes) {
        if (node.id === scope.id) {
          gather(node);
          return true;
        }
        if (find(node.children)) return true;
      }
      return false;
    };
    find(folders.tree);
    return ids;
  }, [scope, folders]);

  const knownNotebookIds = useMemo(
    () => new Set(flatNotebooks.map((nb) => nb.id)),
    [flatNotebooks],
  );

  /** 实际渲染的列表 = visible 再按文件夹收窄 */
  const scoped = useMemo(() => {
    if (!visible) return null;
    if (!scope) return visible;
    if (scope.kind === "unclassified") {
      return visible.filter((n) => !knownNotebookIds.has(n.notebookId));
    }
    if (!scopeIds) return visible;
    return visible.filter((n) => scopeIds.has(n.notebookId));
  }, [visible, scope, scopeIds, knownNotebookIds]);

  const loaded = notes !== null;
  const hiddenCount = loaded ? hidden.filter((id) => notebookName.has(id)).length : 0;

  function changeView(next: NotesViewMode) {
    setViewMode(next);
    setNotesViewMode(next);
  }

  function toggleFolder(id: string) {
    setExpanded(toggleNotebookExpanded(id));
  }

  /** 点文件夹行 → 切到「仅看笔记」并只看它（含子孙） */
  function enterFolder(next: FolderScope) {
    setScope(next);
    changeView("flat");
  }

  async function createNoteIn(notebookId: string) {
    if (creating) return;
    setCreating(true);
    try {
      const note = (await getClient().createNote({
        notebookId,
        title: t("note.untitled"),
        content: "",
        contentFormat: "markdown",
      })) as Note;
      if (!note?.id) throw new Error(t("common.internalError"));
      setPicking(false);
      window.location.hash = noteEditHref(note.id, note.title || t("note.untitled"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPicking(false);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <TopBar title={t("notes.title")} />
      <div className="app-content">
        {loaded && notes.length > 0 ? (
          <>
            <SearchBar value={keyword} onChange={setKeyword} placeholder={t("notes.searchPlaceholder")} />
            <ViewSwitch value={viewMode} onChange={changeView} />
          </>
        ) : null}

        {error ? <div className="notice">{error}</div> : null}
        {!loaded && !error ? <div className="loading">加载中…</div> : null}

        {/* 从文件夹排布点进来时的范围提示 —— 必须能一眼看到"我现在只看了一个文件夹"，并且能一键退出 */}
        {scope ? (
          <div className="scope-chip">
            <span className="scope-chip-text">
              🗂 {scope.kind === "unclassified" ? t("notes.unclassified") : scope.name}
              {scoped ? t("notes.scopeCount", { n: scoped.length }) : ""}
            </span>
            <button
              type="button"
              className="scope-chip-clear"
              onClick={() => setScope(null)}
              aria-label={t("notes.scopeAll")}
            >
              ×
            </button>
          </div>
        ) : null}

        {hiddenCount > 0 && !scope ? (
          <div className="feed-hint">
            {t("notes.hiddenHint", { n: hiddenCount })}
          </div>
        ) : null}

        {visible && loaded && notes.length === 0 ? (
          <div className="empty">{t("notes.empty")}</div>
        ) : null}

        {scoped && scoped.length === 0 && notes && notes.length > 0 ? (
          <div className="empty">
            {keyword.trim()
              ? t("notes.emptySearch", { kw: keyword })
              : scope
                ? t("notes.emptyScope")
                : t("notes.emptyVisible")}
          </div>
        ) : null}

        {/* 视图一：仅看笔记 —— 全部笔记按时间倒序（置顶在前） */}
        {scoped && scoped.length > 0 && viewMode === "flat" ? (
          <div className="card glass" data-view="flat">
            <ul className="list">
              {scoped.map((note) => (
                <li key={note.id}>
                  <a className="list-item" href={noteHref(note.id, note.title || t("note.untitled"))}>
                    <span className="li-main">
                      <span className="li-title">
                        {note.isPinned ? "📌 " : ""}
                        {highlight(note.title || t("note.untitled"), keyword)}
                      </span>
                      <span className="li-sub">
                        {relativeTime(note.updatedAt)}
                        {notebookName.get(note.notebookId)
                          ? ` · ${notebookName.get(note.notebookId)}`
                          : ""}
                        {excerpt(note.contentText) ? ` · ${excerpt(note.contentText)}` : ""}
                      </span>
                    </span>
                    <span className="li-chevron">›</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* 视图二：文件夹排布 —— 只显示文件夹层级，不列笔记（点文件夹才进「仅看笔记」） */}
        {visible && visible.length > 0 && viewMode === "folders" && folders ? (
          <div data-view="folders">
            <NotebookFolders
              tree={folders.tree}
              unclassifiedCount={folders.unclassified.length}
              expanded={expanded}
              onToggle={toggleFolder}
              onEnter={enterFolder}
            />
          </div>
        ) : null}
      </div>

      {/*
        ⚠️ FAB **必须常挂载**，不能写成 {loaded && … ? <Fab/> : null} ——
        它是这个页面的固定部件，条件挂载会让「切到本页 → 加载中（消失）→ 加载完（出现）」
        产生一次可见的闪烁（从说说切到笔记时最明显）。数据没到位时它照样在，
        点开选择器会显示「加载中…」。
      */}
      <Fab label={t("notes.newNote")} icon="＋" onClick={() => setPicking(true)} />

      <NotebookPicker
        open={picking}
        notebooks={flatNotebooks}
        title={t("notes.newNoteTo")}
        onPick={(id) => void createNoteIn(id)}
        onDismiss={() => setPicking(false)}
      />

    </>
  );
}

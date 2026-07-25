from pathlib import Path

path = Path("frontend/src/components/Sidebar.tsx")
text = path.read_text(encoding="utf-8")


def require_once(needle: str) -> None:
    count = text.count(needle)
    if count != 1:
        raise SystemExit(f"expected one occurrence, got {count}: {needle[:120]!r}")


# Imports
require_once('  ArrowUpDown, ArrowUp, ArrowDown,\n')
text = text.replace(
    '  ArrowUpDown, ArrowUp, ArrowDown,\n',
    '  ArrowUpDown, ArrowUp, ArrowDown, TreePine,\n',
)

require_once('import SharedNotebookTree from "@/components/SharedNotebookTree";\n')
text = text.replace(
    'import SharedNotebookTree from "@/components/SharedNotebookTree";\n',
    'import SharedNotebookTree from "@/components/SharedNotebookTree";\n'
    'import { OPEN_KNOWLEDGE_TREE_EVENT } from "@/components/KnowledgeTreeDrawer";\n'
    'import KnowledgeTreePanel, { FOCUS_KNOWLEDGE_TREE_EVENT } from "@/components/KnowledgeTreePanel";\n',
)

require_once('import { SIDEBAR_TREE_INDENT, sidebarNotebookDisclosureChrome, sidebarNotebookPaddingLeft, sidebarNotebookRowPaddingY, sidebarNotebookShowsDragHandle, sidebarTreeContentMinWidth, sidebarTreeRowMinWidth } from "@/lib/sidebarLayout";\n')
text = text.replace(
    'import { SIDEBAR_TREE_INDENT, sidebarNotebookDisclosureChrome, sidebarNotebookPaddingLeft, sidebarNotebookRowPaddingY, sidebarNotebookShowsDragHandle, sidebarTreeContentMinWidth, sidebarTreeRowMinWidth } from "@/lib/sidebarLayout";\n',
    'import { SIDEBAR_TREE_INDENT, sidebarNotebookDisclosureChrome, sidebarNotebookPaddingLeft, sidebarNotebookRowPaddingY, sidebarNotebookShowsDragHandle, sidebarTreeContentMinWidth, sidebarTreeRowMinWidth } from "@/lib/sidebarLayout";\n'
    'import {\n'
    '  loadSidebarTreeMode,\n'
    '  nextSidebarTreeMode,\n'
    '  saveSidebarTreeMode,\n'
    '  type SidebarTreeMode,\n'
    '} from "@/lib/sidebarTreeMode";\n',
)

# Default mode state: unified tree first, local legacy fallback only.
state_anchor = '  const [sharedNotebooks, setSharedNotebooks] = useState<Notebook[]>([]);\n'
require_once(state_anchor)
text = text.replace(
    state_anchor,
    '  const [sidebarTreeMode, setSidebarTreeMode] = useState<SidebarTreeMode>(() =>\n'
    '    loadSidebarTreeMode(typeof window === "undefined" ? null : window.localStorage),\n'
    '  );\n'
    + state_anchor,
)

# Mode switching and the old drawer shortcut/event now target the embedded panel.
insert_anchor = '  // 笔记本右键菜单项。\n'
require_once(insert_anchor)
mode_logic = '''  const changeSidebarTreeMode = useCallback((mode: SidebarTreeMode) => {
    setSidebarTreeMode(mode);
    saveSidebarTreeMode(mode, typeof window === "undefined" ? null : window.localStorage);
    if (mode === "knowledge") {
      setNotebooksExpanded(true);
      try { localStorage.setItem("nowen-notebooks-expanded", "true"); } catch {}
    }
  }, []);

  useEffect(() => {
    const focusKnowledgeTree = () => {
      changeSidebarTreeMode("knowledge");
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event(FOCUS_KNOWLEDGE_TREE_EVENT));
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusKnowledgeTree();
      }
    };
    window.addEventListener(OPEN_KNOWLEDGE_TREE_EVENT, focusKnowledgeTree);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener(OPEN_KNOWLEDGE_TREE_EVENT, focusKnowledgeTree);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [changeSidebarTreeMode]);

'''
text = text.replace(insert_anchor, mode_logic + insert_anchor)

# Replace the old notebook-only heading with the long-term primary-tree switch.
header_start = text.index('      {/* Notebooks */}')
animate_start = text.index('      <AnimatePresence initial={false}>', header_start)
new_header = '''      {/* Primary content hierarchy: unified tree by default; old notebook tree is a local compatibility fallback. */}
      <div className="px-3 flex items-center justify-between mb-1">
        <button
          onClick={() => toggleNotebooksExpanded()}
          className="flex min-w-0 items-center gap-1 hover:text-tx-secondary transition-colors"
        >
          <ChevronDown
            size={12}
            className={cn(
              "shrink-0 text-tx-tertiary transition-transform duration-200",
              !notebooksExpanded && "-rotate-90"
            )}
          />
          <span className="truncate text-xs font-medium text-tx-tertiary uppercase tracking-wider">
            {sidebarTreeMode === "knowledge" ? "内容" : `${t('sidebar.notebooks')} · 兼容`}
          </span>
        </button>
        <div className="relative flex items-center gap-0.5" ref={notebookSortMenuRef}>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-6 w-6", sidebarTreeMode === "legacy" && "text-amber-500 bg-amber-500/10")}
            onClick={(event) => {
              event.stopPropagation();
              changeSidebarTreeMode(nextSidebarTreeMode(sidebarTreeMode));
            }}
            title={sidebarTreeMode === "knowledge" ? "切换到旧笔记本树（兼容模式）" : "返回统一内容树"}
            aria-label={sidebarTreeMode === "knowledge" ? "切换到旧笔记本树（兼容模式）" : "返回统一内容树"}
            data-sidebar-tree-mode={sidebarTreeMode}
          >
            {sidebarTreeMode === "knowledge" ? <BookOpen size={14} /> : <TreePine size={14} />}
          </Button>
          {sidebarTreeMode === "legacy" && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-6 w-6",
                  rootNotebookSortPref.by !== "manual" && "text-accent-primary bg-accent-primary/10"
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenNotebookSortParentId((current) => current === ROOT_NOTEBOOK_SORT_KEY ? null : ROOT_NOTEBOOK_SORT_KEY);
                }}
                data-nowen-notebook-sort={isDesktop ? "true" : undefined}
                title={notebookSortTitle}
                aria-label={notebookSortTitle}
              >
                <ArrowUpDown size={14} />
              </Button>
              {openNotebookSortParentId === ROOT_NOTEBOOK_SORT_KEY && (
                <NotebookSortMenu
                  value={rootNotebookSortPref}
                  onChange={(next) => setRootNotebookSortPref(next)}
                  onClose={() => setOpenNotebookSortParentId(null)}
                />
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleToggleAllNotebooks}
                title={toggleAllNotebooksLabel}
                aria-label={toggleAllNotebooksLabel}
              >
                {hasExpandedNotebooks ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleCreateNotebook}
                title={t("common.newNotebook")}
                aria-label={t("common.newNotebook")}
              >
                <Plus size={14} />
              </Button>
            </>
          )}
        </div>
      </div>

'''
text = text[:header_start] + new_header + text[animate_start:]

# Rebuild only the render container while preserving the entire existing legacy tree block verbatim.
render_start = text.index('      <AnimatePresence initial={false}>', text.index('Primary content hierarchy'))
render_end = text.index('      {/* Tags ——', render_start)
old_render = text[render_start:render_end]
legacy_start = old_render.index('            <div\n              className={cn(')
legacy_end = old_render.rindex('          </motion.div>')
legacy_content = old_render[legacy_start:legacy_end]
new_render = '''      <AnimatePresence initial={false}>
        {notebooksExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0, overflow: "hidden" }}
            animate={{ height: "auto", opacity: 1, overflow: "visible", transitionEnd: { overflow: "visible" } }}
            exit={{ height: 0, opacity: 0, overflow: "hidden" }}
            transition={{ duration: 0.2 }}
            className="flex-1 min-h-0 flex flex-col"
          >
            {sidebarTreeMode === "knowledge" ? (
              <KnowledgeTreePanel
                variant={variant}
                className="min-h-0 flex-1"
                onRequestLegacy={() => changeSidebarTreeMode("legacy")}
              />
            ) : (
''' + legacy_content + '''
            )}
          </motion.div>
        )}
      </AnimatePresence>

'''
text = text[:render_start] + new_render + text[render_end:]

# Shared notebooks remain visible only with the old compatibility tree until they are represented as unified roots.
require_once('      {sharedNotebooks.length > 0 && (\n')
text = text.replace(
    '      {sharedNotebooks.length > 0 && (\n',
    '      {sidebarTreeMode === "legacy" && sharedNotebooks.length > 0 && (\n',
)

path.write_text(text, encoding="utf-8")
print("patched", path)

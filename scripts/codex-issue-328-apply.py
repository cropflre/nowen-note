from pathlib import Path

root = Path(__file__).resolve().parents[1]
panel = root / "frontend/src/components/SearchReplacePanel.tsx"
text = panel.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    if old not in text:
        raise SystemExit(f"missing {label}")
    text = text.replace(old, new, 1)


replace_once(
    'import { toast } from "@/lib/toast";\n',
    'import { toast } from "@/lib/toast";\nimport {\n  getSearchNavigationIndex,\n  isSearchNavigationUpdate,\n  scrollSearchMatchIntoView,\n} from "@/lib/searchMatchScroll";\n',
    "search scroll imports",
)

replace_once(
    '''              if (meta) {
                const next: SearchState = { ...prev, ...meta };''',
    '''              if (meta) {
                // 仅切换上一个/下一个时复用已有 matches，避免长笔记重复扫描全文。
                if (isSearchNavigationUpdate(meta as Record<string, unknown>)) {
                  const activeIndex = prev.matches.length === 0
                    ? -1
                    : Math.max(-1, Math.min(meta.activeIndex, prev.matches.length - 1));
                  return {
                    ...prev,
                    activeIndex,
                    deco: buildDecoSet(tr.doc, prev.matches, activeIndex),
                  };
                }
                const next: SearchState = { ...prev, ...meta };''',
    "navigation-only plugin branch",
)

replace_once(
    '  const queryInputRef = useRef<HTMLInputElement>(null);\n',
    '  const queryInputRef = useRef<HTMLInputElement>(null);\n  const scrollFrameRef = useRef<number | null>(null);\n',
    "scroll frame ref",
)

replace_once(
    '''  // 把当前命中滚到视口
  const scrollActiveIntoView = useCallback(() => {
    if (!editor) return;
    const s = searchReplacePluginKey.getState(editor.state);
    if (!s || s.activeIndex < 0) return;
    const m = s.matches[s.activeIndex];
    if (!m) return;
    const dom = editor.view.domAtPos(m.from);
    const node = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [editor]);
''',
    '''  // 用 ProseMirror 的精确坐标定位命中行，避免长代码块只滚动整个 <pre>/<code>。
  const scrollActiveIntoView = useCallback(() => {
    if (!editor) return;
    const s = searchReplacePluginKey.getState(editor.state);
    if (!s || s.activeIndex < 0) return;
    const m = s.matches[s.activeIndex];
    if (!m) return;
    const top = scrollSearchMatchIntoView({
      view: editor.view,
      match: m,
      // 连续按 Enter 时立即以最后一次导航为准，避免平滑动画追不上索引。
      behavior: "auto",
    });
    if (top === null) {
      editor.view.dom
        .querySelector<HTMLElement>(".search-match-active")
        ?.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [editor]);

  const scheduleActiveScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      scrollActiveIntoView();
    });
  }, [scrollActiveIntoView]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);
''',
    "precise active-match scrolling",
)

replace_once(
    '''  const goNext = useCallback(() => {
    if (!editor || matchCount === 0) return;
    const next = (activeIndex + 1) % matchCount;
    dispatchQuery({ activeIndex: next });
    requestAnimationFrame(scrollActiveIntoView);
  }, [editor, matchCount, activeIndex, dispatchQuery, scrollActiveIntoView]);

  const goPrev = useCallback(() => {
    if (!editor || matchCount === 0) return;
    const next = (activeIndex - 1 + matchCount) % matchCount;
    dispatchQuery({ activeIndex: next });
    requestAnimationFrame(scrollActiveIntoView);
  }, [editor, matchCount, activeIndex, dispatchQuery, scrollActiveIntoView]);
''',
    '''  const goNext = useCallback(() => {
    if (!editor) return;
    const s = searchReplacePluginKey.getState(editor.state);
    if (!s || s.matches.length === 0) return;
    dispatchQuery({
      activeIndex: getSearchNavigationIndex(s.activeIndex, s.matches.length, 1),
    });
    scheduleActiveScroll();
  }, [editor, dispatchQuery, scheduleActiveScroll]);

  const goPrev = useCallback(() => {
    if (!editor) return;
    const s = searchReplacePluginKey.getState(editor.state);
    if (!s || s.matches.length === 0) return;
    dispatchQuery({
      activeIndex: getSearchNavigationIndex(s.activeIndex, s.matches.length, -1),
    });
    scheduleActiveScroll();
  }, [editor, dispatchQuery, scheduleActiveScroll]);
''',
    "plugin-state navigation",
)

panel.write_text(text)
Path(__file__).unlink()
print("Applied Issue #328 minimal search scrolling fix")

from pathlib import Path

sidebar_path = Path("frontend/src/components/Sidebar.tsx")
sidebar = sidebar_path.read_text(encoding="utf-8")

anchor = '  const actions = useAppActions();\n  const { siteConfig } = useSiteSettings();\n'
if sidebar.count(anchor) != 1:
    raise SystemExit("Sidebar actions anchor changed")
sidebar = sidebar.replace(
    anchor,
    '  const actions = useAppActions();\n'
    '  const sidebarRootRef = useRef<HTMLDivElement>(null);\n'
    '  const { siteConfig } = useSiteSettings();\n',
)

focus_anchor = '''    const focusKnowledgeTree = () => {
      changeSidebarTreeMode("knowledge");
'''
if sidebar.count(focus_anchor) != 1:
    raise SystemExit("Sidebar focus anchor changed")
sidebar = sidebar.replace(
    focus_anchor,
    '''    const focusKnowledgeTree = () => {
      const root = sidebarRootRef.current;
      if (!root || root.getClientRects().length === 0) return;
      changeSidebarTreeMode("knowledge");
''',
)

root_anchor = '''    <div
      className="w-full h-full vibrancy-sidebar bg-app-sidebar border-r border-app-border flex flex-col shrink-0 transition-colors"
'''
if sidebar.count(root_anchor) != 1:
    raise SystemExit("Sidebar root anchor changed")
sidebar = sidebar.replace(
    root_anchor,
    '''    <div
      ref={sidebarRootRef}
      className="w-full h-full vibrancy-sidebar bg-app-sidebar border-r border-app-border flex flex-col shrink-0 transition-colors"
''',
)
sidebar_path.write_text(sidebar, encoding="utf-8")

panel_path = Path("frontend/src/components/KnowledgeTreePanel.tsx")
panel = panel_path.read_text(encoding="utf-8")

hook_anchor = '''function emitTreeChanged(reason: string) {
  window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_CHANGED_EVENT, { detail: { reason } }));
}

'''
if panel.count(hook_anchor) != 1:
    raise SystemExit("KnowledgeTreePanel hook anchor changed")
panel = panel.replace(
    hook_anchor,
    hook_anchor + '''function useActiveSidebarSurface(variant: "desktop" | "mobile") {
  const mediaQuery = variant === "desktop" ? "(min-width: 768px)" : "(max-width: 767px)";
  const [active, setActive] = useState(() =>
    typeof window === "undefined" ? variant === "desktop" : window.matchMedia(mediaQuery).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(mediaQuery);
    const update = () => setActive(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [mediaQuery]);

  return active;
}

''',
)

component_anchor = '''  const { state } = useApp();
  const actions = useAppActions();
  const searchRef = useRef<HTMLInputElement>(null);
'''
if panel.count(component_anchor) != 1:
    raise SystemExit("KnowledgeTreePanel component anchor changed")
panel = panel.replace(
    component_anchor,
    '''  const { state } = useApp();
  const actions = useAppActions();
  const surfaceActive = useActiveSidebarSurface(variant);
  const searchRef = useRef<HTMLInputElement>(null);
''',
)

initial_load = '  useEffect(() => { void reload(); }, [reload]);\n'
if panel.count(initial_load) != 1:
    raise SystemExit("KnowledgeTreePanel initial load anchor changed")
panel = panel.replace(
    initial_load,
    '''  useEffect(() => {
    if (surfaceActive) void reload();
  }, [reload, surfaceActive]);
''',
)

workspace_effect = '''  useEffect(() => {
    const refresh = () => void reload();
    window.addEventListener("nowen:workspace-changed", refresh);
    window.addEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("nowen:workspace-changed", refresh);
      window.removeEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    };
  }, [reload]);
'''
if panel.count(workspace_effect) != 1:
    raise SystemExit("KnowledgeTreePanel refresh effect changed")
panel = panel.replace(
    workspace_effect,
    '''  useEffect(() => {
    if (!surfaceActive) return;
    const refresh = () => void reload();
    window.addEventListener("nowen:workspace-changed", refresh);
    window.addEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("nowen:workspace-changed", refresh);
      window.removeEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    };
  }, [reload, surfaceActive]);
''',
)

focus_effect = '''  useEffect(() => {
    const focus = () => {
      requestAnimationFrame(() => searchRef.current?.focus());
    };
    window.addEventListener(FOCUS_KNOWLEDGE_TREE_EVENT, focus);
    return () => window.removeEventListener(FOCUS_KNOWLEDGE_TREE_EVENT, focus);
  }, []);
'''
if panel.count(focus_effect) != 1:
    raise SystemExit("KnowledgeTreePanel focus effect changed")
panel = panel.replace(
    focus_effect,
    '''  useEffect(() => {
    if (!surfaceActive) return;
    const focus = () => {
      requestAnimationFrame(() => searchRef.current?.focus());
    };
    window.addEventListener(FOCUS_KNOWLEDGE_TREE_EVENT, focus);
    return () => window.removeEventListener(FOCUS_KNOWLEDGE_TREE_EVENT, focus);
  }, [surfaceActive]);
''',
)

section_anchor = '    <section ref={menuRootRef} className={cn("relative flex min-h-0 flex-1 flex-col", className)} data-nowen-knowledge-tree="embedded">\n'
if panel.count(section_anchor) != 1:
    raise SystemExit("KnowledgeTreePanel section anchor changed")
panel = panel.replace(
    section_anchor,
    '    <section ref={menuRootRef} className={cn("relative flex min-h-0 flex-1 flex-col", className)} data-nowen-knowledge-tree="embedded" data-sidebar-surface-active={surfaceActive ? "true" : "false"}>\n',
)

panel_path.write_text(panel, encoding="utf-8")
print("patched visible Sidebar surface gating")

from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)


def remove_between(text: str, start: str, end: str, replacement: str, label: str) -> str:
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f"{label}: start anchor missing")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f"{label}: end anchor missing")
    return text[:start_index] + replacement + text[end_index:]


sidebar_path = Path("frontend/src/components/Sidebar.tsx")
sidebar = sidebar_path.read_text(encoding="utf-8")

sidebar = replace_once(
    sidebar,
    'import SharedNotebookTree from "@/components/SharedNotebookTree";\n',
    "",
    "remove SharedNotebookTree import",
)
sidebar = replace_once(
    sidebar,
    '''import {
  loadSidebarTreeMode,
  nextSidebarTreeMode,
  saveSidebarTreeMode,
  type SidebarTreeMode,
} from "@/lib/sidebarTreeMode";
''',
    "",
    "remove sidebar tree mode import",
)
sidebar = replace_once(
    sidebar,
    '''  const [sidebarTreeMode, setSidebarTreeMode] = useState<SidebarTreeMode>(() =>
    loadSidebarTreeMode(typeof window === "undefined" ? null : window.localStorage),
  );
  const [sharedNotebooks, setSharedNotebooks] = useState<Notebook[]>([]);
''',
    "",
    "remove legacy tree state",
)
sidebar = replace_once(
    sidebar,
    '''  const changeSidebarTreeMode = useCallback((mode: SidebarTreeMode) => {
    setSidebarTreeMode(mode);
    saveSidebarTreeMode(mode, typeof window === "undefined" ? null : window.localStorage);
    if (mode === "knowledge") {
      setNotebooksExpanded(true);
      try { localStorage.setItem("nowen-notebooks-expanded", "true"); } catch {}
    }
  }, []);

''',
    "",
    "remove legacy tree mode callback",
)
sidebar = replace_once(
    sidebar,
    '      changeSidebarTreeMode("knowledge");\n',
    "",
    "remove focus mode switch",
)
sidebar = replace_once(
    sidebar,
    '  }, [changeSidebarTreeMode]);\n',
    '  }, []);\n',
    "make focus effect mode-independent",
)
sidebar = replace_once(
    sidebar,
    '      api.getSharedNotebooks().then(setSharedNotebooks).catch(console.error);\n',
    "",
    "remove old shared notebook request",
)

header_start = '      {/* Primary content hierarchy: unified tree by default; old notebook tree is a local compatibility fallback. */}\n'
header_end = '      <AnimatePresence initial={false}>\n'
new_header = '''      {/* Unified knowledge tree is the only directory hierarchy. */}
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
            内容
          </span>
        </button>
      </div>

'''
sidebar = remove_between(sidebar, header_start, header_end, new_header, "replace directory header")

render_start = '            {sidebarTreeMode === "knowledge" ? (\n'
render_end = '          </motion.div>\n'
new_render = '''            <KnowledgeTreePanel
              variant={variant}
              className="min-h-0 flex-1"
            />
'''
sidebar = remove_between(sidebar, render_start, render_end, new_render, "replace legacy conditional render")

shared_start = '      {sidebarTreeMode === "legacy" && sharedNotebooks.length > 0 && (\n'
shared_end = '      <div className="border-t border-app-border shrink-0">\n'
sidebar = remove_between(sidebar, shared_start, shared_end, "", "remove independent shared tree")

# TreePine was only used by the deleted compatibility switch. Keep it only if another real use remains.
if sidebar.count("TreePine") == 1:
    sidebar = sidebar.replace("  ArrowUpDown, ArrowUp, ArrowDown, TreePine,\n", "  ArrowUpDown, ArrowUp, ArrowDown,\n", 1)

for forbidden in [
    "sidebarTreeMode",
    "SharedNotebookTree",
    "changeSidebarTreeMode",
    "sharedNotebooks",
    "nextSidebarTreeMode",
    "loadSidebarTreeMode",
    "saveSidebarTreeMode",
    "data-sidebar-tree-mode",
    "切换到旧笔记本树",
    "使用旧树",
]:
    if forbidden in sidebar:
        raise SystemExit(f"Sidebar still contains legacy directory token: {forbidden}")

sidebar_path.write_text(sidebar, encoding="utf-8")

panel_path = Path("frontend/src/components/KnowledgeTreePanel.tsx")
panel = panel_path.read_text(encoding="utf-8")
panel = replace_once(panel, "  onRequestLegacy?: () => void;\n", "", "remove legacy fallback prop")
panel = replace_once(panel, "  onRequestLegacy,\n", "", "remove legacy fallback destructure")
panel = replace_once(
    panel,
    '              {onRequestLegacy && <button type="button" onClick={onRequestLegacy} className="rounded-md border border-app-border px-2.5 py-1 text-[10px] text-tx-secondary hover:bg-app-hover">使用旧树</button>}\n',
    "",
    "remove legacy fallback button",
)
if "onRequestLegacy" in panel or "使用旧树" in panel:
    raise SystemExit("KnowledgeTreePanel still exposes a legacy fallback")
panel_path.write_text(panel, encoding="utf-8")

contract_path = Path("frontend/src/lib/__tests__/knowledgeTreeSidebarContract.test.ts")
contract_path.write_text('''import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("knowledge tree sidebar contract", () => {
  it("uses the unified tree as the only Sidebar hierarchy", () => {
    const sidebar = source("../../components/Sidebar.tsx");
    expect(sidebar).toContain('import KnowledgeTreePanel');
    expect(sidebar).toContain('<KnowledgeTreePanel');
    expect(sidebar).not.toContain("sidebarTreeMode");
    expect(sidebar).not.toContain("SharedNotebookTree");
    expect(sidebar).not.toContain("getSharedNotebooks");
    expect(sidebar).not.toContain("兼容模式");
  });

  it("does not render the former floating drawer launcher", () => {
    const drawer = source("../../components/KnowledgeTreeDrawer.tsx");
    expect(drawer).not.toContain("createPortal");
    expect(drawer).not.toContain("fixed bottom-4");
    expect(drawer).toContain("must not render a second drawer");
  });

  it("keeps loading recovery inside one embedded panel without a legacy fallback", () => {
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    expect(panel).toContain('data-nowen-knowledge-tree="embedded"');
    expect(panel).toContain("内容树加载失败");
    expect(panel).toContain("不能移动到自己的子节点中");
    expect(panel).not.toContain("onRequestLegacy");
    expect(panel).not.toContain("使用旧树");
  });

  it("loads and focuses only the currently visible desktop or mobile tree", () => {
    const sidebar = source("../../components/Sidebar.tsx");
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    expect(sidebar).toContain("sidebarRootRef.current");
    expect(sidebar).toContain("root.getClientRects().length === 0");
    expect(panel).toContain("useActiveSidebarSurface");
    expect(panel).toContain('data-sidebar-surface-active={surfaceActive ? "true" : "false"}');
    expect(panel).toContain("if (!surfaceActive) return");
  });
});
''', encoding="utf-8")

for obsolete in [
    Path("frontend/src/components/SharedNotebookTree.tsx"),
    Path("frontend/src/lib/sidebarTreeMode.ts"),
    Path("frontend/src/lib/__tests__/sharedNotebookTree.test.ts"),
    Path("frontend/src/lib/__tests__/sidebarTreeMode.test.ts"),
]:
    if not obsolete.exists():
        raise SystemExit(f"obsolete file missing before removal: {obsolete}")
    obsolete.unlink()

workflow_path = Path(".github/workflows/knowledge-tree-only-ci.yml")
workflow_path.write_text('''name: Knowledge Tree Only CI

on:
  pull_request:
    branches: [main]
    paths:
      - 'frontend/src/components/Sidebar.tsx'
      - 'frontend/src/components/KnowledgeTreePanel.tsx'
      - 'frontend/src/components/SharedNotebookTree.tsx'
      - 'frontend/src/lib/sidebarTreeMode.ts'
      - 'frontend/src/lib/__tests__/knowledgeTreeSidebarContract.test.ts'
      - '.github/workflows/knowledge-tree-only-ci.yml'

permissions:
  contents: read

jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - name: Enforce single directory implementation
        run: |
          test ! -e frontend/src/components/SharedNotebookTree.tsx
          test ! -e frontend/src/lib/sidebarTreeMode.ts
          ! grep -R "sidebarTreeMode\\|SharedNotebookTree\\|onRequestLegacy\\|使用旧树\\|切换到旧笔记本树" frontend/src/components/Sidebar.tsx frontend/src/components/KnowledgeTreePanel.tsx
          grep -q "<KnowledgeTreePanel" frontend/src/components/Sidebar.tsx
      - name: Install frontend dependencies
        working-directory: frontend
        run: npm ci --silent
      - name: Knowledge tree Sidebar contract
        working-directory: frontend
        run: npm run test:run -- src/lib/__tests__/knowledgeTreeSidebarContract.test.ts src/lib/__tests__/sharedKnowledgeTree.test.ts
      - name: Frontend typecheck
        working-directory: frontend
        run: npx tsc -b
''', encoding="utf-8")

print("patched Sidebar to use the unified knowledge tree exclusively")

path = r'C:\UGit\nowen-note\frontend\src\components\Sidebar.tsx'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Step 1: Add collapsed prop to the function signature
old_sig = 'export default function Sidebar({ variant = "mobile" }: { variant?: "desktop" | "mobile" } = {}) {'
new_sig = 'export default function Sidebar({ variant = "mobile", collapsed = false }: { variant?: "desktop" | "mobile"; collapsed?: boolean } = {}) {'
content = content.replace(old_sig, new_sig, 1)

# Step 2: Add imports for NavRail icons and state
# Check what's already imported from lucide-react
old_lucide = 'import {\n  BookOpen, Plus, Star, Trash2, Search, ChevronRight,'
new_lucide = 'import {\n  BookOpen, Plus, Star, Trash2, Search, ChevronRight,\n  PanelLeftClose, PanelLeft, Settings, LogOut, Cloud, CloudOff,'
content = content.replace(old_lucide, new_lucide, 1)

# Step 3: Add import for NAV_CONFIG from NavRail or define inline
# Actually, let's import the necessary types and use inline nav items
# Add import for useRailMode if not already there
# It's already imported: import { useRailMode, nextRailMode } from "@/hooks/useRailMode";

# Step 4: Add collapsed rendering at the start of the return statement
# Find the return statement
old_return = """  return (
    <div
      className="w-full h-full vibrancy-sidebar bg-app-sidebar border-r border-app-border flex flex-col shrink-0 transition-colors"
      style={{ width: undefined }}
    >"""

new_return = """  return (
    <div
      className={cn(
        "h-full vibrancy-sidebar bg-app-sidebar border-r border-app-border flex flex-col shrink-0 transition-[width] duration-150",
        collapsed ? "w-12" : "w-full",
      )}
      style={{ width: undefined }}
    >
      {/* Collapsed state: show only nav icons in a narrow rail */}
      {collapsed && (
        <>
          <button
            onClick={actions.toggleSidebar}
            title={t('common.expand')}
            aria-label={t('common.expand')}
            className="w-10 h-10 mx-auto mt-1 rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
          >
            <PanelLeft size={16} />
          </button>
          <div className="my-2 border-t border-app-border/60 w-6 mx-auto" aria-hidden />
          <div className="flex-1 min-h-0 w-full overflow-y-auto no-scrollbar flex flex-col items-center gap-1 px-1">
            {navItems.map((item) => {
              const active = item.active;
              return (
                <button
                  key={item.mode}
                  onClick={() => {
                    actions.setViewMode(item.mode);
                    actions.setSelectedNotebook(null);
                  }}
                  title={item.label}
                  aria-label={item.label}
                  className={cn(
                    "relative w-10 h-10 rounded-lg flex items-center justify-center transition-colors",
                    active
                      ? "bg-accent-primary/12 text-accent-primary"
                      : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent-primary" aria-hidden />
                  )}
                  {item.icon}
                </button>
              );
            })}
          </div>
          <div className="my-2 border-t border-app-border/60 w-6 mx-auto" aria-hidden />
          <button
            onClick={() => setShowSettings(true)}
            title={t('sidebar.settings')}
            aria-label={t('sidebar.settings')}
            className="w-10 h-10 mx-auto rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
          >
            <Settings size={16} />
          </button>
        </>
      )}

      {/* Expanded state: full sidebar content */}
      {!collapsed && ("""

# Actually this approach is getting too complex. Let me simplify.
# Instead of modifying the return JSX heavily, let me just wrap the existing content.

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

# Verify
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()
print("collapsed prop:", "collapsed = false" in c)
print("PanelLeft imported:", "PanelLeft" in c.split("from \"lucide-react\"")[0] if "from \"lucide-react\"" in c else False)

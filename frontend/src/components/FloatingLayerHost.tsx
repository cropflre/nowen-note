import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Files,
  GripVertical,
  Home,
  ListTodo,
  Network,
  Settings,
  Share2,
  Sparkles,
  Star,
  type LucideIcon,
} from "lucide-react";
import { useApp, useAppActions } from "@/store/AppContext";
import type { ViewMode } from "@/types";
import {
  PLUGIN_CONTRIBUTIONS_CHANGED_EVENT,
  pluginApi,
  type PluginNavigationTarget,
  type PluginUiIcon,
} from "@/lib/pluginApi";
import {
  clearPluginUiComponents,
  currentUiPlatform,
  listPluginUiComponents,
  replacePluginUiComponents,
  type RegisteredPluginUiAction,
} from "@/lib/pluginUiRegistry";
import {
  loadUiExtensionLayout,
  resolveFloatingLayer,
  resolveFloatingLayerPosition,
  saveUiExtensionLayout,
  uiExtensionLayoutStorageKey,
  type FloatingLayerPosition,
  type UiExtensionLayout,
} from "@/lib/uiExtensionLayout";

const ICONS: Record<PluginUiIcon, LucideIcon> = {
  home: Home,
  star: Star,
  files: Files,
  diary: CalendarDays,
  tasks: ListTodo,
  mindmap: Network,
  ai: Sparkles,
  shares: Share2,
  settings: Settings,
};

const VIEW_TARGETS: Partial<Record<PluginNavigationTarget, ViewMode>> = {
  all: "all",
  favorites: "favorites",
  files: "files",
  diary: "diary",
  tasks: "tasks",
  mindmaps: "mindmaps",
  "ai-chat": "ai-chat",
  shares: "shares",
};

const POSITION_CLASSES: Record<FloatingLayerPosition, string> = {
  "bottom-left": "bottom-[calc(var(--safe-area-bottom)+1rem)] left-4 flex-row",
  "bottom-center": "bottom-[calc(var(--safe-area-bottom)+1rem)] left-1/2 -translate-x-1/2 flex-row",
  "bottom-right": "bottom-[calc(var(--safe-area-bottom)+1rem)] right-4 flex-row",
  "left-center": "left-4 top-1/2 -translate-y-1/2 flex-col",
  "right-center": "right-4 top-1/2 -translate-y-1/2 flex-col",
};

const POSITION_CYCLE: FloatingLayerPosition[] = ["bottom-center", "bottom-right", "right-center", "left-center", "bottom-left"];

export function resolveUiNavigation(target: PluginNavigationTarget): { kind: "settings" } | { kind: "view"; view: ViewMode } | null {
  if (target === "settings") return { kind: "settings" };
  const view = VIEW_TARGETS[target];
  return view ? { kind: "view", view } : null;
}

export default function FloatingLayerHost() {
  const { state } = useApp();
  const actions = useAppActions();
  const [enabled, setEnabled] = useState(false);
  const [components, setComponents] = useState<RegisteredPluginUiAction[]>([]);
  const [layout, setLayout] = useState<UiExtensionLayout>(() => loadUiExtensionLayout());

  const load = useCallback(async () => {
    try {
      const features = await pluginApi.features();
      if (!features.uiExtensions) {
        clearPluginUiComponents();
        setEnabled(false);
        setComponents([]);
        return;
      }
      replacePluginUiComponents(await pluginApi.contributions());
      setComponents(listPluginUiComponents(currentUiPlatform()));
      setEnabled(true);
    } catch {
      clearPluginUiComponents();
      setEnabled(false);
      setComponents([]);
    }
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, load);
    return () => window.removeEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, load);
  }, [load]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === uiExtensionLayoutStorageKey()) setLayout(loadUiExtensionLayout());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const visible = useMemo(() => resolveFloatingLayer(components, layout), [components, layout]);

  const setPosition = useCallback((position: FloatingLayerPosition) => {
    setLayout((current) => {
      const next = { ...current, position };
      saveUiExtensionLayout(next);
      return next;
    });
  }, []);

  const onDragHandlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const onPointerUp = (pointerEvent: PointerEvent) => {
      setPosition(resolveFloatingLayerPosition(pointerEvent.clientX, pointerEvent.clientY, window.innerWidth, window.innerHeight));
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }, [setPosition]);

  const cyclePosition = useCallback(() => {
    const current = POSITION_CYCLE.indexOf(layout.position);
    setPosition(POSITION_CYCLE[(current + 1) % POSITION_CYCLE.length]);
  }, [layout.position, setPosition]);

  const activate = useCallback((component: RegisteredPluginUiAction) => {
    const destination = resolveUiNavigation(component.action.target);
    if (!destination) return;
    if (destination.kind === "settings") {
      window.dispatchEvent(new Event("nowen:open-settings"));
    } else {
      actions.setViewMode(destination.view);
      actions.setMobileSidebar(false);
      actions.setMobileView("list");
    }
  }, [actions]);

  if (!enabled || visible.length === 0) return null;

  return (
    <div
      data-ui-extension-slot="floating-layer"
      data-ui-extension-position={layout.position}
      className={`fixed z-40 flex items-center gap-1 rounded-2xl border border-app-border bg-app-surface/90 p-1.5 shadow-xl backdrop-blur-xl ${POSITION_CLASSES[layout.position]}`}
    >
      <button
        type="button"
        aria-label="拖动悬浮栏；按 Enter 切换位置"
        title="拖动悬浮栏"
        onPointerDown={onDragHandlePointerDown}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            cyclePosition();
          }
        }}
        className="touch-none cursor-grab rounded-xl p-2 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary active:cursor-grabbing"
      >
        <GripVertical size={17} aria-hidden="true" />
      </button>
      {visible.map((component) => {
        const Icon = ICONS[component.icon];
        const destination = resolveUiNavigation(component.action.target);
        const active = destination?.kind === "view" && state.viewMode === destination.view;
        return (
          <button
            key={component.runtimeId}
            type="button"
            data-plugin-ui-component={component.runtimeId}
            aria-label={component.label}
            aria-pressed={active || undefined}
            title={component.description || component.label}
            onClick={() => activate(component)}
            className={`rounded-xl p-2.5 transition-colors ${active ? "bg-accent-subtle text-accent-primary" : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"}`}
          >
            <Icon size={19} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

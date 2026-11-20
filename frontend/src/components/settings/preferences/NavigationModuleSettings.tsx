import React, { useId, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useUserPreferences } from "@/hooks/useUserPreferences";
import {
  moveNavigationModule,
  normalizeNavigationModuleOrder,
  TASK_CENTER_OPTIONAL_MODULE_IDS,
  type NavigationModuleId,
  type TaskCenterOptionalModuleId,
} from "@/lib/navigationVisibility";
import { cn } from "@/lib/utils";
import { useApp, useAppActions } from "@/store/AppContext";
import { DisclosureRow, PreferenceGroup, SwitchRow, type PreferenceScope } from "./PreferenceControls";
import {
  navigationModuleAnchor,
  taskCenterModuleAnchor,
  useNavigationModuleLabels,
  useTaskCenterModuleLabels,
  visibleTaskCenterModuleCount,
} from "./navigationModules";

const iconButton = cn(
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors",
  "hover:bg-zinc-200/70 hover:text-zinc-700 disabled:pointer-events-none disabled:opacity-25",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50",
  "dark:hover:bg-zinc-800 dark:hover:text-zinc-200",
);

function NavigationModuleRow({
  id,
  label,
  visible,
  isFirst,
  isLast,
  dragging,
  onVisibleChange,
  onMove,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  id: NavigationModuleId;
  label: string;
  visible: boolean;
  isFirst: boolean;
  isLast: boolean;
  dragging: boolean;
  onVisibleChange: (visible: boolean) => void;
  onMove: (offset: -1 | 1) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const { t } = useTranslation();
  const switchId = useId();
  return (
    <div
      draggable
      data-navigation-module-order-item={id}
      data-preference-id={navigationModuleAnchor(id)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      className={cn(
        "flex min-h-[3.25rem] items-center gap-1.5 py-1.5 pl-2 pr-4 transition-colors hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40",
        dragging && "bg-accent-primary/5 opacity-60",
      )}
    >
      <span
        title={t("preferences.navigation.dragHandle", { name: label })}
        className="flex h-8 w-6 shrink-0 cursor-grab items-center justify-center text-zinc-400 active:cursor-grabbing [@media(pointer:coarse)]:hidden"
        aria-hidden="true"
      >
        <GripVertical size={15} />
      </span>
      <label
        htmlFor={switchId}
        className={cn(
          "min-w-0 flex-1 cursor-pointer truncate px-1 text-sm font-medium [@media(pointer:coarse)]:pl-2",
          visible ? "text-zinc-800 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500",
        )}
      >
        {label}
      </label>
      <button
        type="button"
        disabled={isFirst}
        onClick={() => onMove(-1)}
        className={iconButton}
        title={t("preferences.navigation.moveUp", { name: label })}
        aria-label={t("preferences.navigation.moveUp", { name: label })}
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        disabled={isLast}
        onClick={() => onMove(1)}
        className={iconButton}
        title={t("preferences.navigation.moveDown", { name: label })}
        aria-label={t("preferences.navigation.moveDown", { name: label })}
      >
        <ArrowDown size={14} />
      </button>
      <input
        id={switchId}
        type="checkbox"
        role="switch"
        checked={visible}
        onChange={(event) => onVisibleChange(event.target.checked)}
        className="accent-indigo-600 ml-1.5"
      />
    </div>
  );
}

/** Sidebar entries: show/hide and order. Hiding is presentation only; deep links still open hidden modules. */
export function NavigationModulesGroup({ modules, scope }: { modules: readonly NavigationModuleId[]; scope?: PreferenceScope }) {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();
  const { prefs, setPref } = useUserPreferences();
  const labels = useNavigationModuleLabels();
  const [dragged, setDragged] = useState<NavigationModuleId | null>(null);
  const order = normalizeNavigationModuleOrder(prefs.navigationModuleOrder).filter((id) => modules.includes(id));

  const setVisible = (id: NavigationModuleId, visible: boolean) => {
    const hidden = prefs.hiddenNavigationModules;
    setPref(
      "hiddenNavigationModules",
      visible ? hidden.filter((item) => item !== id) : Array.from(new Set([...hidden, id])),
    );
    // Hiding is a presentation preference, not an access-control rule. Only leave the
    // module that is open right now; later deep links can still open hidden modules.
    if (!visible && state.viewMode === id) actions.setViewMode("all");
  };

  return (
    <PreferenceGroup title={t("preferences.sections.navigationModules")} scope={scope} footer={t("preferences.sections.navigationHint")}>
      <div data-navigation-module-order-list="" data-preference-id="navigation-modules" className="divide-y divide-zinc-200/70 dark:divide-zinc-800">
        {order.map((id, index) => (
          <NavigationModuleRow
            key={id}
            id={id}
            label={labels[id]}
            visible={!prefs.hiddenNavigationModules.includes(id)}
            isFirst={index === 0}
            isLast={index === order.length - 1}
            dragging={dragged === id}
            onVisibleChange={(visible) => setVisible(id, visible)}
            onMove={(offset) => {
              const target = order[index + offset];
              if (target) setPref("navigationModuleOrder", moveNavigationModule(prefs.navigationModuleOrder, id, target));
            }}
            onDragStart={() => setDragged(id)}
            onDragEnd={() => setDragged(null)}
            onDrop={() => {
              if (!dragged) return;
              setPref("navigationModuleOrder", moveNavigationModule(prefs.navigationModuleOrder, dragged, id));
              setDragged(null);
            }}
          />
        ))}
      </div>
    </PreferenceGroup>
  );
}

/** Task Center keeps the task list; the optional modules are folded away until managed. */
export function TaskCenterModulesGroup({
  scope,
  open,
  onOpenChange,
}: {
  scope?: PreferenceScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { prefs, setPref } = useUserPreferences();
  const labels = useTaskCenterModuleLabels();
  const hidden = prefs.hiddenTaskCenterModules;

  const setVisible = (id: TaskCenterOptionalModuleId, visible: boolean) => {
    setPref(
      "hiddenTaskCenterModules",
      visible ? hidden.filter((item) => item !== id) : Array.from(new Set([...hidden, id])),
    );
  };

  return (
    <PreferenceGroup scope={scope} footer={t("preferences.sections.taskCenterDescription")}>
      <DisclosureRow
        anchorId="task-center-modules"
        title={t("preferences.sections.taskCenter")}
        summary={t("preferences.sections.taskCenterSummary", {
          visible: visibleTaskCenterModuleCount(hidden),
          total: TASK_CENTER_OPTIONAL_MODULE_IDS.length,
        })}
        open={open}
        onOpenChange={onOpenChange}
      >
        {TASK_CENTER_OPTIONAL_MODULE_IDS.map((id) => (
          <SwitchRow
            key={id}
            anchorId={taskCenterModuleAnchor(id)}
            title={labels[id]}
            checked={!hidden.includes(id)}
            onChange={(visible) => setVisible(id, visible)}
          />
        ))}
      </DisclosureRow>
    </PreferenceGroup>
  );
}

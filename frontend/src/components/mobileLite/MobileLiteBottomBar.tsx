import React, { useEffect, useRef } from "react";
import { FileText, Folder, MoreHorizontal, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { haptic } from "@/hooks/useCapacitor";
import { cn } from "@/lib/utils";

export type MobileLiteActiveTab = "notes" | "directory" | "search" | "more";

export interface MobileLiteBottomBarProps {
  activeTab: MobileLiteActiveTab;
  hidden?: boolean;
  onTapNotes: () => void;
  onLongPressNotes: () => void;
  onTapDirectory: () => void;
  onQuickCreate: () => void;
  onLongPressCreate: () => void;
  onTapSearch: () => void;
  onTapMore: () => void;
}

const LONG_PRESS_MS = 480;
const MOVE_CANCEL_PX = 10;

function useLongPress(onShortPress: () => void, onLongPress: () => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPointRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  return {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      firedRef.current = false;
      startPointRef.current = { x: event.clientX, y: event.clientY };
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        firedRef.current = true;
        haptic.medium();
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: React.PointerEvent) => {
      const start = startPointRef.current;
      if (!start || timerRef.current === null) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_CANCEL_PX) {
        clearTimer();
      }
    },
    onPointerUp: () => {
      clearTimer();
      startPointRef.current = null;
    },
    onPointerCancel: () => {
      clearTimer();
      startPointRef.current = null;
    },
    onClick: () => {
      if (firedRef.current) {
        firedRef.current = false;
        return;
      }
      onShortPress();
    },
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      clearTimer();
      firedRef.current = false;
      haptic.medium();
      onLongPress();
    },
  };
}

export default function MobileLiteBottomBar({
  activeTab,
  hidden = false,
  onTapNotes,
  onLongPressNotes,
  onTapDirectory,
  onQuickCreate,
  onLongPressCreate,
  onTapSearch,
  onTapMore,
}: MobileLiteBottomBarProps) {
  const { t } = useTranslation();
  const notesPress = useLongPress(onTapNotes, onLongPressNotes);
  const createPress = useLongPress(onQuickCreate, onLongPressCreate);

  if (hidden) return null;

  const itemClass = (active: boolean) =>
    cn(
      "flex min-h-[52px] min-w-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-[11px] font-medium transition-colors select-none touch-manipulation active:scale-95",
      active
        ? "text-accent-primary"
        : "text-tx-secondary hover:bg-app-hover/60 hover:text-tx-primary",
    );

  return (
    <nav
      data-mobile-lite-bottom-bar=""
      aria-label={t("mobileLite.nav.ariaLabel")}
      className="md:hidden shrink-0 border-t border-app-border bg-app-surface/95 backdrop-blur-md z-30"
      style={{ paddingBottom: "var(--safe-area-bottom)" }}
    >
      <div className="flex items-center justify-around gap-1 px-2 pt-1 pb-1">
        <button
          type="button"
          data-mobile-lite-tab="notes"
          aria-current={activeTab === "notes" ? "page" : undefined}
          className={itemClass(activeTab === "notes")}
          {...notesPress}
        >
          <FileText size={20} strokeWidth={activeTab === "notes" ? 2.2 : 1.8} />
          <span className="leading-none">{t("mobileLite.nav.notes")}</span>
        </button>

        <button
          type="button"
          data-mobile-lite-tab="directory"
          aria-current={activeTab === "directory" ? "page" : undefined}
          onClick={onTapDirectory}
          className={itemClass(activeTab === "directory")}
        >
          <Folder size={20} strokeWidth={activeTab === "directory" ? 2.2 : 1.8} />
          <span className="leading-none">{t("mobileLite.nav.directory")}</span>
        </button>

        <button
          type="button"
          data-mobile-lite-tab="create"
          aria-label={t("mobileLite.nav.create")}
          className="flex min-h-[52px] min-w-[56px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1 select-none touch-manipulation active:scale-95"
          {...createPress}
        >
          <span className="flex h-9 w-12 items-center justify-center rounded-2xl bg-accent-primary text-white shadow-sm shadow-accent-primary/30 transition-transform">
            <Plus size={22} strokeWidth={2.4} />
          </span>
          <span className="text-[10px] font-medium leading-none text-accent-primary">
            {t("mobileLite.nav.create")}
          </span>
        </button>

        <button
          type="button"
          data-mobile-lite-tab="search"
          aria-current={activeTab === "search" ? "page" : undefined}
          onClick={onTapSearch}
          className={itemClass(activeTab === "search")}
        >
          <Search size={20} strokeWidth={activeTab === "search" ? 2.2 : 1.8} />
          <span className="leading-none">{t("mobileLite.nav.search")}</span>
        </button>

        <button
          type="button"
          data-mobile-lite-tab="more"
          aria-current={activeTab === "more" ? "page" : undefined}
          onClick={onTapMore}
          className={itemClass(activeTab === "more")}
        >
          <MoreHorizontal size={20} strokeWidth={activeTab === "more" ? 2.2 : 1.8} />
          <span className="leading-none">{t("mobileLite.nav.more")}</span>
        </button>
      </div>
    </nav>
  );
}

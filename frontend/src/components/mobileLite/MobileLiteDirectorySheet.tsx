import React, { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Files, Star, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import MobileKnowledgeTreePanel from "@/components/MobileKnowledgeTreePanel";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";
import { MOTION_SPRING, overlayMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useApp, useAppActions } from "@/store/AppContext";

export interface MobileLiteDirectorySheetProps {
  open: boolean;
  onClose: () => void;
}

export default function MobileLiteDirectorySheet({
  open,
  onClose,
}: MobileLiteDirectorySheetProps) {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();

  useEffect(() => {
    if (!open) return;
    return registerMobileBackHandler("sheet", () => {
      onClose();
      return true;
    });
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const selectAllNotes = () => {
    actions.setSelectedNotebook(null);
    actions.clearSelectedTags();
    actions.setSearchQuery("");
    actions.setViewMode("all");
    actions.setMobileView("list");
    onClose();
  };

  const selectFavorites = () => {
    actions.setSelectedNotebook(null);
    actions.clearSelectedTags();
    actions.setSearchQuery("");
    actions.setViewMode("favorites");
    actions.setMobileView("list");
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <div
          data-mobile-lite-directory-sheet=""
          data-swipe-blocker="mobile-lite-directory"
          className="fixed inset-0 z-50 flex flex-col justify-end md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={t("mobileLite.directory.title")}
        >
          <motion.div
            initial={overlayMotion.initial}
            animate={overlayMotion.animate}
            exit={overlayMotion.exit}
            onClick={onClose}
            className="absolute inset-0 bg-zinc-900/55 backdrop-blur-[2px]"
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={MOTION_SPRING.panel}
            className="relative flex h-[74dvh] max-h-[82dvh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-app-border bg-app-sidebar shadow-2xl"
            style={{ paddingBottom: "var(--safe-area-bottom)" }}
          >
            <div className="flex justify-center pt-2 pb-1 shrink-0" aria-hidden="true">
              <span className="h-1 w-10 rounded-full bg-app-border" />
            </div>

            <div className="flex items-center justify-between gap-2 px-4 pb-2 shrink-0">
              <h2 className="text-base font-semibold text-tx-primary">
                {t("mobileLite.directory.title")}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("mobileLite.directory.close")}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
              >
                <X size={20} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 px-3 pb-2.5 shrink-0 border-b border-app-border/70">
              <button
                type="button"
                onClick={selectAllNotes}
                className={cn(
                  "flex min-h-[44px] items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium transition-colors",
                  state.viewMode === "all" && !state.selectedNotebookId
                    ? "border-accent-primary/40 bg-accent-primary/10 text-accent-primary"
                    : "border-app-border bg-app-surface text-tx-primary hover:bg-app-hover",
                )}
              >
                <Files size={16} />
                <span>{t("mobileLite.directory.allNotes")}</span>
              </button>
              <button
                type="button"
                onClick={selectFavorites}
                className={cn(
                  "flex min-h-[44px] items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium transition-colors",
                  state.viewMode === "favorites"
                    ? "border-accent-primary/40 bg-accent-primary/10 text-accent-primary"
                    : "border-app-border bg-app-surface text-tx-primary hover:bg-app-hover",
                )}
              >
                <Star size={16} className={state.viewMode === "favorites" ? "fill-current" : "text-amber-400"} />
                <span>{t("mobileLite.directory.favorites")}</span>
              </button>
            </div>

            <div className="flex min-h-0 flex-1 overflow-hidden">
              <MobileKnowledgeTreePanel onRequestCloseContainer={onClose} />
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

import React from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { useSkin } from "@/hooks/useSkin";
import {
  APP_APPEARANCES,
  resolveAppAppearanceMode,
  type AppAppearanceMode,
} from "@/lib/appAppearance";
import { cn } from "@/lib/utils";

export default function SkinSwitcher() {
  const { i18n } = useTranslation();
  const { skin, setSkin } = useSkin();
  const language = i18n.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  const [mode, setMode] = React.useState<AppAppearanceMode>(() => resolveAppAppearanceMode());

  React.useEffect(() => {
    const root = document.documentElement;
    const sync = () => setMode(resolveAppAppearanceMode(root));
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
    sync();
    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {APP_APPEARANCES.map((item) => {
        const selected = skin === item.id;
        const tokens = item.modes[mode];
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected}
            onClick={() => setSkin(item.id)}
            className={cn(
              "group relative rounded-xl border-2 p-3 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40",
              selected
                ? "border-accent-primary bg-accent-primary/5"
                : "border-app-border bg-app-surface hover:border-tx-tertiary",
            )}
          >
            <div
              className="relative mb-3 h-24 overflow-hidden border"
              style={{
                background: tokens.bg,
                borderColor: tokens.border,
                borderRadius: tokens.radiusCard,
              }}
            >
              <div
                className="absolute inset-y-0 left-0 w-[31%] border-r"
                style={{ background: tokens.sidebarSolid, borderColor: tokens.border }}
              />
              <div
                className="absolute left-[31%] right-0 top-0 h-[24%] border-b"
                style={{ background: tokens.surface, borderColor: tokens.border }}
              />
              <div
                className="absolute bottom-0 left-[31%] right-0 top-[24%]"
                style={{ background: tokens.elevatedSolid }}
              />

              <div className="absolute left-2 top-3 space-y-1.5">
                <div className="h-1 w-10 rounded-full opacity-70" style={{ background: tokens.textSecondary }} />
                <div className="h-1 w-12 rounded-full opacity-45" style={{ background: tokens.textSecondary }} />
                <div className="h-1 w-8 rounded-full opacity-35" style={{ background: tokens.textSecondary }} />
              </div>

              <div className="absolute left-[38%] right-3 top-[33%] space-y-2">
                <div className="h-2 w-1/2 rounded-full opacity-90" style={{ background: tokens.textPrimary }} />
                <div className="h-1.5 w-full rounded-full opacity-45" style={{ background: tokens.textPrimary }} />
                <div className="h-1.5 w-4/5 rounded-full opacity-30" style={{ background: tokens.textPrimary }} />
                <div className="h-1.5 w-3/5 rounded-full opacity-25" style={{ background: tokens.textPrimary }} />
              </div>
              <div
                className="absolute bottom-3 right-3 h-3 w-8"
                style={{ background: tokens.accentPrimary, borderRadius: tokens.radiusButton }}
              />
            </div>

            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-tx-primary">
                  {item.name[language]}
                </div>
                <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-tx-tertiary">
                  {item.description[language]}
                </div>
              </div>
              {selected && (
                <motion.div
                  layoutId="skin-selected-check"
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-primary"
                  transition={{ type: "spring", duration: 0.3, bounce: 0.2 }}
                >
                  <Check size={12} className="text-white" strokeWidth={3} />
                </motion.div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

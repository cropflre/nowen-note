import React from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export default function ThemeToggle() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  const themes = [
    { key: "light", icon: Sun, label: t("theme.light") },
    { key: "dark", icon: Moon, label: t("theme.dark") },
    { key: "system", icon: Monitor, label: t("theme.system") },
  ] as const;

  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <div className="flex items-center gap-1 rounded-lg bg-app-hover p-1">
      {themes.map(({ key, icon: Icon, label }) => {
        const active = theme === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => {
              if (!active) setTheme(key);
            }}
            title={label}
            aria-label={label}
            aria-pressed={active}
            className={cn(
              "relative flex h-7 w-7 touch-manipulation items-center justify-center rounded-md transition-colors duration-100",
              active
                ? "bg-app-active text-accent-primary"
                : "text-tx-tertiary hover:text-tx-secondary active:bg-app-active/70",
            )}
            style={{ WebkitTapHighlightColor: "transparent" }}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

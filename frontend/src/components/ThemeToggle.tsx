import React from "react";
import { useTheme } from "next-themes";
import { motion, AnimatePresence } from "framer-motion";
import { Sun, Moon, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";

const themes = [
  { key: "light", icon: Sun, label: "浅色" },
  { key: "dark", icon: Moon, label: "深色" },
  { key: "system", icon: Monitor, label: "跟随系统" },
] as const;

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <div className="flex items-center gap-1 p-1 rounded-lg bg-app-hover">
      {themes.map(({ key, icon: Icon, label }) => (
        <button
          key={key}
          onClick={() => setTheme(key)}
          title={label}
          className={cn(
            "relative p-1.5 rounded-md transition-colors",
            theme === key
              ? "text-accent-primary"
              : "text-tx-tertiary hover:text-tx-secondary"
          )}
        >
          {theme === key && (
            <motion.div
              layoutId="theme-indicator"
              className="absolute inset-0 rounded-md bg-app-active"
              transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}
            />
          )}
          <AnimatePresence mode="wait">
            <motion.div
              key={key + (theme === key ? "-active" : "")}
              initial={{ rotate: -90, opacity: 0, scale: 0.8 }}
              animate={{ rotate: 0, opacity: 1, scale: 1 }}
              exit={{ rotate: 90, opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2 }}
              className="relative z-10"
            >
              <Icon size={14} />
            </motion.div>
          </AnimatePresence>
        </button>
      ))}
    </div>
  );
}

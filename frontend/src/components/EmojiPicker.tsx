import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Clock3, Search, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  EMOJI_CATEGORIES,
  EMOJI_RECENT_STORAGE_KEY,
  filterEmojis,
  parseRecentEmojis,
  pushRecentEmoji,
  type EmojiSearchResult,
} from "@/data/emojiData";
import { cn } from "@/lib/utils";

export interface EmojiPickerProps {
  currentIcon: string;
  onSelect: (emoji: string) => void;
  onClose: () => void;
  position: { top: number; left: number };
}

type PickerCategory = "recent" | string;

const PICKER_WIDTH = 352;
const VIEWPORT_GAP = 8;

function readRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return parseRecentEmojis(window.localStorage.getItem(EMOJI_RECENT_STORAGE_KEY));
  } catch {
    return [];
  }
}

function saveRecent(emojis: string[]): void {
  try {
    window.localStorage.setItem(EMOJI_RECENT_STORAGE_KEY, JSON.stringify(emojis));
  } catch {
    // Private mode / storage quota should never block icon selection.
  }
}

export default function EmojiPicker({ currentIcon, onSelect, onClose, position }: EmojiPickerProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [activeCategory, setActiveCategory] = useState<PickerCategory>(() => recent.length ? "recent" : EMOJI_CATEGORIES[0].id);
  const [adjustedPosition, setAdjustedPosition] = useState(position);
  const [maxHeight, setMaxHeight] = useState(460);

  const searchResults = useMemo<EmojiSearchResult[]>(() => filterEmojis(query), [query]);
  const activeEmojis = useMemo(() => {
    if (query.trim()) return searchResults.map((item) => item.emoji);
    if (activeCategory === "recent") return recent;
    return EMOJI_CATEGORIES.find((category) => category.id === activeCategory)?.emojis || [];
  }, [activeCategory, query, recent, searchResults]);

  const updatePosition = useCallback(() => {
    const panelHeight = panelRef.current?.offsetHeight || Math.min(460, window.innerHeight - VIEWPORT_GAP * 2);
    const availableHeight = Math.max(220, window.innerHeight - VIEWPORT_GAP * 2);
    let top = position.top;
    let left = position.left;

    if (left + PICKER_WIDTH > window.innerWidth - VIEWPORT_GAP) {
      left = window.innerWidth - PICKER_WIDTH - VIEWPORT_GAP;
    }
    if (top + panelHeight > window.innerHeight - VIEWPORT_GAP) {
      top = window.innerHeight - panelHeight - VIEWPORT_GAP;
    }

    setMaxHeight(Math.min(460, availableHeight));
    setAdjustedPosition({
      top: Math.max(VIEWPORT_GAP, top),
      left: Math.max(VIEWPORT_GAP, left),
    });
  }, [position.left, position.top]);

  useLayoutEffect(() => {
    updatePosition();
  }, [activeCategory, query, updatePosition]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePosition);
    window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePosition);
    };
  }, [onClose, updatePosition]);

  const handleSelect = (emoji: string) => {
    const nextRecent = pushRecentEmoji(recent, emoji);
    setRecent(nextRecent);
    saveRecent(nextRecent);
    onSelect(emoji);
    onClose();
  };

  const activeCategoryMeta = EMOJI_CATEGORIES.find((category) => category.id === activeCategory);
  const content = (
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-label={t("emojiPicker.title", "选择 Emoji 图标")}
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -4 }}
      transition={{ duration: 0.14 }}
      className="fixed z-[140] flex w-[352px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-2xl border border-app-border bg-app-elevated shadow-2xl"
      style={{ top: adjustedPosition.top, left: adjustedPosition.left, maxHeight }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-app-border/70 px-3 py-2.5">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("emojiPicker.searchPlaceholder", "搜索 Emoji，如：文件夹、猫、rocket")}
            aria-label={t("emojiPicker.search", "搜索 Emoji")}
            className="h-8 w-full rounded-lg border border-app-border bg-app-surface pl-8 pr-8 text-xs text-tx-primary outline-none transition focus:border-accent-primary/60 focus:ring-2 focus:ring-accent-primary/10"
          />
          <AnimatePresence>
            {query && (
              <motion.button
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                aria-label={t("common.clear", "清空")}
              >
                <X size={12} />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-tx-tertiary transition hover:bg-app-hover hover:text-tx-primary"
          aria-label={t("common.close", "关闭")}
        >
          <X size={15} />
        </button>
      </div>

      {!query.trim() && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-app-border/60 px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            onClick={() => setActiveCategory("recent")}
            disabled={recent.length === 0}
            title={t("emojiPicker.recent", "最近使用")}
            aria-label={t("emojiPicker.recent", "最近使用")}
            className={cn(
              "flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm transition",
              activeCategory === "recent"
                ? "bg-accent-primary/12 text-accent-primary ring-1 ring-accent-primary/20"
                : "text-tx-secondary hover:bg-app-hover",
              recent.length === 0 && "cursor-not-allowed opacity-35",
            )}
          >
            <Clock3 size={15} />
          </button>
          {EMOJI_CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              onClick={() => setActiveCategory(category.id)}
              title={t(category.labelKey, category.fallbackLabel)}
              aria-label={t(category.labelKey, category.fallbackLabel)}
              className={cn(
                "flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-base transition",
                activeCategory === category.id
                  ? "bg-accent-primary/12 ring-1 ring-accent-primary/20"
                  : "hover:bg-app-hover",
              )}
            >
              {category.icon}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[11px] font-medium text-tx-secondary">
            {query.trim()
              ? t("emojiPicker.searchResults", "搜索结果")
              : activeCategory === "recent"
                ? t("emojiPicker.recent", "最近使用")
                : t(activeCategoryMeta?.labelKey || "emojiPicker.all", activeCategoryMeta?.fallbackLabel || "Emoji")}
          </span>
          <span className="text-[10px] tabular-nums text-tx-tertiary">{activeEmojis.length}</span>
        </div>

        {activeEmojis.length > 0 ? (
          <div className="grid grid-cols-8 gap-1">
            {activeEmojis.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => handleSelect(emoji)}
                title={emoji}
                aria-label={emoji}
                className={cn(
                  "flex aspect-square min-h-9 items-center justify-center rounded-lg text-xl leading-none transition hover:scale-110 hover:bg-app-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50",
                  currentIcon === emoji && "bg-accent-primary/15 ring-1 ring-accent-primary/35",
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-4 text-center text-tx-tertiary">
            <span className="text-3xl">🔎</span>
            <p className="text-xs">{t("emojiPicker.noResults", "没有找到匹配的 Emoji")}</p>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-app-border/60 px-3 py-2 text-[10px] text-tx-tertiary">
        {t("emojiPicker.hint", "选择后会自动保存；最近使用仅保存在当前设备")}
      </div>
    </motion.div>
  );

  return typeof document === "undefined" ? content : createPortal(content, document.body);
}

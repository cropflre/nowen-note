import React, { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  Trash2,
  Loader2,
  ChevronDown,
  Smile,
  MessageCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { Diary, DiaryStats } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";

// 心情选项
const MOODS = [
  { value: "happy", emoji: "😊" },
  { value: "excited", emoji: "🥳" },
  { value: "peaceful", emoji: "😌" },
  { value: "thinking", emoji: "🤔" },
  { value: "tired", emoji: "😴" },
  { value: "sad", emoji: "😢" },
  { value: "angry", emoji: "😤" },
  { value: "sick", emoji: "🤒" },
  { value: "love", emoji: "🥰" },
  { value: "cool", emoji: "😎" },
  { value: "laugh", emoji: "🤣" },
  { value: "shock", emoji: "😱" },
];

function getMoodEmoji(mood: string): string {
  return MOODS.find((m) => m.value === mood)?.emoji || "";
}

// 相对时间显示
function timeAgo(dateStr: string, t: (key: string) => string): string {
  const now = new Date();
  const date = new Date(dateStr.replace(" ", "T") + "Z");
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return t("diary.justNow");
  if (diffMin < 60) return t("diary.minutesAgo").replace("{{n}}", String(diffMin));
  if (diffHour < 24) return t("diary.hoursAgo").replace("{{n}}", String(diffHour));
  if (diffDay < 7) return t("diary.daysAgo").replace("{{n}}", String(diffDay));

  // 超过 7 天显示具体日期
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  if (y === now.getFullYear()) return `${m}-${d} ${h}:${min}`;
  return `${y}-${m}-${d} ${h}:${min}`;
}

// ============================================================
// 发布框
// ============================================================
function ComposeBox({ onPost }: { onPost: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [mood, setMood] = useState("");
  const [showMoods, setShowMoods] = useState(false);
  const [posting, setPosting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const moodRef = useRef<HTMLDivElement>(null);

  // 自动调整 textarea 高度
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, []);

  // 点击外部关闭心情选择器
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moodRef.current && !moodRef.current.contains(e.target as Node)) {
        setShowMoods(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handlePost = async () => {
    if (!text.trim() || posting) return;
    setPosting(true);
    try {
      await api.postDiary({ contentText: text.trim(), mood });
      setText("");
      setMood("");
      setShowMoods(false);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      onPost();
    } catch (e) {
      console.error("Post failed:", e);
    } finally {
      setPosting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl/Cmd + Enter 发布
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handlePost();
    }
  };

  const selectedMoodEmoji = getMoodEmoji(mood);

  return (
    <div className="bg-app-surface/60 backdrop-blur-sm rounded-2xl border border-app-border shadow-sm">
      {/* 输入区域 */}
      <div className="p-4 pb-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); autoResize(); }}
          onKeyDown={handleKeyDown}
          placeholder={t("diary.placeholder")}
          rows={2}
          className="w-full bg-transparent text-tx-primary placeholder:text-tx-tertiary text-sm leading-relaxed resize-none outline-none min-h-[52px]"
        />
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-between px-4 pb-3">
        <div className="flex items-center gap-1">
          {/* 心情按钮 */}
          <div ref={moodRef} className="relative">
            <button
              onClick={() => setShowMoods(!showMoods)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
                mood
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover"
              )}
            >
              {selectedMoodEmoji ? (
                <span className="text-sm">{selectedMoodEmoji}</span>
              ) : (
                <Smile size={15} />
              )}
              <span className="hidden sm:inline">
                {mood ? t(`diary.mood${mood.charAt(0).toUpperCase() + mood.slice(1)}`) : t("diary.mood")}
              </span>
            </button>

            {/* 心情弹出面板 */}
            <AnimatePresence>
              {showMoods && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: -4 }}
                  transition={{ duration: 0.15 }}
                  className="absolute top-full left-0 mt-2 p-2.5 bg-app-elevated rounded-xl border border-app-border shadow-lg z-20 w-[220px]"
                >
                  <div className="grid grid-cols-6 gap-1.5">
                    {MOODS.map(({ value: v, emoji }) => (
                      <button
                        key={v}
                        onClick={() => { setMood(mood === v ? "" : v); setShowMoods(false); }}
                        className={cn(
                          "w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-base transition-all",
                          mood === v
                            ? "bg-accent-primary/15 scale-110 ring-1 ring-accent-primary/30"
                            : "hover:bg-app-hover hover:scale-110"
                        )}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* 字数计数 */}
          <span className={cn(
            "text-[11px] tabular-nums transition-colors",
            text.length > 500 ? "text-red-400" : "text-tx-tertiary"
          )}>
            {text.length > 0 && text.length}
          </span>

          {/* 发布按钮 */}
          <button
            onClick={handlePost}
            disabled={!text.trim() || posting}
            className={cn(
              "flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium transition-all",
              text.trim()
                ? "bg-accent-primary text-white hover:bg-accent-primary/90 shadow-sm shadow-accent-primary/20 active:scale-95"
                : "bg-app-hover text-tx-tertiary cursor-not-allowed"
            )}
          >
            {posting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Send size={13} />
            )}
            <span>{t("diary.post")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 单条说说卡片
// ============================================================
function DiaryCard({
  item,
  onDelete,
}: {
  item: Diary;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [showConfirm, setShowConfirm] = useState(false);
  const moodEmoji = getMoodEmoji(item.mood);

  const handleDelete = () => {
    if (!showConfirm) {
      setShowConfirm(true);
      setTimeout(() => setShowConfirm(false), 3000); // 3 秒后自动取消
      return;
    }
    onDelete(item.id);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8, transition: { duration: 0.2 } }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="group"
    >
      <div className="bg-app-surface/40 backdrop-blur-sm rounded-2xl border border-app-border hover:border-app-border/80 transition-all duration-200 hover:shadow-sm">
        <div className="p-4">
          {/* 内容 */}
          <p className="text-sm text-tx-primary leading-relaxed whitespace-pre-wrap break-words">
            {item.contentText}
          </p>

          {/* 底部元信息 */}
          <div className="flex items-center justify-between mt-3 pt-2 border-t border-app-border/40">
            <div className="flex items-center gap-2 text-[11px] text-tx-tertiary">
              {moodEmoji && <span className="text-sm">{moodEmoji}</span>}
              <span>{timeAgo(item.createdAt, t)}</span>
            </div>

            {/* 删除按钮 */}
            <button
              onClick={handleDelete}
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] transition-all",
                showConfirm
                  ? "bg-red-500/10 text-red-500"
                  : "opacity-100 md:opacity-0 md:group-hover:opacity-100 text-tx-tertiary hover:text-red-400 hover:bg-red-500/5"
              )}
            >
              <Trash2 size={12} />
              <span>{showConfirm ? t("diary.confirmDelete") : t("diary.delete")}</span>
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================
// 主组件：DiaryCenter
// ============================================================
export default function DiaryCenter() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Diary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<DiaryStats | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 加载时间线
  const loadTimeline = useCallback(async (reset = false) => {
    if (reset) setLoading(true);
    else setLoadingMore(true);

    try {
      const cursor = reset ? undefined : (nextCursor || undefined);
      const data = await api.getDiaryTimeline(cursor, 20);
      if (reset) {
        setItems(data.items);
      } else {
        setItems((prev) => [...prev, ...data.items]);
      }
      setHasMore(data.hasMore);
      setNextCursor(data.nextCursor);
    } catch (e) {
      console.error("Load timeline failed:", e);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [nextCursor]);

  // 加载统计
  const loadStats = useCallback(async () => {
    try {
      const s = await api.getDiaryStats();
      setStats(s);
    } catch { /* ignore */ }
  }, []);

  // 初始化
  useEffect(() => {
    loadTimeline(true);
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 发布后刷新
  const handlePost = useCallback(() => {
    setNextCursor(null);
    loadTimeline(true);
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 删除
  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.deleteDiary(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
      loadStats();
    } catch (e) {
      console.error("Delete failed:", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 按日期分组
  const groupedItems = groupByDate(items, t);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-app-bg">
      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="max-w-[640px] mx-auto px-4 py-6 space-y-6">
          {/* 顶部标题 + 统计 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-pink-500 flex items-center justify-center">
                <MessageCircle size={18} className="text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-tx-primary leading-tight">{t("diary.title")}</h1>
                {stats && (
                  <p className="text-[11px] text-tx-tertiary mt-0.5">
                    {t("diary.statsLine")
                      .replace("{{total}}", String(stats.total))
                      .replace("{{today}}", String(stats.todayCount))}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* 发布框 */}
          <ComposeBox onPost={handlePost} />

          {/* 时间线 */}
          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 size={24} className="animate-spin text-accent-primary" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center py-20 text-center">
              <div className="w-16 h-16 rounded-2xl bg-app-hover/60 flex items-center justify-center mb-4">
                <MessageCircle size={28} className="text-tx-tertiary" />
              </div>
              <p className="text-sm text-tx-secondary font-medium">{t("diary.empty")}</p>
              <p className="text-xs text-tx-tertiary mt-1">{t("diary.emptyHint")}</p>
            </div>
          ) : (
            <div className="space-y-5">
              {groupedItems.map(({ label, items: dayItems }) => (
                <div key={label}>
                  {/* 日期分割 */}
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-[11px] font-medium text-tx-tertiary bg-app-hover/60 px-2.5 py-1 rounded-full">
                      {label}
                    </span>
                    <div className="flex-1 h-px bg-app-border/50" />
                  </div>

                  {/* 当天动态 */}
                  <div className="space-y-3">
                    <AnimatePresence mode="popLayout">
                      {dayItems.map((item) => (
                        <DiaryCard key={item.id} item={item} onDelete={handleDelete} />
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              ))}

              {/* 加载更多 */}
              {hasMore && (
                <div className="flex justify-center pt-2 pb-4">
                  <button
                    onClick={() => loadTimeline(false)}
                    disabled={loadingMore}
                    className="flex items-center gap-1.5 px-5 py-2 rounded-full text-xs font-medium text-tx-secondary bg-app-hover/60 hover:bg-app-hover transition-colors"
                  >
                    {loadingMore ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                    <span>{loadingMore ? t("diary.loadingMore") : t("diary.loadMore")}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ============================================================
// 辅助：按日期分组
// ============================================================
function groupByDate(
  items: Diary[],
  t: (key: string) => string
): { label: string; items: Diary[] }[] {
  const groups: Map<string, Diary[]> = new Map();
  const today = new Date();
  const todayStr = formatDateKey(today);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = formatDateKey(yesterday);

  for (const item of items) {
    const date = new Date(item.createdAt.replace(" ", "T") + "Z");
    const key = formatDateKey(date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  return Array.from(groups.entries()).map(([key, dayItems]) => {
    let label = key;
    if (key === todayStr) label = t("diary.today");
    else if (key === yesterdayStr) label = t("diary.yesterday");
    return { label, items: dayItems };
  });
}

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

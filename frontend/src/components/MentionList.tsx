/**
 * @消息列表（MentionList）
 * ---------------------------------------------------------------------------
 * 在 viewMode === "mentions" 时显示，展示当前用户被 @ 的所有消息。
 * 支持：
 *   - 分页加载（滚动到底部加载更多）
 *   - 点击单条标记已读 + 跳转源内容（带权限校验）
 *   - 全部已读
 *   - 未读蓝色左边框标记
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Bell,
  CheckCheck,
  MessageCircle,
  FileText,
  CheckSquare,
  Loader2,
  ChevronDown,
  ExternalLink,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { useApp, useAppActions } from "@/store/AppContext";
import type { MentionItem } from "@/types";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";

// 来源类型 → 图标映射
function SourceIcon({ type }: { type: string }) {
  switch (type) {
    case "diary":
      return <MessageCircle size={14} />;
    case "note":
      return <FileText size={14} />;
    case "task":
      return <CheckSquare size={14} />;
    default:
      return <Bell size={14} />;
  }
}

// 相对时间
function relativeTime(dateStr: string, t: (key: string) => string): string {
  const now = Date.now();
  const date = new Date(dateStr.replace(" ", "T") + "Z").getTime();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t("diary.justNow") || "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}天前`;
  return dateStr.slice(0, 10);
}

// 来源类型 → 中文名
function sourceLabel(type: string): string {
  switch (type) {
    case "diary": return "说说";
    case "note": return "笔记";
    case "task": return "任务";
    default: return "";
  }
}

export default function MentionList() {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();
  const [items, setItems] = useState<MentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadMentions = useCallback(async (reset = false) => {
    if (reset) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    try {
      const cursor = reset ? undefined : nextCursor || undefined;
      const data = await api.mentions.list(cursor);
      if (reset) {
        setItems(data.items);
      } else {
        setItems((prev) => [...prev, ...data.items]);
      }
      setHasMore(data.hasMore);
      setNextCursor(data.nextCursor);
    } catch (e) {
      console.error("Load mentions failed:", e);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [nextCursor]);

  useEffect(() => {
    loadMentions(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 标记已读 + 跳转
  const handleClick = useCallback(async (item: MentionItem) => {
    if (!item.readAt) {
      try {
        await api.mentions.markRead(item.id);
        setItems((prev) =>
          prev.map((m) => (m.id === item.id ? { ...m, readAt: new Date().toISOString() } : m)),
        );
        actions.setUnreadMentionCount(Math.max(0, (state.unreadMentionCount || 1) - 1));
      } catch {}
    }

    // 尝试跳转（若 API 调用失败，说明无权限或已删除，走 catch 提示）
    try {
      switch (item.sourceType) {
        case "note":
          await api.getNote(item.sourceId); // 权限验证
          actions.setViewMode("all");
          window.dispatchEvent(new CustomEvent("nowen:open-note", { detail: item.sourceId }));
          break;
        case "diary":
          actions.setViewMode("diary");
          break;
        case "task":
          await api.getTask(item.sourceId); // 权限验证
          actions.setViewMode("tasks");
          break;
      }
    } catch {
      toast.error("暂无权限查看该内容");
    }
  }, [state.unreadMentionCount, actions]);

  // 全部已读
  const handleMarkAllRead = useCallback(async () => {
    try {
      await api.mentions.markAllRead();
      setItems((prev) => prev.map((m) => ({ ...m, readAt: m.readAt || new Date().toISOString() })));
      actions.setUnreadMentionCount(0);
      toast.success("全部已读");
    } catch {
      toast.error("操作失败");
    }
  }, [actions]);

  // 初始加载时刷新未读数
  useEffect(() => {
    actions.refreshMentionCount();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const unreadCount = items.filter((m) => !m.readAt).length;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-app-bg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
        <div className="flex items-center gap-2">
          <Bell size={16} className="text-accent-primary" />
          <span className="text-sm font-bold text-tx-primary">消息盒子</span>
          {state.unreadMentionCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500 text-white font-bold">
              {state.unreadMentionCount}
            </span>
          )}
        </div>
        {unreadCount > 0 && (
          <button
            onClick={handleMarkAllRead}
            className="flex items-center gap-1 text-[11px] text-accent-primary hover:underline font-medium"
          >
            <CheckCheck size={12} />
            全部已读
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 size={20} className="animate-spin text-accent-primary" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-center">
            <div className="w-12 h-12 rounded-2xl bg-app-hover/60 flex items-center justify-center mb-3">
              <Bell size={22} className="text-tx-tertiary" />
            </div>
            <p className="text-sm text-tx-secondary font-medium">暂无消息</p>
            <p className="text-xs text-tx-tertiary mt-1">当有人 @你 时，消息会显示在这里</p>
          </div>
        ) : (
          <div className="divide-y divide-app-border/50">
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => handleClick(item)}
                className={cn(
                  "w-full text-left px-4 py-3 transition-colors hover:bg-app-hover/50 flex items-start gap-3",
                  !item.readAt && "bg-accent-primary/[0.02]",
                )}
              >
                {/* 未读标记 */}
                <div className="pt-1 shrink-0">
                  {!item.readAt ? (
                    <div className="w-2 h-2 rounded-full bg-accent-primary" />
                  ) : (
                    <div className="w-2 h-2" />
                  )}
                </div>

                {/* 头像 */}
                <div className="w-7 h-7 rounded-full bg-app-hover flex items-center justify-center text-[10px] font-medium text-tx-secondary overflow-hidden shrink-0">
                  {item.mentionedBy.avatarUrl ? (
                    <img src={item.mentionedBy.avatarUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    (item.mentionedBy.displayName || item.mentionedBy.username)[0]
                  )}
                </div>

                {/* 内容 */}
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-tx-primary leading-relaxed">
                    <span className="font-semibold">
                      {item.mentionedBy.displayName || item.mentionedBy.username}
                    </span>
                    <span className="text-tx-tertiary"> 在</span>{" "}
                    <span className="inline-flex items-center gap-1 text-accent-primary px-1.5 py-0.5 rounded bg-accent-primary/5 text-[10px] font-medium">
                      <SourceIcon type={item.sourceType} />
                      {sourceLabel(item.sourceType)}
                    </span>{" "}
                    <span className="text-tx-tertiary">中 @了你</span>
                  </div>
                  {item.sourceTitle && (
                    <p className="text-[11px] text-tx-tertiary mt-0.5 truncate">
                      {item.sourceTitle}
                    </p>
                  )}
                  <p className="text-[10px] text-tx-tertiary/60 mt-1">
                    {relativeTime(item.createdAt, t)}
                  </p>
                </div>

                <ExternalLink size={12} className="text-tx-tertiary/40 mt-1 shrink-0" />
              </button>
            ))}

            {/* 加载更多 */}
            {hasMore && (
              <div className="flex justify-center py-3">
                <button
                  onClick={() => loadMentions(false)}
                  disabled={loadingMore}
                  className="flex items-center gap-1 text-xs text-tx-tertiary hover:text-tx-secondary transition-colors"
                >
                  {loadingMore ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                  <span>加载更多</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

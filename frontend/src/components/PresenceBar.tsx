/**
 * Phase 2: 协作状态栏
 *
 * 两个 UI 元素：
 *   1. PresenceBar：右上角头像条，显示"x 人在看"+ 正在编辑者徽标
 *   2. RemoteUpdateBanner：顶部横幅，提示"xx 更新了笔记"[重新加载]
 *
 * 都是纯展示组件，状态由 EditorPane 统一管理。
 */
import { useMemo } from "react";
import { Pencil, Users, RefreshCw, Trash2 } from "lucide-react";
import type { PresenceUser } from "@/hooks/useRealtimeNote";
import { cn } from "@/lib/utils";

// --------------------- Presence Avatars ---------------------

function stringToHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h) % 360;
}

function UserAvatar({
  user,
  size = 24,
}: {
  user: PresenceUser;
  size?: number;
}) {
  const hue = useMemo(() => stringToHue(user.userId || user.username), [user.userId, user.username]);
  const initials = (user.username || "?").slice(0, 2).toUpperCase();
  return (
    <div
      className={cn(
        "relative shrink-0 rounded-full flex items-center justify-center text-[10px] font-semibold text-white border-2 border-app-surface",
        user.editing && "ring-2 ring-amber-400 ring-offset-1 ring-offset-app-surface",
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: `hsl(${hue}, 55%, 50%)`,
      }}
      title={user.editing ? `${user.username}（正在编辑）` : user.username}
    >
      {initials}
      {user.editing && (
        <span className="absolute -right-0.5 -bottom-0.5 w-3 h-3 rounded-full bg-amber-400 border border-app-surface flex items-center justify-center">
          <Pencil size={7} className="text-white" strokeWidth={3} />
        </span>
      )}
    </div>
  );
}

export function PresenceBar({
  users,
  isConnected,
  maxVisible = 3,
}: {
  users: PresenceUser[];
  isConnected: boolean;
  maxVisible?: number;
}) {
  // 去重：同一 userId 的多个连接（多标签页）只显示一个
  const unique = useMemo(() => {
    const seen = new Map<string, PresenceUser>();
    for (const u of users) {
      const prev = seen.get(u.userId);
      if (!prev || (u.editing && !prev.editing)) seen.set(u.userId, u);
    }
    return Array.from(seen.values());
  }, [users]);

  if (unique.length === 0) {
    // 仅显示连接状态小点（未连接时）
    if (!isConnected) {
      return (
        <div
          className="flex items-center gap-1 px-1.5 text-[10px] text-tx-tertiary"
          title="实时协作未连接"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-tx-tertiary/40" />
          <span className="hidden md:inline">离线</span>
        </div>
      );
    }
    return null;
  }

  const visible = unique.slice(0, maxVisible);
  const overflow = unique.length - visible.length;
  return (
    <div
      className="flex items-center gap-1 px-1.5"
      title={`${unique.length} 人同时在看此笔记`}
    >
      <Users size={12} className="text-tx-tertiary" />
      <div className="flex -space-x-1.5">
        {visible.map((u) => (
          <UserAvatar key={u.connectionId || u.userId} user={u} />
        ))}
        {overflow > 0 && (
          <div
            className="shrink-0 rounded-full flex items-center justify-center text-[10px] font-semibold bg-app-hover text-tx-secondary border-2 border-app-surface"
            style={{ width: 24, height: 24 }}
            title={`还有 ${overflow} 人`}
          >
            +{overflow}
          </div>
        )}
      </div>
    </div>
  );
}

// --------------------- Editing Lock Banner ---------------------

export function EditingLockBanner({
  users,
}: {
  users: PresenceUser[];
}) {
  const editors = users.filter((u) => u.editing);
  if (editors.length === 0) return null;
  // 多标签页去重
  const uniqueNames = Array.from(new Set(editors.map((u) => u.username)));
  const label = uniqueNames.length === 1
    ? `${uniqueNames[0]} 正在编辑此笔记`
    : `${uniqueNames.slice(0, 2).join("、")} 等 ${uniqueNames.length} 人正在编辑此笔记`;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800/50 text-xs text-amber-700 dark:text-amber-300">
      <Pencil size={12} />
      <span className="truncate">{label}</span>
      <span className="ml-auto text-[10px] text-amber-600/70 dark:text-amber-400/60 shrink-0">
        你的更改仍会保存，冲突时将提示
      </span>
    </div>
  );
}

// --------------------- Remote Update Banner ---------------------

export function RemoteUpdateBanner({
  actorName,
  onReload,
  onDismiss,
}: {
  actorName?: string;
  onReload: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800/50 text-xs text-blue-700 dark:text-blue-300">
      <RefreshCw size={12} />
      <span className="truncate">
        {actorName ? `${actorName} 更新了此笔记` : "此笔记已被他人更新"}
        ，建议重新加载以获取最新内容
      </span>
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <button
          onClick={onReload}
          className="px-2 py-0.5 rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors text-[11px]"
        >
          重新加载
        </button>
        <button
          onClick={onDismiss}
          className="px-1.5 py-0.5 rounded text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-800/30 transition-colors text-[11px]"
        >
          忽略
        </button>
      </div>
    </div>
  );
}

// --------------------- Remote Delete Banner ---------------------

export function RemoteDeleteBanner({
  actorName,
  trashed,
  onDismiss,
}: {
  actorName?: string;
  trashed?: boolean;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800/50 text-xs text-red-700 dark:text-red-300">
      <Trash2 size={12} />
      <span className="truncate">
        {actorName ? `${actorName} ` : ""}
        {trashed ? "已将此笔记放入回收站" : "已永久删除此笔记"}
      </span>
      <button
        onClick={onDismiss}
        className="ml-auto shrink-0 px-1.5 py-0.5 rounded text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-800/30 transition-colors text-[11px]"
      >
        关闭
      </button>
    </div>
  );
}

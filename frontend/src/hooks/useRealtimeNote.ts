/**
 * Phase 2: 笔记级实时协作 Hook
 *
 * 职责：
 *   1. 订阅当前 noteId 对应的 WebSocket 房间
 *   2. 汇总 Presence（别人在看/编辑）
 *   3. 暴露"远程更新"事件，让 EditorPane 决定是静默拉取还是提示用户
 *   4. 提供 setEditing() 给编辑器：进入/退出编辑态时软锁广播
 *
 * 消费约定：
 *   - presenceUsers：不包含自己；按 editing > 在看 > userId 排序
 *   - isSomeoneEditing：除自己外是否有人正在编辑（软锁提示）
 *   - onRemoteUpdate：注册一个回调，当房间内有 note:updated 且不是自己触发时触发
 *   - onRemoteDelete：同上，当笔记被删除时触发
 */
import { useEffect, useState, useRef, useCallback } from "react";
import { realtime } from "@/lib/realtime";
import { api } from "@/lib/api";

const SELF_USERID_CACHE_KEY = "nowen-self-userid";

/** 取当前登录用户 id（带缓存），用于从 presence 中过滤自己 */
function useSelfUserId(): string | null {
  const [userId, setUserId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SELF_USERID_CACHE_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (userId) return;
    let cancelled = false;
    api
      .getMe()
      .then((me: any) => {
        if (cancelled) return;
        if (me?.id) {
          try { localStorage.setItem(SELF_USERID_CACHE_KEY, me.id); } catch {}
          setUserId(me.id);
        }
      })
      .catch(() => {
        /* 静默失败，offline/未登录场景 */
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return userId;
}

export interface PresenceUser {
  userId: string;
  username: string;
  connectionId: string;
  editing: boolean;
}

export interface UseRealtimeNoteOptions {
  /** 笔记 ID，null 表示未聚焦（会解除订阅） */
  noteId: string | null;
  /**
   * 当前登录用户的 userId，用于从 presence 中过滤自己。
   * 若不传则 hook 会自动通过 /api/me 拉取（有 localStorage 缓存）
   */
  selfUserId?: string | null;
  /** 收到远程更新事件（仅别人触发）—— 返回闭包捕获 actorUserId/version */
  onRemoteUpdate?: (payload: {
    noteId: string;
    version: number;
    updatedAt: string;
    title?: string;
    contentText?: string;
    actorUserId?: string;
  }) => void;
  /** 收到远程删除（放入回收站或永久删除） */
  onRemoteDelete?: (payload: {
    noteId: string;
    actorUserId?: string;
    trashed?: boolean;
  }) => void;
}

export function useRealtimeNote({
  noteId,
  selfUserId: externalSelfUserId,
  onRemoteUpdate,
  onRemoteDelete,
}: UseRealtimeNoteOptions) {
  const fallbackSelf = useSelfUserId();
  const selfUserId = externalSelfUserId ?? fallbackSelf;

  const [presenceUsers, setPresenceUsers] = useState<PresenceUser[]>([]);
  const [isConnected, setIsConnected] = useState<boolean>(realtime.isOpen());

  // 用 ref 维持最新回调引用，避免 useEffect 因回调变化而反复订阅
  const onRemoteUpdateRef = useRef(onRemoteUpdate);
  const onRemoteDeleteRef = useRef(onRemoteDelete);
  onRemoteUpdateRef.current = onRemoteUpdate;
  onRemoteDeleteRef.current = onRemoteDelete;

  // 连接管理
  useEffect(() => {
    realtime.connect();
    const offOpen = realtime.on("open", () => setIsConnected(true));
    const offClose = realtime.on("close", () => setIsConnected(false));
    return () => {
      offOpen();
      offClose();
    };
  }, []);

  // 房间订阅 + Presence + 消息分发
  useEffect(() => {
    if (!noteId) {
      // 离开房间
      realtime.setPresence(null, false);
      setPresenceUsers([]);
      return;
    }

    const room = `note:${noteId}`;
    realtime.subscribe(room);
    // 进入房间：先声明"在看但未编辑"，编辑器真正 focus 时再 setEditing(true)
    realtime.setPresence(noteId, false);

    const offPresence = realtime.on("presence", (msg: any) => {
      if (msg.noteId !== noteId) return;
      // cursorUpdate 是轻量事件，不重写 users 列表（Phase 2 先忽略 cursor UI）
      if (msg.cursorUpdate) return;
      const users: PresenceUser[] = Array.isArray(msg.users) ? msg.users : [];
      // 过滤掉自己（按 userId；若同一用户多标签页都算作"自己"，避免 UI 里出现"你自己"）
      const filtered = selfUserId ? users.filter((u) => u.userId !== selfUserId) : users;
      // 排序：editing 优先
      filtered.sort((a, b) => {
        if (a.editing !== b.editing) return a.editing ? -1 : 1;
        return a.username.localeCompare(b.username);
      });
      setPresenceUsers(filtered);
    });

    const offUpdate = realtime.on("note:updated", (msg: any) => {
      if (msg.noteId !== noteId) return;
      // 排除自己触发的回声：actorUserId 与 selfUserId 相同时跳过
      if (selfUserId && msg.actorUserId === selfUserId) return;
      onRemoteUpdateRef.current?.(msg);
    });

    const offDelete = realtime.on("note:deleted", (msg: any) => {
      if (msg.noteId !== noteId) return;
      if (selfUserId && msg.actorUserId === selfUserId) return;
      onRemoteDeleteRef.current?.(msg);
    });

    return () => {
      offPresence();
      offUpdate();
      offDelete();
      realtime.unsubscribe(room);
      // Presence：若仍停留在其他笔记上，后续 effect 会重新设置；
      // 切到空时显式清掉
      realtime.setPresence(null, false);
      setPresenceUsers([]);
    };
  }, [noteId, selfUserId]);

  /** 编辑器 focus/blur 时调用，广播软锁 */
  const setEditing = useCallback(
    (editing: boolean) => {
      if (!noteId) return;
      realtime.setEditing(noteId, editing);
    },
    [noteId],
  );

  const isSomeoneEditing = presenceUsers.some((u) => u.editing);

  return {
    presenceUsers,
    isConnected,
    isSomeoneEditing,
    setEditing,
  };
}

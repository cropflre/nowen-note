/**
 * 通知状态管理（Zustand）
 * ---------------------------------------------------------------------------
 * 管理 @提及、工作区动态等通知的未读数。
 *
 * 使用方式：
 *   import { useNotificationStore } from "@/store/notificationStore";
 *   const unreadCount = useNotificationStore((s) => s.unreadCount);
 *   useNotificationStore.getState().refresh();
 */

import { create } from "zustand";
import { api } from "@/lib/api";

export interface NotificationState {
  unreadCount: number;
  setUnreadCount: (count: number) => void;
  refresh: () => Promise<void>;
}

export const useNotificationStore = create<NotificationState>()((set) => ({
  unreadCount: 0,
  setUnreadCount: (count) => set({ unreadCount: count }),
  refresh: async () => {
    try {
      const res = await api.mentions!.unreadCount();
      set({ unreadCount: res.count });
    } catch {
      // 静默失败
    }
  },
}));

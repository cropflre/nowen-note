/**
 * FolderSyncScheduler — 应用运行期间的自动定时同步
 *
 * 只在 Electron 桌面端运行。
 * 定期检查 enabled + intervalMinutes > 0 的配置，到期时执行同步。
 * 安全策略：
 *   - 未登录不运行
 *   - document.hidden 时跳过本轮
 *   - 失败后 5 分钟冷却
 *   - 全局最多 1 个并发同步
 *   - 自动同步不弹 toast
 */

import { useEffect, useRef } from "react";
import { runFolderSyncOnce } from "@/lib/folderSyncRunner";
import type { FolderSyncConfig } from "@/lib/desktopBridge";

const CHECK_INTERVAL_MS = 60_000; // 每分钟检查一次
const COOLDOWN_MS = 5 * 60_000;  // 失败后冷却 5 分钟
const INITIAL_DELAY_MS = 30_000;  // 启动后延迟 30 秒

const runningFolderIds = new Set<string>();
const lastFailureTime = new Map<string, number>();

function getFolderSync() {
  return (window as any).nowenDesktop?.folderSync as import("@/lib/desktopBridge").FolderSyncAPI | undefined;
}

function isDesktop(): boolean {
  return !!(window as any).nowenDesktop?.isDesktop;
}

/** 检查用户是否已登录（localStorage 有 token） */
function isLoggedIn(): boolean {
  try {
    return !!localStorage.getItem("nowen-token");
  } catch {
    return false;
  }
}

export default function FolderSyncScheduler() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isDesktop() || !getFolderSync()) return;

    const checkAndSync = async () => {
      // 未登录不运行
      if (!isLoggedIn()) return;

      // 页面隐藏时跳过（休眠恢复后不会连跑多轮）
      if (document.hidden) return;

      const fs = getFolderSync();
      if (!fs) return;

      let configs: FolderSyncConfig[];
      try {
        configs = await fs.getConfigs();
      } catch {
        return;
      }

      const now = Date.now();

      for (const config of configs) {
        // 跳过：未启用、无间隔、无目标笔记本、正在运行
        if (!config.enabled) continue;
        if (!config.intervalMinutes || config.intervalMinutes <= 0) continue;
        if (!config.targetNotebookId) continue;
        if (runningFolderIds.has(config.folderId)) continue;

        // 冷却：失败后 5 分钟内不重试
        const lastFail = lastFailureTime.get(config.folderId) || 0;
        if (now - lastFail < COOLDOWN_MS) continue;

        // 判断是否到期
        const lastSync = config.lastSyncedAt || config.lastScanAt || config.createdAt;
        const lastSyncMs = lastSync ? new Date(lastSync).getTime() : 0;
        const intervalMs = config.intervalMinutes * 60_000;
        if (now - lastSyncMs < intervalMs) continue;

        // 到期，执行同步
        runningFolderIds.add(config.folderId);
        try {
          const result = await runFolderSyncOnce(config.folderId, { silent: true, reason: "auto" });
          if (!result.ok) {
            lastFailureTime.set(config.folderId, Date.now());
          }
        } catch (e) {
          console.warn("[FolderSyncScheduler] auto sync failed:", config.folderId, e);
          lastFailureTime.set(config.folderId, Date.now());
        } finally {
          runningFolderIds.delete(config.folderId);
        }

        // 一次只跑一个，避免并发
        break;
      }
    };

    // 启动后延迟首次检查
    const initialDelay = setTimeout(() => {
      checkAndSync();
      timerRef.current = setInterval(checkAndSync, CHECK_INTERVAL_MS);
    }, INITIAL_DELAY_MS);

    // 页面从隐藏变为可见时立即检查一次
    const onVisibilityChange = () => {
      if (!document.hidden) {
        checkAndSync();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearTimeout(initialDelay);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}

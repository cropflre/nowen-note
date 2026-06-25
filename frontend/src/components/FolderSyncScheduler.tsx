/**
 * FolderSyncScheduler — 应用运行期间的自动定时同步
 *
 * 只在 Electron 桌面端运行。
 * 定期检查 enabled + intervalMinutes > 0 的配置，到期时执行同步。
 * 复用 runFolderSyncOnce 逻辑。
 * 不存储 token 到 Electron，不启动系统后台服务。
 */

import { useEffect, useRef } from "react";
import { runFolderSyncOnce } from "@/lib/folderSyncRunner";
import type { FolderSyncConfig } from "@/lib/desktopBridge";

const CHECK_INTERVAL_MS = 60_000; // 每分钟检查一次是否到期
const runningFolderIds = new Set<string>();

function getFolderSync() {
  return (window as any).nowenDesktop?.folderSync as import("@/lib/desktopBridge").FolderSyncAPI | undefined;
}

function isDesktop(): boolean {
  return !!(window as any).nowenDesktop?.isDesktop;
}

export default function FolderSyncScheduler() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isDesktop() || !getFolderSync()) return;

    const checkAndSync = async () => {
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

        // 判断是否到期
        const lastSync = config.lastSyncedAt || config.lastScanAt || config.createdAt;
        const lastSyncMs = lastSync ? new Date(lastSync).getTime() : 0;
        const intervalMs = config.intervalMinutes * 60_000;
        if (now - lastSyncMs < intervalMs) continue;

        // 到期，执行同步
        runningFolderIds.add(config.folderId);
        try {
          await runFolderSyncOnce(config.folderId);
        } catch (e) {
          console.warn("[FolderSyncScheduler] auto sync failed:", config.folderId, e);
        } finally {
          runningFolderIds.delete(config.folderId);
        }

        // 一次只跑一个，避免并发
        break;
      }
    };

    // 启动后先等 30 秒再首次检查（让用户先登录稳定）
    const initialDelay = setTimeout(() => {
      checkAndSync();
      timerRef.current = setInterval(checkAndSync, CHECK_INTERVAL_MS);
    }, 30_000);

    return () => {
      clearTimeout(initialDelay);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // 这个组件不渲染任何 UI
  return null;
}

import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Clock3, LockKeyhole, Monitor, Smartphone } from "lucide-react";

import {
  useUserPreferences,
  type FolderAutoLockMinutes,
} from "@/hooks/useUserPreferences";
import {
  FOLDER_AUTO_LOCK_OPTIONS,
  FOLDER_BACKGROUND_LOCK_DELAY_MS,
} from "@/lib/knowledgeTreeAutoLock";
import {
  clearFolderUnlockTokens,
  KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT,
  loadUnlockedFolderIds,
} from "@/lib/knowledgeTreePassword";
import { toast } from "@/lib/toast";

export default function FolderAutoLockSettings() {
  const { prefs, setPref } = useUserPreferences();
  const [unlockedCount, setUnlockedCount] = useState(() => loadUnlockedFolderIds().size);

  useEffect(() => {
    const sync = () => setUnlockedCount(loadUnlockedFolderIds().size);
    window.addEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, sync);
    return () => window.removeEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, sync);
  }, []);

  const lockNow = () => {
    clearFolderUnlockTokens({ reason: "manual", broadcast: true });
    toast.success("已锁定所有密码文件夹");
  };

  return (
    <section
      id="security-folder-lock"
      className="max-w-2xl rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm transition-shadow hover:shadow-md"
    >
      <div className="mb-4 flex items-start gap-3">
        <motion.span
          whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
          transition={{ duration: 0.4 }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500/20 via-orange-400/18 to-rose-500/18 text-amber-600 ring-1 ring-amber-500/25 dark:text-amber-300"
        >
          <LockKeyhole className="h-5 w-5" />
        </motion.span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold tracking-tight text-tx-primary">密码文件夹自动锁定</h3>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
                unlockedCount > 0
                  ? "bg-amber-500/14 text-amber-700 dark:text-amber-300"
                  : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
              }`}
            >
              {unlockedCount > 0 ? `${unlockedCount} 个已解锁` : "全部已上锁"}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-tx-secondary">
            该设置跟随账号同步，在 Web、桌面端和手机端使用相同策略。服务端解锁令牌仍保留 12 小时绝对有效期上限。
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <label className="block rounded-xl border border-app-border/75 bg-app-surface/90 p-3.5 transition-colors hover:border-amber-400/35">
          <span className="flex items-center gap-2 text-xs font-semibold text-tx-primary">
            <Clock3 size={14} className="text-amber-500 dark:text-amber-400" />
            闲置多久后自动锁定
          </span>
          <select
            value={prefs.folderAutoLockMinutes}
            onChange={(event) => setPref(
              "folderAutoLockMinutes",
              Number(event.target.value) as FolderAutoLockMinutes,
            )}
            className="mt-2 w-full cursor-pointer rounded-xl border border-app-border/80 bg-app-bg px-3 py-2 text-sm text-tx-primary outline-none transition-all focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/15"
          >
            {FOLDER_AUTO_LOCK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span className="mt-2 block text-[11px] leading-5 text-tx-tertiary">
            鼠标、键盘、触摸和滚动会重新计时；正在编辑时不会因持续操作而突然锁定。
          </span>
        </label>

        <button
          type="button"
          role="switch"
          aria-checked={prefs.folderLockOnBackground}
          onClick={() => setPref("folderLockOnBackground", !prefs.folderLockOnBackground)}
          className="flex w-full items-center justify-between gap-4 rounded-xl border border-app-border/75 bg-app-surface/90 p-3.5 text-left transition-all hover:border-amber-400/35 active:scale-[0.995]"
        >
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-xs font-semibold text-tx-primary">
              <Monitor size={14} className="text-sky-500 dark:text-sky-400" />
              <Smartphone size={13} className="text-violet-500 dark:text-violet-400" />
              切到后台后自动锁定
            </span>
            <span className="mt-1 block text-[11px] leading-5 text-tx-tertiary">
              页面隐藏、桌面窗口失焦或手机应用进入后台超过 {FOLDER_BACKGROUND_LOCK_DELAY_MS / 60000} 分钟后锁定。
            </span>
          </span>
          <span
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              prefs.folderLockOnBackground
                ? "bg-gradient-to-r from-amber-500 to-rose-500"
                : "bg-app-border"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                prefs.folderLockOnBackground ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>

        <div className="flex flex-col gap-3 rounded-xl border border-app-border/75 bg-app-surface/90 p-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-semibold text-tx-primary">
              当前会话已解锁 {unlockedCount} 个密码文件夹
            </div>
            <div className="mt-1 text-[11px] leading-4 text-tx-tertiary">
              立即锁定会同步通知同一账号已打开的其他 Web 标签页和桌面窗口。
            </div>
          </div>
          <button
            type="button"
            onClick={lockNow}
            disabled={unlockedCount === 0}
            className="shrink-0 whitespace-nowrap rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 px-3.5 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:brightness-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            立即全部锁定
          </button>
        </div>
      </div>
    </section>
  );
}

import React, { useEffect, useState } from "react";
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
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <LockKeyhole className="h-4 w-4 text-indigo-500" />
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">密码文件夹自动锁定</h3>
      </div>
      <p className="max-w-2xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
        该设置跟随账号同步，在 Web、桌面端和手机端使用相同策略。服务端解锁令牌仍保留 12 小时绝对有效期上限。
      </p>

      <div className="max-w-2xl space-y-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-700 dark:bg-zinc-800/40">
        <label className="block space-y-2">
          <span className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
            <Clock3 size={15} />闲置多久后自动锁定
          </span>
          <select
            value={prefs.folderAutoLockMinutes}
            onChange={(event) => setPref(
              "folderAutoLockMinutes",
              Number(event.target.value) as FolderAutoLockMinutes,
            )}
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            {FOLDER_AUTO_LOCK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span className="block text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            鼠标、键盘、触摸和滚动会重新计时；正在编辑时不会因持续操作而突然锁定。
          </span>
        </label>

        <button
          type="button"
          role="switch"
          aria-checked={prefs.folderLockOnBackground}
          onClick={() => setPref("folderLockOnBackground", !prefs.folderLockOnBackground)}
          className="flex w-full items-center justify-between gap-4 rounded-lg border border-zinc-200 bg-white px-3 py-3 text-left dark:border-zinc-700 dark:bg-zinc-900"
        >
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
              <Monitor size={15} /><Smartphone size={14} />切到后台后自动锁定
            </span>
            <span className="mt-1 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              页面隐藏、桌面窗口失焦或手机应用进入后台超过 {FOLDER_BACKGROUND_LOCK_DELAY_MS / 60000} 分钟后锁定。
            </span>
          </span>
          <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            prefs.folderLockOnBackground ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-600"
          }`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              prefs.folderLockOnBackground ? "translate-x-5" : "translate-x-0.5"
            }`} />
          </span>
        </button>

        <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-700 dark:bg-zinc-900">
          <div>
            <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              当前会话已解锁 {unlockedCount} 个密码文件夹
            </div>
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              立即锁定会同步通知同一账号已打开的其他 Web 标签页和桌面窗口。
            </div>
          </div>
          <button
            type="button"
            onClick={lockNow}
            disabled={unlockedCount === 0}
            className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            立即全部锁定
          </button>
        </div>
      </div>
    </section>
  );
}

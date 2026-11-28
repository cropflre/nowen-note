import React, { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, KeyRound, Loader2, RefreshCw } from "lucide-react";

import FolderPasswordDialog from "@/components/FolderPasswordDialog";
import { api } from "@/lib/api";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import type { JournalScope } from "@/lib/journalScope";
import {
  forgetUnlockedFolder,
  KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT,
  rememberUnlockedFolder,
} from "@/lib/knowledgeTreePassword";

interface PrivacyStatus {
  exists: boolean;
  rootNotebookId: string | null;
  rootNodeId: string | null;
  title: string;
  isPasswordProtected: boolean;
  unlocked: boolean;
}

export default function JournalPrivacyGate({
  scope,
  activeWorkspaceId,
  onUseWorkspace,
  children,
}: {
  scope: JournalScope;
  activeWorkspaceId: string | null;
  onUseWorkspace: () => void;
  children: React.ReactNode;
}) {
  const { prefs } = useUserPreferences();
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [loading, setLoading] = useState(scope.kind === "personal");
  const [error, setError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const forcedForPersonalEntry = useRef(false);

  const load = useCallback(async () => {
    if (scope.kind === "workspace") {
      forcedForPersonalEntry.current = false;
      setStatus(null);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      let next = await api.journals.getPrivacyStatus();
      if (
        prefs.journalLockOnEntry
        && next.isPasswordProtected
        && next.rootNodeId
        && !forcedForPersonalEntry.current
      ) {
        forgetUnlockedFolder(next.rootNodeId);
        forcedForPersonalEntry.current = true;
        next = { ...next, unlocked: false };
      }
      // Trust the server verdict on initial load: a locally cached token may have
      // become stale after a password change. The API validates passwordVersion.
      setStatus(next);
    } catch (caughtError: unknown) {
      const requestError = caughtError as Error & { code?: string };
      setError(requestError?.message || "读取日记隐私状态失败");
    } finally {
      setLoading(false);
    }
  }, [prefs.journalLockOnEntry, scope.kind]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (scope.kind !== "personal" || !status?.rootNodeId) return;
    const sync = () => { void load(); };
    window.addEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, sync);
    return () => window.removeEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, sync);
  }, [load, scope.kind, status?.rootNodeId]);

  if (scope.kind === "workspace") return <>{children}</>;

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-gradient-to-br from-app-bg via-app-bg to-indigo-500/[0.04]">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-app-border/75 bg-app-surface/85 shadow-sm backdrop-blur-md">
          <Loader2 size={22} className="animate-spin text-accent-primary" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-gradient-to-br from-app-bg via-app-bg to-rose-500/[0.04] p-6">
        <div className="relative max-w-sm overflow-hidden rounded-[26px] border border-app-border/75 bg-app-surface/90 p-7 text-center shadow-xl backdrop-blur-xl">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-rose-500/55 to-transparent" />
          <p className="text-sm font-bold text-tx-primary">无法读取日记隐私状态</p>
          <p className="mt-2 text-xs text-tx-tertiary">{error}</p>
          <button type="button" onClick={() => void load()} className="mt-5 inline-flex items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-bg/85 px-4 py-2 text-xs font-semibold text-tx-secondary shadow-sm transition-all hover:-translate-y-[1px] hover:border-accent-primary/40 hover:text-accent-primary active:translate-y-[0.5px]">
            <RefreshCw size={13} /> 重试
          </button>
        </div>
      </div>
    );
  }

  const locked = !!status?.isPasswordProtected && !status.unlocked;
  if (!locked) return <>{children}</>;

  const node = status?.rootNodeId
    ? { id: status.rootNodeId, title: status.title || "个人日记", isPasswordProtected: 1 }
    : null;

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-gradient-to-br from-app-bg via-app-bg to-indigo-500/[0.05] p-6" data-journal-privacy-gate="">
      <div className="pointer-events-none absolute -top-24 left-1/3 h-64 w-64 rounded-full bg-indigo-500/12 blur-3xl dark:bg-indigo-500/18" aria-hidden="true" />
      <div className="relative w-full max-w-md overflow-hidden rounded-[28px] border border-app-border/75 bg-app-surface/88 p-8 text-center shadow-[0_24px_60px_-24px_rgba(15,23,42,0.18)] backdrop-blur-2xl dark:shadow-[0_24px_64px_-20px_rgba(0,0,0,0.65)]">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-indigo-500/60 to-transparent" />
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/18 via-sky-500/14 to-violet-500/18 text-accent-primary ring-1 ring-inset ring-accent-primary/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.65),0_3px_0_rgba(15,23,42,0.08)]">
          <KeyRound size={24} />
        </div>
        <h2 className="mt-4 text-lg font-bold tracking-tight text-tx-primary">个人日记已锁定</h2>
        <p className="mt-2 text-sm leading-6 text-tx-tertiary">日记正文、档案与日期列表受“个人日记”目录密码保护。解锁只在当前会话有效。</p>
        <button type="button" onClick={() => setUnlocking(true)} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-500/25 transition-all hover:-translate-y-[1px] hover:from-indigo-500 hover:to-violet-500 active:translate-y-[0.5px]">
          <BookOpen size={15} /> 解锁日记
        </button>
        {activeWorkspaceId && (
          <button type="button" onClick={onUseWorkspace} className="mt-3.5 block w-full text-xs font-medium text-tx-tertiary transition-colors hover:text-accent-primary">切换到工作区日志</button>
        )}
      </div>

      {unlocking && node && (
        <FolderPasswordDialog
          node={node}
          mode="unlock"
          onClose={() => setUnlocking(false)}
          onUnlocked={(nodeId, token) => {
            rememberUnlockedFolder(nodeId, token);
            setStatus((current) => current ? { ...current, unlocked: true } : current);
            setUnlocking(false);
          }}
          onChanged={() => {}}
        />
      )}
    </div>
  );
}

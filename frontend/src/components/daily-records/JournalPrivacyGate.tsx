import React, { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, KeyRound, Loader2, RefreshCw } from "lucide-react";

import FolderPasswordDialog from "@/components/FolderPasswordDialog";
import { api } from "@/lib/api";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import type { JournalScope } from "@/lib/journalScope";
import {
  forgetUnlockedFolder,
  KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT,
  loadUnlockedFolderIds,
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
      } else if (next.rootNodeId) {
        next = { ...next, unlocked: !next.isPasswordProtected || loadUnlockedFolderIds().has(next.rootNodeId) };
      }
      setStatus(next);
    } catch (requestError: any) {
      setError(requestError?.message || "读取日记隐私状态失败");
    } finally {
      setLoading(false);
    }
  }, [prefs.journalLockOnEntry, scope.kind]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (scope.kind !== "personal" || !status?.rootNodeId) return;
    const sync = () => {
      setStatus((current) => current ? {
        ...current,
        unlocked: !current.isPasswordProtected || loadUnlockedFolderIds().has(current.rootNodeId || ""),
      } : current);
    };
    window.addEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, sync);
    return () => window.removeEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, sync);
  }, [scope.kind, status?.rootNodeId]);

  if (scope.kind === "workspace") return <>{children}</>;

  if (loading) {
    return <div className="flex min-h-0 flex-1 items-center justify-center bg-app-bg"><Loader2 size={24} className="animate-spin text-accent-primary" /></div>;
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-app-bg p-6">
        <div className="max-w-sm rounded-2xl border border-app-border bg-app-surface p-6 text-center">
          <p className="text-sm font-medium text-tx-primary">无法读取日记隐私状态</p>
          <p className="mt-2 text-xs text-tx-tertiary">{error}</p>
          <button type="button" onClick={() => void load()} className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-app-border px-3 py-2 text-xs text-tx-secondary hover:bg-app-hover">
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
    <div className="flex min-h-0 flex-1 items-center justify-center bg-app-bg p-6" data-journal-privacy-gate="">
      <div className="w-full max-w-md rounded-3xl border border-app-border bg-app-surface p-7 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary"><KeyRound size={22} /></div>
        <h2 className="mt-4 text-lg font-semibold text-tx-primary">个人日记已锁定</h2>
        <p className="mt-2 text-sm leading-6 text-tx-tertiary">日记正文、档案与日期列表受“个人日记”目录密码保护。解锁只在当前会话有效。</p>
        <button type="button" onClick={() => setUnlocking(true)} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent-primary px-5 py-2.5 text-sm font-medium text-white">
          <BookOpen size={15} /> 解锁日记
        </button>
        {activeWorkspaceId && (
          <button type="button" onClick={onUseWorkspace} className="mt-3 block w-full text-xs text-tx-tertiary hover:text-accent-primary">切换到工作区日志</button>
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

/**
 * Phase 3: useYDoc —— 按 noteId 绑定一个 Y.Doc Provider
 *
 * 除了编辑器装配状态，本 hook 还把 provider 的持久化状态映射到现有
 * SyncIndicator：只有收到服务端 y:ack 后才显示“已保存”。
 */

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import {
  NowenYjsProvider,
  type ProviderDurabilityState,
  type ProviderStatus,
  type ProviderUser,
} from "@/lib/yjsProvider";
import { realtime } from "@/lib/realtime";
import { isLargeDocumentCollaborationBlocked } from "@/lib/largeRichTextSafeMode";
import { useAppActions } from "@/store/AppContext";

export interface UseYDocOptions {
  noteId: string | null;
  user: ProviderUser | null;
  /** 是否启用 CRDT 协同（false 时返回空 doc/provider，不建立连接） */
  enabled: boolean;
}

const IDLE_DURABILITY: ProviderDurabilityState = {
  status: "idle",
  pendingCount: 0,
  dirty: false,
  lastPersistedAt: null,
  errorCode: null,
};

export interface UseYDocResult {
  doc: Y.Doc | null;
  provider: NowenYjsProvider | null;
  status: ProviderStatus | "idle";
  /** 是否已完成初次 sync（可开始绑定编辑器） */
  synced: boolean;
  /** 当前正文是否已经收到服务端持久化确认 */
  durability: ProviderDurabilityState;
}

export function useYDoc({ noteId, user, enabled }: UseYDocOptions): UseYDocResult {
  const actions = useAppActions();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const [state, setState] = useState<UseYDocResult>({
    doc: null,
    provider: null,
    status: "idle",
    synced: false,
    durability: IDLE_DURABILITY,
  });

  const currentRef = useRef<{ doc: Y.Doc; provider: NowenYjsProvider } | null>(null);
  const largeDocumentBlocked = isLargeDocumentCollaborationBlocked(noteId);

  useEffect(() => {
    if (!enabled || !noteId || !user || largeDocumentBlocked) {
      if (currentRef.current) {
        try { currentRef.current.provider.destroy(); } catch {}
        try { currentRef.current.doc.destroy(); } catch {}
        currentRef.current = null;
      }
      setState({
        doc: null,
        provider: null,
        status: "idle",
        synced: false,
        durability: IDLE_DURABILITY,
      });
      return;
    }

    realtime.connect();

    const doc = new Y.Doc();
    const provider = new NowenYjsProvider(noteId, user, doc);
    currentRef.current = { doc, provider };

    const initialDurability = provider.getDurabilityState();
    setState({
      doc,
      provider,
      status: provider.getStatus(),
      synced: provider.getStatus() === "synced",
      durability: initialDurability,
    });

    const applyDurability = (durability: ProviderDurabilityState) => {
      setState((prev) =>
        prev.provider === provider ? { ...prev, durability } : prev,
      );

      const currentActions = actionsRef.current;
      switch (durability.status) {
        case "saving":
          currentActions.setSyncStatus("saving");
          break;
        case "local":
          currentActions.setSyncStatus("queued");
          break;
        case "saved":
          currentActions.setSyncStatus("saved");
          if (durability.lastPersistedAt) {
            currentActions.setLastSynced(durability.lastPersistedAt);
          }
          break;
        case "error":
          currentActions.setSyncStatus("error");
          break;
        case "idle":
          break;
      }
    };

    const offStatus = provider.on("status", (status: ProviderStatus) => {
      setState((prev) =>
        prev.provider === provider ? { ...prev, status } : prev,
      );
      if (status === "disconnected" && provider.getDurabilityState().dirty) {
        actionsRef.current.setSyncStatus("queued");
      }
    });
    const offSynced = provider.on("synced", () => {
      setState((prev) =>
        prev.provider === provider ? { ...prev, synced: true } : prev,
      );
    });
    const offDurability = provider.on("durability", applyDurability);

    return () => {
      offStatus();
      offSynced();
      offDurability();
      try { provider.destroy(); } catch {}
      try { doc.destroy(); } catch {}
      if (currentRef.current?.provider === provider) currentRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, enabled, largeDocumentBlocked, user?.userId, user?.username]);

  return state;
}

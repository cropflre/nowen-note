/**
 * Phase 3: useYDoc —— 按 noteId 绑定一个 Y.Doc Provider
 *
 * 使用方式：
 *   const { doc, provider, status, synced } = useYDoc({ noteId, user, enabled });
 *   // 把 doc + provider.awareness 传给 yCollab 扩展即可
 *
 * 生命周期：
 *   - noteId 变化 / enabled 变 false → destroy 旧 provider
 *   - 组件卸载 → destroy
 *
 * 注意：
 *   - Y.Doc 在 hook 内部新建，保证每次 join 都是干净状态
 *   - 服务端 y:sync 会注入完整 state
 *   - P3-#13：doc 只在 "synced 或 未启用" 时才暴露给上层，避免 CRDT
 *     装配到一半（只有 IDB 数据、还没收到服务端 sync）时渲染"空编辑器 → 补全"
 *     两次重建。
 */

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { NowenYjsProvider, ProviderStatus, ProviderUser } from "@/lib/yjsProvider";
import { realtime } from "@/lib/realtime";

export interface UseYDocOptions {
  noteId: string | null;
  user: ProviderUser | null;
  /** 是否启用 CRDT 协同（false 时返回空 doc/provider，不建立连接） */
  enabled: boolean;
}

export interface UseYDocResult {
  doc: Y.Doc | null;
  provider: NowenYjsProvider | null;
  status: ProviderStatus | "idle";
  /** 是否已完成初次 sync（可开始绑定编辑器） */
  synced: boolean;
}

export function useYDoc({ noteId, user, enabled }: UseYDocOptions): UseYDocResult {
  const [state, setState] = useState<UseYDocResult>({
    doc: null,
    provider: null,
    status: "idle",
    synced: false,
  });

  // 用 ref 保存当前 provider，方便在 effect cleanup 里 destroy 时保证是同一个
  const currentRef = useRef<{ doc: Y.Doc; provider: NowenYjsProvider } | null>(null);

  useEffect(() => {
    if (!enabled || !noteId || !user) {
      // 关闭态：清理现有
      if (currentRef.current) {
        try { currentRef.current.provider.destroy(); } catch {}
        try { currentRef.current.doc.destroy(); } catch {}
        currentRef.current = null;
      }
      setState({ doc: null, provider: null, status: "idle", synced: false });
      return;
    }

    // 确保 realtime 连通（若未登录会是 null）
    realtime.connect();

    const doc = new Y.Doc();
    const provider = new NowenYjsProvider(noteId, user, doc);
    currentRef.current = { doc, provider };

    setState({ doc, provider, status: provider.getStatus(), synced: false });

    // 关键：provider 构造函数里已经同步发出了 y:join。如果 y:sync 在下面这行
    // `provider.on("synced", ...)` 之前就已经到达并 emit，我们就永远收不到。
    // 因此：如果 provider 当前状态已经是 "synced"，立刻补发一次到本 hook 的 state。
    // （provider.status 是同步属性，天然无竞态。）
    const currentStatus = provider.getStatus();
    if (currentStatus === "synced") {
      console.debug(`[useYDoc] provider already synced on subscribe time for ${noteId}, backfilling`);
      setState((prev) =>
        prev.provider === provider ? { ...prev, synced: true, status: "synced" } : prev,
      );
    }

    const offStatus = provider.on("status", (s: ProviderStatus) => {
      setState((prev) =>
        prev.provider === provider ? { ...prev, status: s } : prev,
      );
    });
    const offSynced = provider.on("synced", () => {
      console.debug(`[useYDoc] received 'synced' for ${noteId}`);
      setState((prev) =>
        prev.provider === provider ? { ...prev, synced: true } : prev,
      );
    });

    return () => {
      offStatus();
      offSynced();
      try { provider.destroy(); } catch {}
      try { doc.destroy(); } catch {}
      if (currentRef.current?.provider === provider) {
        currentRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, enabled, user?.userId, user?.username]);

  return state;
}

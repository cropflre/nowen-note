import { useCallback, useEffect, useRef, useState } from "react";
import { realtime } from "@/lib/realtime";
import { trashApi } from "./trashApi";
import type { TrashBatchResult, TrashItem } from "./trashTypes";

export function useTrash(workspaceId: string, refreshToken: number) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TrashBatchResult | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const ticket = ++generation.current;
    setLoading(true);
    try {
      const response = await trashApi.list(workspaceId);
      if (ticket !== generation.current) return;
      setItems(response.items);
      setError(null);
    } catch (cause) {
      if (ticket === generation.current) setError(cause instanceof Error ? cause.message : "");
    } finally {
      if (ticket === generation.current) setLoading(false);
    }
  }, [workspaceId]);
  useEffect(() => {
    void reload();
    const refresh = () => { void reload(); };
    window.addEventListener("nowen:knowledge-tree-changed", refresh);
    window.addEventListener("nowen:workspace-refresh-applied", refresh);
    const offs = ["note:deleted", "notes:deleted", "note:updated"].map((event) => realtime.on(event, refresh));
    return () => {
      generation.current++;
      window.removeEventListener("nowen:knowledge-tree-changed", refresh);
      window.removeEventListener("nowen:workspace-refresh-applied", refresh);
      offs.forEach((off) => off());
    };
  }, [reload, refreshToken]);
  const mutate = async (action: "restore" | "permanent" | "empty", ids: string[]) => {
    setBusy(true);
    setResult(null);
    try {
      const response = action === "empty" ? await trashApi.empty(workspaceId) : await trashApi.mutate(workspaceId, action, ids);
      setResult(response);
      await reload();
      return response;
    } finally {
      setBusy(false);
    }
  };
  return { items, loading, error, busy, result, reload, mutate };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { FileItem } from "@/types";
import { isNativeCapacitorUploadRuntime } from "@/lib/uploadRequest";
import { newLocalId } from "@/lib/localRepository";

export type FileUploadTask = {
  id: string; file: File; folderId: string | null;
  status: "waiting" | "uploading" | "success" | "existing" | "failed" | "cancelled";
  progress: number | null; error?: string; result?: FileItem;
};

export function useFileUploadQueue(scope: string, onUploaded: () => void, isCurrentScope: () => boolean) {
  const [tasks, setTasks] = useState<FileUploadTask[]>([]);
  const active = useRef(new Map<string, AbortController>());
  const done = useRef(onUploaded);
  done.current = onUploaded;
  const canCancelActive = !isNativeCapacitorUploadRuntime();
  const scopeCheck = useRef(isCurrentScope);
  scopeCheck.current = isCurrentScope;

  useEffect(() => {
    setTasks([]);
    const requests = active.current;
    const stopObsolete = () => { if (!scopeCheck.current()) requests.forEach((controller) => controller.abort()); };
    const events = ["nowen:token-changed", "nowen:workspace-changed", "nowen:server-url-changed", "storage"];
    events.forEach((event) => window.addEventListener(event, stopObsolete));
    return () => {
      events.forEach((event) => window.removeEventListener(event, stopObsolete));
      requests.forEach((controller) => controller.abort()); requests.clear();
    };
  }, [scope]);

  const update = useCallback((id: string, patch: Partial<FileUploadTask>) => {
    setTasks((previous) => previous.map((task) => task.id === id ? { ...task, ...patch } : task));
  }, []);

  useEffect(() => {
    for (const task of tasks) {
      if (!scopeCheck.current()) break;
      if (active.current.size >= 3) break;
      if (task.status !== "waiting" || active.current.has(task.id)) continue;
      const controller = new AbortController();
      active.current.set(task.id, controller);
      update(task.id, { status: "uploading" });
      api.files.upload(task.file, {
        folderId: task.folderId || undefined, signal: controller.signal,
        onProgress: (loaded, total) => { if (!controller.signal.aborted) update(task.id, { progress: Math.min(100, loaded / total * 100) }); },
      }).then((result) => {
        if (controller.signal.aborted || !scopeCheck.current()) return;
        update(task.id, { status: result.deduplicated ? "existing" : "success", progress: 100, result });
        done.current();
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) update(task.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      }).finally(() => {
        if (active.current.delete(task.id)) setTasks((previous) => [...previous]);
      });
    }
  }, [tasks, update]);

  const enqueue = (files: File[], folderId: string | null) => setTasks((previous) => [...previous,
    ...files.map((file): FileUploadTask => ({ id: newLocalId(), file, folderId, status: "waiting", progress: null }))]);
  const cancel = (id: string) => {
    const controller = active.current.get(id);
    if (controller && !canCancelActive) return;
    controller?.abort();
    update(id, { status: "cancelled" });
  };
  const retry = (id: string) => update(id, { status: "waiting", progress: null, error: undefined });
  const clearCompleted = () => setTasks((previous) => previous.filter((task) => ["waiting", "uploading", "failed"].includes(task.status)));
  return { tasks, enqueue, cancel, retry, clearCompleted, canCancelActive };
}

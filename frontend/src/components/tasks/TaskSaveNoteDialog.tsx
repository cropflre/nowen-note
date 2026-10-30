import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import type { Notebook, Note, Task } from "@/types";
import { newLocalId } from "@/lib/localRepository";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";

export function TaskSaveNoteDialog({ task, draft, onClose }: {
  task: Task; draft: { title: string; description: string }; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookId, setNotebookId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState<Note | null>(null);
  const request = useRef({ id: newLocalId(), notebookId: "" });
  const scope = useRef(getOfflineQueueStorageKey());
  const busy = useRef(false);
  useEffect(() => {
    let active = true;
    api.getNotebooks(task.workspaceId || "personal").then((rows) => {
      if (!active) return;
      const writable = rows.filter((row) => !row.permission || row.permission === "write" || row.permission === "manage");
      setNotebooks(writable); setNotebookId(writable[0]?.id || "");
    }).catch((error) => { if (active) setError(String(error.message || error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [task.workspaceId]);
  const save = async () => {
    if (busy.current || !notebookId) return;
    if (scope.current !== getOfflineQueueStorageKey()) { setError(t("tasks.lifecycle.scopeChanged")); return; }
    busy.current = true; setSaving(true); setError("");
    if (request.current.notebookId && request.current.notebookId !== notebookId) request.current.id = newLocalId();
    request.current.notebookId = notebookId;
    try {
      const created = await api.saveTaskAsNote(task.id,{ requestId: request.current.id, notebookId, ...draft });
      if (scope.current !== getOfflineQueueStorageKey()) throw new Error(t("tasks.lifecycle.scopeChanged"));
      setNote(created);
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", { detail: { reason: "task-note-created" } }));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { busy.current = false; setSaving(false); }
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div role="dialog" aria-modal="true" aria-labelledby="task-save-note-title" className="w-full max-w-md space-y-4 rounded-xl border border-app-border bg-app-surface p-5 shadow-xl">
      <h2 id="task-save-note-title" className="font-semibold text-tx-primary">{t("tasks.lifecycle.saveNote")}</h2>
      <p className="text-sm text-tx-secondary">{t(note ? "tasks.lifecycle.noteSaved" : "tasks.lifecycle.snapshotHint")}</p>
      {!note && <label className="block space-y-2 text-sm text-tx-primary">{t("tasks.lifecycle.destination")}
        <select aria-label={t("tasks.lifecycle.destination")} value={notebookId} onChange={(event) => setNotebookId(event.target.value)} disabled={loading || saving} className="w-full rounded-md border border-app-border bg-app-bg p-2">
          {!notebooks.length && <option value="">{t(loading ? "common.loading" : "tasks.lifecycle.noDestination")}</option>}
          {notebooks.map((notebook) => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}
        </select>
      </label>}
      {error && <p role="alert" className="text-sm text-accent-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button disabled={saving} onClick={onClose} className="rounded-md px-3 py-2 text-sm text-tx-secondary">{t("common.close")}</button>
        {note ? <button onClick={() => { window.dispatchEvent(new CustomEvent("nowen:open-note-link",{ detail:{noteId:note.id,blockId:null,href:`nowen://note/${note.id}`} })); onClose(); }} className="rounded-md bg-accent-primary px-3 py-2 text-sm text-white">{t("tasks.lifecycle.openNote")}</button>
          : <button disabled={saving || loading || !notebookId} onClick={save} className="rounded-md bg-accent-primary px-3 py-2 text-sm text-white disabled:opacity-50">{t(saving ? "common.loading" : "tasks.lifecycle.saveNote")}</button>}
      </div>
    </div>
  </div>;
}

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit, FileText, Folder, Grid2X2, Lock, RotateCcw, Search, Trash2, RefreshCw } from "lucide-react";
import { useApp, useAppActions } from "@/store/AppContext";
import { getCurrentWorkspace } from "@/lib/api";
import { emitKnowledgeTreeRefresh } from "@/lib/workspaceRefreshBridge";
import { parseServerTime } from "@/lib/dateTime";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ui/confirm";
import { useTrash } from "./useTrash";
import { permanentSelection, type TrashResourceType } from "./trashTypes";

const icons = { note: FileText, notebook: Folder, mindmap: BrainCircuit, sheet: Grid2X2 };
const buttonClass = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-app-border px-3 py-2 text-sm hover:bg-app-hover disabled:opacity-40 disabled:cursor-not-allowed";

export default function TrashPage() {
  const { state } = useApp();
  const workspaceId = getCurrentWorkspace();
  return <TrashCenter key={workspaceId} workspaceId={workspaceId} refreshToken={state.notesRefreshToken} />;
}

function TrashCenter({ workspaceId, refreshToken }: { workspaceId: string; refreshToken: number }) {
  const { t, i18n } = useTranslation();
  const actions = useAppActions();
  const { state } = useApp();
  const trash = useTrash(workspaceId, refreshToken);
  const [filter, setFilter] = useState<"all" | TrashResourceType>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const visible = trash.items.filter((item) => (filter === "all" || item.resourceType === filter)
    && `${item.title} ${item.originalPath.join(" / ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectedItems = trash.items.filter((item) => selected.includes(item.id));
  const disabled = trash.loading || trash.busy || trash.error !== null;

  const operate = async (action: "restore" | "permanent" | "empty", ids: string[]) => {
    const targets = action === "empty" ? trash.items : action === "permanent" ? permanentSelection(trash.items, ids) : trash.items.filter((item) => ids.includes(item.id));
    if (action !== "restore") {
      if (!await confirm({ title: t(action === "empty" ? "trashCenter.empty" : "trashCenter.permanent"),
        description: t("trashCenter.deleteConfirm", { count: targets.length }), confirmText: t("trashCenter.permanent"), danger: true })) return;
    } else if (targets.some((item) => item.restoreIncludesAncestors || item.resourceType === "notebook")) {
      if (!await confirm({ title: t("trashCenter.restore"), description: t("trashCenter.restoreConfirm"), confirmText: t("trashCenter.restore") })) return;
    }
    try {
      const result = await trash.mutate(action, ids);
      if (getCurrentWorkspace() !== workspaceId) return;
      setSelected((current) => current.filter((id) => !result.succeededIds.includes(id)));
      if (result.failures.length) toast.warning(t("trashCenter.partial", { count: result.succeededIds.length, failed: result.failures.length }));
      else toast.success(t("trashCenter.success", { count: result.succeededIds.length }));
      if (state.activeNote && result.noteIds.includes(state.activeNote.id)) actions.setActiveNote(null);
      actions.refreshNotes();
      actions.refreshNotebooks();
      emitKnowledgeTreeRefresh("trash-lifecycle");
      window.dispatchEvent(new CustomEvent("nowen:storage-changed", { detail: { reason: "trash-lifecycle" } }));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("trashCenter.operationFailed"));
      void trash.reload();
    }
  };

  return <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-app-bg text-tx-primary" aria-label={t("sidebar.trash")}>
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border px-4 py-4 md:px-6">
      <div className="flex items-center gap-2"><Trash2 size={22} className="text-tx-secondary" /><h1 className="text-lg font-semibold">{t("sidebar.trash")}</h1><span className="text-sm tabular-nums text-tx-tertiary">{trash.items.length}</span></div>
      <div className="flex gap-2">
        <button className={buttonClass} disabled={trash.busy || trash.loading} onClick={() => void trash.reload()} aria-label={t("trashCenter.refresh")}><RefreshCw size={16} /></button>
        <button className={`${buttonClass} text-accent-danger`} disabled={disabled || !trash.items.length} onClick={() => void operate("empty", [])}><Trash2 size={16} />{t("trashCenter.empty")}</button>
      </div>
    </header>
    <div className="space-y-3 border-b border-app-border px-4 py-3 md:px-6">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label={t("trashCenter.types")}>
        {(["all", "note", "notebook", "mindmap", "sheet"] as const).map((type) => <button key={type} role="tab" aria-selected={filter === type} onClick={() => setFilter(type)}
          className={`rounded-lg px-3 py-1.5 text-sm ${filter === type ? "bg-app-active text-accent-primary" : "text-tx-secondary hover:bg-app-hover"}`}>{t(`trashCenter.${type}`)}</button>)}
      </div>
      <label className="flex max-w-xl items-center gap-2 rounded-lg border border-app-border px-3 py-2 text-tx-tertiary"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("trashCenter.search")} aria-label={t("trashCenter.search")} className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none" /></label>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" disabled={disabled || !visible.length} checked={!!visible.length && visible.every((item) => selected.includes(item.id))} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, ...visible.map((item) => item.id)])] : selected.filter((id) => !visible.some((item) => item.id === id)))} />{t("trashCenter.selectAll")}</label>
        {!!selectedItems.length && <>
          <span className="text-tx-secondary">{t("trashCenter.selected", { count: selectedItems.length })}</span>
          <button className={buttonClass} disabled={disabled || !selectedItems.every((item) => item.canRestore) || selectedItems.length > 500} onClick={() => void operate("restore", selectedItems.map((item) => item.id))}><RotateCcw size={15} />{t("trashCenter.restore")}</button>
          <button className={`${buttonClass} text-accent-danger`} disabled={disabled || !selectedItems.every((item) => item.canDeletePermanently) || selectedItems.length > 500} onClick={() => void operate("permanent", selectedItems.map((item) => item.id))}><Trash2 size={15} />{t("trashCenter.permanent")}</button>
        </>}
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 md:px-6">
      {trash.error !== null ? <div role="alert" className="py-8 text-center text-accent-danger"><p>{t("trashCenter.loadFailed")}</p><p className="text-sm">{trash.error}</p><button className={`${buttonClass} mt-3`} onClick={() => void trash.reload()}>{t("trashCenter.retry")}</button></div>
        : trash.loading ? <p role="status" className="py-8 text-center text-tx-tertiary">{t("common.loading")}</p>
        : !visible.length ? <div className="py-16 text-center text-tx-tertiary"><Trash2 size={36} className="mx-auto mb-3 opacity-50" /><p>{t(trash.items.length ? "trashCenter.noMatches" : "trashCenter.emptyState")}</p></div>
        : <ul className="space-y-2">{visible.map((item) => {
          const Icon = icons[item.resourceType];
          const date = parseServerTime(item.deletedAt);
          const failure = trash.result?.failures.find((entry) => entry.id === item.id);
          return <li key={item.id} className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-app-border bg-app-elevated px-3 py-3 md:px-4">
            <input type="checkbox" disabled={disabled} aria-label={t("trashCenter.selectItem", { title: item.title })} checked={selected.includes(item.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />
            <Icon size={20} className="shrink-0 text-tx-secondary" />
            <div className="min-w-0 flex-1 basis-40"><p className="flex min-w-0 items-center gap-1.5"><span className="truncate font-medium" title={item.title}>{item.title}</span>{item.isLocked && <Lock size={13} className="shrink-0" aria-label={t("trashCenter.locked")} />}</p>
              <p className="truncate text-xs leading-6 text-tx-secondary" title={item.originalPath.join(" / ")}>{item.resourceType === "note" && item.contentFormat === "markdown" ? "Markdown" : t(`trashCenter.${item.resourceType}`)} · {t("trashCenter.originalPath")}：{item.originalPathHidden ? t("trashCenter.hiddenPath") : item.originalPath.join(" / ") || t("trashCenter.root")}</p>
              <p className="text-xs text-tx-tertiary">{t("trashCenter.deletedAt", { date: date ? date.toLocaleString(i18n.language) : t("trashCenter.unknownDate") })}</p>
              {failure && <p role="alert" className="mt-1 text-xs text-accent-danger">{failure.error}</p>}
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              <button className={buttonClass} disabled={disabled || !item.canRestore} onClick={() => void operate("restore", [item.id])} aria-label={t("trashCenter.restoreItem", { title: item.title })}><RotateCcw size={15} />{t("trashCenter.restore")}</button>
              <button className={`${buttonClass} text-accent-danger`} disabled={disabled || !item.canDeletePermanently} onClick={() => void operate("permanent", [item.id])} aria-label={t("trashCenter.deleteItem", { title: item.title })}><Trash2 size={15} />{t("trashCenter.permanent")}</button>
            </div>
          </li>;
        })}</ul>}
      <p className="mt-4 text-xs text-tx-tertiary">{t("trashCenter.protectedHint")}</p>
    </div>
  </main>;
}

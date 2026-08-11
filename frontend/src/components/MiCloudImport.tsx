import React, { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Smartphone, Loader2, CheckCircle, AlertCircle, CloudDownload,
  KeyRound, FileText, Trash2, ExternalLink, RefreshCw, XCircle, RotateCcw
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  type MiCloudImportJob,
  type MiCloudImportResult,
  type MiNoteEntry,
  verifyMiCookie,
  fetchMiNotes,
  importMiNotes,
  resumeActiveMiCloudImport,
  cancelMiCloudImport,
  retryFailedMiCloudImport,
  saveMiCookie,
  getMiCookie,
  clearMiCookie,
} from "@/lib/miNoteService";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";

export default function MiCloudImport() {
  const { t, i18n } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();

  const [cookie, setCookie] = useState(getMiCookie());
  const [phase, setPhase] = useState<"idle" | "verifying" | "loading" | "ready" | "importing" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState<MiNoteEntry[]>([]);
  const [folders, setFolders] = useState<Record<string, string>>({});
  const [importedCount, setImportedCount] = useState(0);
  const [selectedNotebookId, setSelectedNotebookId] = useState("");
  const [showCookieHelp, setShowCookieHelp] = useState(false);
  const [importJob, setImportJob] = useState<MiCloudImportJob | null>(null);

  const selectedCount = notes.filter((note) => note.selected).length;
  const progressPercent = importJob && importJob.total > 0
    ? Math.min(100, Math.round((importJob.processed / importJob.total) * 100))
    : 0;

  const applyProgress = useCallback((job: MiCloudImportJob) => {
    setImportJob(job);
    setImportedCount(job.succeeded);
    if (job.status === "queued" || job.status === "running" || job.status === "cancelling") {
      setPhase("importing");
      setMessage(
        job.status === "cancelling"
          ? t("miCloud.progressCancelling", {
              processed: job.processed,
              total: job.total,
            })
          : t("miCloud.progressRunning", {
              processed: job.processed,
              total: job.total,
              succeeded: job.succeeded,
              failed: job.failed,
            }),
      );
    }
  }, [t]);

  const finishImport = useCallback((result: MiCloudImportResult) => {
    setImportedCount(result.count);
    if (result.cancelled) {
      setPhase(notes.length > 0 ? "ready" : "idle");
      setMessage(t("miCloud.cancelledSummary", { count: result.count }));
      return;
    }

    if (result.success) {
      setPhase("done");
      setMessage(
        result.failedCount > 0
          ? t("miCloud.importPartial", { count: result.count, errors: result.failedCount })
          : t("miCloud.importSuccess", { count: result.count }),
      );
      api.getNotebooks().then(actions.setNotebooks).catch(console.error);
      return;
    }

    setPhase("error");
    setMessage(result.errors[0] || t("miCloud.importFailed"));
  }, [actions, notes.length, t]);

  useEffect(() => {
    let disposed = false;
    void resumeActiveMiCloudImport((job) => {
      if (!disposed) applyProgress(job);
    })
      .then((result) => {
        if (!disposed && result) finishImport(result);
      })
      .catch((error) => {
        if (disposed) return;
        setPhase("error");
        setMessage(error instanceof Error ? error.message : t("miCloud.importFailed"));
      });
    return () => {
      disposed = true;
    };
  }, [applyProgress, finishImport, t]);

  const handleConnect = useCallback(async () => {
    if (!cookie.trim()) {
      setMessage(t("miCloud.cookieRequired"));
      setPhase("error");
      return;
    }

    setPhase("verifying");
    setMessage(t("miCloud.verifying"));

    try {
      const result = await verifyMiCookie(cookie.trim());
      if (!result.valid) {
        setPhase("error");
        setMessage(result.error || t("miCloud.cookieInvalid"));
        return;
      }

      saveMiCookie(cookie.trim());
      setPhase("loading");
      setMessage(t("miCloud.loadingNotes"));

      const data = await fetchMiNotes(cookie.trim());
      setNotes(data.notes);
      setFolders(data.folders);
      setPhase("ready");
      setMessage(t("miCloud.notesLoaded", { count: data.notes.length }));
    } catch (error: any) {
      setPhase("error");
      setMessage(error.message || t("miCloud.connectFailed"));
    }
  }, [cookie, t]);

  const handleDisconnect = useCallback(() => {
    if (phase === "importing") return;
    clearMiCookie();
    setCookie("");
    setNotes([]);
    setFolders({});
    setPhase("idle");
    setMessage("");
    setImportedCount(0);
    setImportJob(null);
  }, [phase]);

  const handleRefresh = useCallback(async () => {
    const savedCookie = getMiCookie();
    if (!savedCookie) return;

    setPhase("loading");
    setMessage(t("miCloud.loadingNotes"));

    try {
      const data = await fetchMiNotes(savedCookie);
      setNotes(data.notes);
      setFolders(data.folders);
      setPhase("ready");
      setMessage(t("miCloud.notesLoaded", { count: data.notes.length }));
    } catch (error: any) {
      setPhase("error");
      setMessage(error.message || t("miCloud.loadFailed"));
    }
  }, [t]);

  const handleImport = useCallback(async () => {
    const selectedIds = notes.filter((note) => note.selected).map((note) => note.id);
    if (selectedIds.length === 0) return;

    setImportJob(null);
    setPhase("importing");
    setMessage(t("miCloud.importing", { count: selectedIds.length }));

    try {
      const result = await importMiNotes(
        getMiCookie(),
        selectedIds,
        selectedNotebookId || undefined,
        applyProgress,
      );
      finishImport(result);
    } catch (error: any) {
      setPhase("error");
      setMessage(error.message || t("miCloud.importFailed"));
    }
  }, [notes, selectedNotebookId, t, applyProgress, finishImport]);

  const handleCancel = useCallback(async () => {
    if (!importJob) return;
    try {
      const job = await cancelMiCloudImport(importJob.id);
      applyProgress(job);
      setMessage(t("miCloud.progressCancelling", {
        processed: job.processed,
        total: job.total,
      }));
    } catch (error: any) {
      setMessage(error.message || t("miCloud.cancelFailed"));
    }
  }, [importJob, applyProgress, t]);

  const handleRetryFailed = useCallback(async () => {
    if (!importJob || importJob.failed === 0) return;
    setPhase("importing");
    setMessage(t("miCloud.retryingFailed", { count: importJob.failed }));
    try {
      const result = await retryFailedMiCloudImport(importJob.id, getMiCookie(), applyProgress);
      finishImport(result);
    } catch (error: any) {
      setPhase("error");
      setMessage(error.message || t("miCloud.retryFailedFailed"));
    }
  }, [importJob, applyProgress, finishImport, t]);

  const toggleNote = (rowKey: string) => {
    setNotes((previous) =>
      previous.map((note) =>
        note.rowKey === rowKey ? { ...note, selected: !note.selected } : note
      )
    );
  };

  const toggleAll = () => {
    const allSelected = notes.every((note) => note.selected);
    setNotes((previous) => previous.map((note) => ({ ...note, selected: !allSelected })));
  };

  const formatDate = (timestamp: number) => {
    if (!timestamp) return "";
    return new Date(timestamp).toLocaleDateString(i18n.resolvedLanguage || i18n.language, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  };

  const progressCard = importJob ? (
    <div className="rounded-lg border border-orange-200 dark:border-orange-800/40 bg-orange-50/60 dark:bg-orange-950/20 p-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          {importJob.status === "cancelling"
            ? t("miCloud.cancellingLabel")
            : t("miCloud.backgroundTask")}
        </span>
        <span className="text-zinc-500 dark:text-zinc-400">
          {importJob.processed} / {importJob.total} ({progressPercent}%)
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div
          className="h-full rounded-full bg-orange-500 transition-[width] duration-300"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-zinc-500 dark:text-zinc-400">
        <span>
          {t("miCloud.progressStats", {
            succeeded: importJob.succeeded,
            failed: importJob.failed,
          })}
          {importJob.currentExternalId
            ? ` · ${t("miCloud.currentItem", { id: importJob.currentExternalId })}`
            : ""}
        </span>
        {(importJob.status === "queued" || importJob.status === "running" || importJob.status === "cancelling") && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={importJob.status === "cancelling"}
            className="inline-flex items-center gap-1 text-red-500 hover:text-red-600 disabled:opacity-50"
          >
            <XCircle size={13} />
            {importJob.status === "cancelling"
              ? t("miCloud.cancellingAction")
              : t("miCloud.cancelAction")}
          </button>
        )}
      </div>
      {phase === "done" && importJob.failed > 0 && (
        <button
          type="button"
          onClick={handleRetryFailed}
          className="inline-flex items-center gap-1 text-xs font-medium text-orange-600 hover:text-orange-700"
        >
          <RotateCcw size={13} />
          {t("miCloud.retryFailedAction", { count: importJob.failed })}
        </button>
      )}
    </div>
  ) : null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Smartphone size={18} className="text-orange-500" />
        <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {t("miCloud.title")}
        </h4>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          {t("miCloud.description")}
        </p>

        {(phase === "idle" || phase === "error" || phase === "verifying") && notes.length === 0 ? (
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-1">
                  <KeyRound size={12} />
                  Cookie
                </label>
                <button
                  onClick={() => setShowCookieHelp(!showCookieHelp)}
                  className="text-xs text-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400"
                >
                  {t("miCloud.howToGetCookie")}
                </button>
              </div>

              <textarea
                value={cookie}
                onChange={(event) => {
                  setCookie(event.target.value);
                  if (phase === "error") setPhase("idle");
                }}
                rows={3}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-700 dark:text-zinc-300 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500 resize-none font-mono"
                placeholder={t("miCloud.cookiePlaceholder")}
              />
            </div>

            <AnimatePresence>
              {showCookieHelp && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 text-xs text-zinc-600 dark:text-zinc-400 space-y-1.5">
                    <p className="font-medium text-amber-700 dark:text-amber-400">
                      {t("miCloud.helpTitle")}
                    </p>
                    <ol className="list-decimal list-inside space-y-1 ml-1">
                      <li>{t("miCloud.helpStep1")}</li>
                      <li>{t("miCloud.helpStep2")}</li>
                      <li>{t("miCloud.helpStep3")}</li>
                      <li>{t("miCloud.helpStep4")}</li>
                    </ol>
                    <a
                      href="https://i.mi.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-indigo-500 hover:text-indigo-600 mt-1"
                    >
                      {t("miCloud.openMiCloud")}
                      <ExternalLink size={10} />
                    </a>
                    <p className="text-amber-600 dark:text-amber-400 font-medium mt-1">
                      {t("miCloud.cookieWarning")}
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {phase === "error" && message && (
              <div className="flex items-center gap-2 text-sm text-red-500">
                <AlertCircle size={14} />
                {message}
              </div>
            )}

            <button
              onClick={handleConnect}
              disabled={phase === "verifying" || !cookie.trim()}
              className={`flex items-center justify-center w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${
                phase === "verifying" || !cookie.trim()
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
                  : "bg-orange-500 hover:bg-orange-600 text-white shadow-md hover:shadow-lg"
              }`}
            >
              {phase === "verifying" ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t("miCloud.verifying")}
                </>
              ) : (
                <>
                  <CloudDownload className="w-4 h-4 mr-2" />
                  {t("miCloud.connect")}
                </>
              )}
            </button>
          </div>
        ) : null}

        {phase === "loading" && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500 dark:text-zinc-400">
            <Loader2 size={16} className="animate-spin text-orange-500" />
            {message}
          </div>
        )}

        {notes.length === 0 && importJob && (
          <div className="space-y-3">
            {progressCard}
            {message && <p className="text-sm text-zinc-600 dark:text-zinc-400">{message}</p>}
          </div>
        )}

        {(phase === "ready" || phase === "importing" || phase === "done" || phase === "error") && notes.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleAll}
                  disabled={phase === "importing"}
                  className="text-xs text-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 font-medium disabled:opacity-50"
                >
                  {notes.every((note) => note.selected) ? t("dataManager.deselectAll") : t("dataManager.selectAll")}
                </button>
                <span className="text-xs text-zinc-400 dark:text-zinc-600">
                  {t("dataManager.selectedCount", { selected: selectedCount, total: notes.length })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRefresh}
                  disabled={phase === "importing"}
                  className="p-1 rounded text-zinc-400 hover:text-orange-500 dark:hover:text-orange-400 transition-colors disabled:opacity-40"
                  title={t("miCloud.refresh")}
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  onClick={handleDisconnect}
                  disabled={phase === "importing"}
                  className="p-1 rounded text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-40"
                  title={t("miCloud.disconnect")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            <div>
              <label className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 block">
                {t("dataManager.importToNotebook")}
              </label>
              <select
                value={selectedNotebookId}
                onChange={(event) => setSelectedNotebookId(event.target.value)}
                disabled={phase === "importing"}
                className="w-full text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-3 py-1.5 outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500 disabled:opacity-60"
              >
                <option value="">{t("miCloud.autoCreateNotebook")}</option>
                {state.notebooks.map((notebook) => (
                  <option key={notebook.id} value={notebook.id}>
                    {notebook.icon} {notebook.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="max-h-64 overflow-y-auto space-y-1 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2">
              {notes.map((note) => (
                <label
                  key={note.rowKey}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors ${
                    phase === "importing" ? "cursor-not-allowed opacity-70" : "cursor-pointer"
                  } ${
                    note.selected
                      ? "bg-orange-50/50 dark:bg-orange-500/5"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={note.selected}
                    disabled={phase === "importing"}
                    onChange={() => toggleNote(note.rowKey)}
                    className="w-3.5 h-3.5 rounded border-zinc-300 dark:border-zinc-600 text-orange-500 focus:ring-orange-500/30"
                  />
                  <FileText size={14} className="text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-zinc-700 dark:text-zinc-300 truncate block">
                      {note.title}
                    </span>
                    {note.folderName && (
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-600">
                        {note.folderName}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-600 flex-shrink-0">
                    {formatDate(note.modifyDate)}
                  </span>
                </label>
              ))}
            </div>

            {progressCard}

            {message && (
              <div className="flex items-center gap-2">
                {phase === "error" ? (
                  <AlertCircle size={14} className="text-red-500" />
                ) : phase === "done" ? (
                  <CheckCircle size={14} className="text-green-500" />
                ) : phase === "importing" ? (
                  <Loader2 size={14} className="text-orange-500 animate-spin" />
                ) : null}
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  {message}
                </span>
              </div>
            )}

            <button
              onClick={handleImport}
              disabled={phase === "importing" || selectedCount === 0}
              className={`flex items-center justify-center w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${
                phase === "importing" || selectedCount === 0
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
                  : phase === "done"
                  ? "bg-green-500 hover:bg-green-600 text-white shadow-md"
                  : "bg-orange-500 hover:bg-orange-600 text-white shadow-md hover:shadow-lg"
              }`}
            >
              {phase === "importing" ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {importJob
                    ? t("miCloud.progressButton", {
                        processed: importJob.processed,
                        total: importJob.total,
                      })
                    : t("miCloud.importing", { count: selectedCount })}
                </>
              ) : phase === "done" ? (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  {t("miCloud.importSuccess", { count: importedCount })}
                </>
              ) : (
                <>
                  <CloudDownload className="w-4 h-4 mr-2" />
                  {t("miCloud.importButton", { count: selectedCount })}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

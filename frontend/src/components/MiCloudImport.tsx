import React, { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Smartphone, Loader2, CheckCircle, AlertCircle, CloudDownload,
  KeyRound, FileText, Trash2, ExternalLink, RefreshCw
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  MiNoteEntry, verifyMiCookie, fetchMiNotes, importMiNotes,
  saveMiCookie, getMiCookie, clearMiCookie
} from "@/lib/miNoteService";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";

export default function MiCloudImport() {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();

  const [cookie, setCookie] = useState(getMiCookie());
  const [phase, setPhase] = useState<"idle" | "verifying" | "loading" | "ready" | "importing" | "done" | "error">(
    getMiCookie() ? "idle" : "idle"
  );
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState<MiNoteEntry[]>([]);
  const [folders, setFolders] = useState<Record<string, string>>({});
  const [importedCount, setImportedCount] = useState(0);
  const [selectedNotebookId, setSelectedNotebookId] = useState("");
  const [showCookieHelp, setShowCookieHelp] = useState(false);

  const selectedCount = notes.filter((n) => n.selected).length;

  // 步骤1: 验证 Cookie 并获取笔记列表
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
    } catch (err: any) {
      setPhase("error");
      setMessage(err.message || t("miCloud.connectFailed"));
    }
  }, [cookie, t]);

  // 断开连接
  const handleDisconnect = useCallback(() => {
    clearMiCookie();
    setCookie("");
    setNotes([]);
    setFolders({});
    setPhase("idle");
    setMessage("");
    setImportedCount(0);
  }, []);

  // 刷新列表
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
    } catch (err: any) {
      setPhase("error");
      setMessage(err.message || t("miCloud.loadFailed"));
    }
  }, [t]);

  // 步骤2: 导入选中笔记
  const handleImport = useCallback(async () => {
    const selectedIds = notes.filter((n) => n.selected).map((n) => n.id);
    if (selectedIds.length === 0) return;

    setPhase("importing");
    setMessage(t("miCloud.importing", { count: selectedIds.length }));

    try {
      const result = await importMiNotes(
        getMiCookie(),
        selectedIds,
        selectedNotebookId || undefined
      );

      if (result.success) {
        setImportedCount(result.count);
        setPhase("done");
        setMessage(t("miCloud.importSuccess", { count: result.count }));
        api.getNotebooks().then(actions.setNotebooks).catch(console.error);

        if (result.errors && result.errors.length > 0) {
          setMessage(
            t("miCloud.importPartial", {
              count: result.count,
              errors: result.errors.length,
            })
          );
        }
      } else {
        setPhase("error");
        setMessage(t("miCloud.importFailed"));
      }
    } catch (err: any) {
      setPhase("error");
      setMessage(err.message || t("miCloud.importFailed"));
    }
  }, [notes, selectedNotebookId, t, actions]);

  const toggleNote = (id: string) => {
    setNotes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, selected: !n.selected } : n))
    );
  };

  const toggleAll = () => {
    const allSelected = notes.every((n) => n.selected);
    setNotes((prev) => prev.map((n) => ({ ...n, selected: !allSelected })));
  };

  const formatDate = (ts: number) => {
    if (!ts) return "";
    return new Date(ts).toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  };

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

        {/* Cookie 输入区 */}
        {phase === "idle" || phase === "error" || phase === "verifying" ? (
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
                onChange={(e) => {
                  setCookie(e.target.value);
                  if (phase === "error") setPhase("idle");
                }}
                rows={3}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-700 dark:text-zinc-300 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500 resize-none font-mono"
                placeholder={t("miCloud.cookiePlaceholder")}
              />
            </div>

            {/* Cookie 获取教程 */}
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

            {/* 错误提示 */}
            {phase === "error" && message && (
              <div className="flex items-center gap-2 text-sm text-red-500">
                <AlertCircle size={14} />
                {message}
              </div>
            )}

            {/* 连接按钮 */}
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

        {/* 加载中 */}
        {phase === "loading" && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500 dark:text-zinc-400">
            <Loader2 size={16} className="animate-spin text-orange-500" />
            {message}
          </div>
        )}

        {/* 笔记列表 */}
        {(phase === "ready" || phase === "importing" || phase === "done" || phase === "error") && notes.length > 0 && (
          <div className="space-y-3">
            {/* 操作栏 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleAll}
                  className="text-xs text-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 font-medium"
                >
                  {notes.every((n) => n.selected) ? t("dataManager.deselectAll") : t("dataManager.selectAll")}
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
                  className="p-1 rounded text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                  title={t("miCloud.disconnect")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {/* 目标笔记本选择 */}
            <div>
              <label className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 block">
                {t("dataManager.importToNotebook")}
              </label>
              <select
                value={selectedNotebookId}
                onChange={(e) => setSelectedNotebookId(e.target.value)}
                className="w-full text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-3 py-1.5 outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500"
              >
                <option value="">{t("miCloud.autoCreateNotebook")}</option>
                {state.notebooks.map((nb) => (
                  <option key={nb.id} value={nb.id}>
                    {nb.icon} {nb.name}
                  </option>
                ))}
              </select>
            </div>

            {/* 笔记列表 */}
            <div className="max-h-64 overflow-y-auto space-y-1 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2">
              {notes.map((note) => (
                <label
                  key={note.id}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                    note.selected
                      ? "bg-orange-50/50 dark:bg-orange-500/5"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={note.selected}
                    onChange={() => toggleNote(note.id)}
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

            {/* 状态信息 */}
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

            {/* 导入按钮 */}
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
                  {t("miCloud.importing", { count: selectedCount })}
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

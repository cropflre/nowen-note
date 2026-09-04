import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle, BookOpen, CheckCircle2, CloudDownload, FileText,
  FolderOpen, KeyRound, Loader2, RefreshCw, RotateCcw, CheckSquare, Square, HelpCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { useAppActions } from "@/store/AppContext";
import {
  clearYuqueCreds, fetchYuqueDocs, fetchYuqueRepos, getYuqueCookie, getYuqueCsrf,
  importYuqueDocs, retryYuqueImages, saveYuqueCreds, verifyYuqueCreds,
  type YuqueDocMeta, type YuqueRepo, type YuqueRetryImagesResult,
} from "@/lib/yuqueService";

type Phase =
  | "idle"        // cookie 输入
  | "verifying"   // 验证凭证
  | "loadingRepos"
  | "selectRepo"  // 选择知识库
  | "loadingDocs"
  | "selectDocs"  // 选择文档
  | "importing"
  | "done"
  | "error";

export default function YuqueImport({ defaultNotebookId }: { defaultNotebookId?: string }) {
  const { t } = useTranslation();
  const actions = useAppActions();

  const [cookie, setCookie] = useState(getYuqueCookie());
  const [csrf, setCsrf] = useState(getYuqueCsrf());
  const [phase, setPhase] = useState<Phase>("idle");
  const [login, setLogin] = useState("");
  const [repos, setRepos] = useState<YuqueRepo[]>([]);
  const [activeRepo, setActiveRepo] = useState<YuqueRepo | null>(null);
  const [docs, setDocs] = useState<YuqueDocMeta[]>([]);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [showHelp, setShowHelp] = useState(false);
  const [message, setMessage] = useState<{ kind: "info" | "error" | "success"; text: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [retryingImages, setRetryingImages] = useState(false);
  const [result, setResult] = useState<{ count: number; errors: string[]; images: number; failedImages: number; notebookId?: string } | null>(null);

  const selectedCount = useMemo(
    () => docs.filter((d) => selectedUrls.has(d.url)).length,
    [docs, selectedUrls],
  );

  useEffect(() => {
    saveYuqueCreds(cookie, csrf);
  }, [cookie, csrf]);

  const showError = useCallback((text: string) => {
    setMessage({ kind: "error", text });
    setPhase("error");
  }, []);

  const handleConnect = useCallback(async () => {
    const cookieTrim = cookie.trim();
    const csrfTrim = csrf.trim();
    if (!cookieTrim || !csrfTrim) {
      showError(t("yuqueImport.credsRequired"));
      return;
    }
    setPhase("verifying");
    setMessage({ kind: "info", text: t("yuqueImport.verifying") });
    try {
      const res = await verifyYuqueCreds(cookieTrim, csrfTrim);
      if (!res.valid) {
        showError(res.error || t("yuqueImport.credsInvalid"));
        return;
      }
      setLogin(res.login || "");
      setPhase("loadingRepos");
      setMessage({ kind: "info", text: t("yuqueImport.loadingRepos") });
      const list = await fetchYuqueRepos(cookieTrim, csrfTrim);
      setRepos(list);
      if (list.length === 0) {
        setPhase("selectRepo");
        setMessage({ kind: "info", text: t("yuqueImport.noRepos") });
        return;
      }
      setPhase("selectRepo");
      setMessage(null);
    } catch (err: any) {
      showError(err?.message || t("yuqueImport.connectFailed"));
    }
  }, [cookie, csrf, t, showError]);

  const handleSelectRepo = useCallback(
    async (repo: YuqueRepo) => {
      setActiveRepo(repo);
      setDocs([]);
      setSelectedUrls(new Set());
      setResult(null);
      setPhase("loadingDocs");
      setMessage({ kind: "info", text: t("yuqueImport.loadingDocs") });
      try {
        const list = await fetchYuqueDocs(cookie.trim(), csrf.trim(), repo.user, repo.slug);
        setDocs(list);
        setSelectedUrls(new Set(list.map((d) => d.url)));
        setPhase("selectDocs");
        setMessage(
          list.length === 0
            ? { kind: "info", text: t("yuqueImport.noDocs") }
            : { kind: "success", text: t("yuqueImport.docsLoaded", { count: list.length }) },
        );
      } catch (err: any) {
        showError(err?.message || t("yuqueImport.loadDocsFailed"));
      }
    },
    [cookie, csrf, t, showError],
  );

  const toggleDoc = (url: string) => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const toggleAll = () => {
    const allSelected = docs.every((d) => selectedUrls.has(d.url));
    setSelectedUrls(new Set(allSelected ? [] : docs.map((d) => d.url)));
  };

  const handleImport = useCallback(async () => {
    if (!activeRepo) return;
    const items = docs
      .filter((d) => selectedUrls.has(d.url))
      .map((d) => ({ url: d.url, title: d.title }));
    if (items.length === 0) {
      showError(t("yuqueImport.noSelection"));
      return;
    }
    setImporting(true);
    setPhase("importing");
    setMessage({ kind: "info", text: t("yuqueImport.importing", { count: items.length }) });
    try {
      const res = await importYuqueDocs(
        cookie.trim(), csrf.trim(), activeRepo.user, activeRepo.slug, items, defaultNotebookId,
      );
      setResult({ count: res.count, errors: res.errors || [], images: res.downloadedImages || 0, failedImages: res.failedImages || 0, notebookId: res.notebookId });
      setPhase("done");
      setMessage({
        kind: res.count > 0 ? "success" : "error",
        text:
          res.count > 0
            ? t("yuqueImport.importDone", {
                count: res.count,
                failed: res.errors.length,
                images: res.downloadedImages,
                failedImages: res.failedImages,
              })
            : (res.errors[0] || t("yuqueImport.importFailed")),
      });
      api.getNotebooks().then(actions.setNotebooks).catch(console.error);
    } catch (err: any) {
      showError(err?.message || t("yuqueImport.importFailed"));
    } finally {
      setImporting(false);
    }
  }, [activeRepo, docs, selectedUrls, cookie, csrf, t, showError, actions, defaultNotebookId]);

  const handleReset = useCallback(() => {
    clearYuqueCreds();
    setCookie("");
    setCsrf("");
    setLogin("");
    setRepos([]);
    setActiveRepo(null);
    setDocs([]);
    setSelectedUrls(new Set());
    setResult(null);
    setMessage(null);
    setPhase("idle");
  }, []);

  const backToRepos = useCallback(() => {
    setActiveRepo(null);
    setDocs([]);
    setSelectedUrls(new Set());
    setResult(null);
    setMessage(null);
    setPhase("selectRepo");
  }, []);

  // 重试导入失败的图片：就地更新已导入笔记里的远程 <img>，不重建笔记、不重复。
  const handleRetryImages = useCallback(async () => {
    if (!result?.notebookId) return;
    setRetryingImages(true);
    setMessage({ kind: "info", text: t("yuqueImport.retryingImages") });
    try {
      const res: YuqueRetryImagesResult = await retryYuqueImages(
        cookie.trim(), csrf.trim(), result.notebookId,
      );
      setResult((prev) =>
        prev
          ? {
              ...prev,
              // 重试成功的图片累加到已本地化总数；仍失败的取端点返回的最新值
              images: prev.images + res.downloadedImages,
              failedImages: res.failedImages,
            }
          : prev,
      );
      setMessage({
        kind: res.failedImages > 0 ? "info" : "success",
        text: t("yuqueImport.retryImagesDone", {
          downloaded: res.downloadedImages,
          failed: res.failedImages,
          notes: res.notesUpdated,
        }),
      });
    } catch (err: any) {
      showError(err?.message || t("yuqueImport.retryImagesFailed"));
    } finally {
      setRetryingImages(false);
    }
  }, [result, cookie, csrf, t, showError]);

  // 失败后的重试：按当前阶段决定重试动作
  const handleRetry = useCallback(() => {
    if (!login) {
      void handleConnect();
      return;
    }
    if (!activeRepo) {
      setPhase("loadingRepos");
      setMessage({ kind: "info", text: t("yuqueImport.loadingRepos") });
      fetchYuqueRepos(cookie.trim(), csrf.trim())
        .then((list) => {
          setRepos(list);
          setPhase(list.length === 0 ? "selectRepo" : "selectRepo");
          setMessage(null);
        })
        .catch((err: any) => showError(err?.message || t("yuqueImport.connectFailed")));
      return;
    }
    if (docs.length === 0) {
      void handleSelectRepo(activeRepo);
      return;
    }
    // 导入阶段失败：回到文档选择，保留勾选，方便重导
    setMessage(null);
    setPhase("selectDocs");
  }, [login, activeRepo, docs.length, cookie, csrf, t, handleConnect, handleSelectRepo, showError]);

  const actionButton = (() => {
    if (phase === "idle" || phase === "verifying") {
      return (
        <button
          type="button"
          onClick={handleConnect}
          disabled={phase === "verifying"}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {phase === "verifying" ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
          {t("yuqueImport.connectAction")}
        </button>
      );
    }
    if (phase === "loadingRepos" || phase === "loadingDocs") {
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 size={15} className="animate-spin" />
          {phase === "loadingRepos" ? t("yuqueImport.loadingRepos") : t("yuqueImport.loadingDocs")}
        </span>
      );
    }
    return null;
  })();

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <BookOpen size={18} className="text-blue-600 dark:text-blue-400" />
        <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{t("yuqueImport.title")}</h3>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("yuqueImport.subtitle")}</p>

      {/* 凭证输入 */}
      {(phase === "idle" || phase === "verifying" || phase === "error") && !login && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 space-y-3">
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <KeyRound size={14} className="shrink-0" />
            <span>{t("yuqueImport.credsLabel")}</span>
            <button
              type="button"
              onClick={() => setShowHelp((v) => !v)}
              className="ml-auto inline-flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-600"
            >
              <HelpCircle size={12} />
              {t("yuqueImport.howToGet")}
            </button>
          </div>
          {showHelp && (
            <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              {(t("yuqueImport.helpSteps", { returnObjects: true }) as unknown as string[]).map(
                (step: string, i: number) => (
                  <li key={i}>{step}</li>
                ),
              )}
            </ol>
          )}
          <div className="space-y-2">
            <div>
              <div className="mb-1 text-[11px] text-zinc-400 dark:text-zinc-500">Cookie</div>
              <input
                type="password"
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
                placeholder={t("yuqueImport.cookiePlaceholder")}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2.5 py-1.5 text-sm text-zinc-800 dark:text-zinc-100 outline-none focus:border-blue-500"
                autoComplete="off"
              />
            </div>
            <div>
              <div className="mb-1 text-[11px] text-zinc-400 dark:text-zinc-500">X-Csrf-Token</div>
              <input
                type="password"
                value={csrf}
                onChange={(e) => setCsrf(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && phase !== "verifying") void handleConnect();
                }}
                placeholder={t("yuqueImport.csrfPlaceholder")}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2.5 py-1.5 text-sm text-zinc-800 dark:text-zinc-100 outline-none focus:border-blue-500"
                autoComplete="off"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{t("yuqueImport.credsHint")}</span>
            {actionButton}
          </div>
        </div>
      )}

      {/* 已连接 */}
      {login && (
        <div className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
          <CheckCircle2 size={14} className="text-emerald-500" />
          <span>
            {t("yuqueImport.connectedAs", { name: login })}
          </span>
          {phase !== "importing" && (
            <button
              type="button"
              onClick={handleReset}
              className="ml-auto inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            >
              <RotateCcw size={13} />
              {t("yuqueImport.resetAction")}
            </button>
          )}
        </div>
      )}

      {/* 消息 */}
      {message && (
        <div
          className={`rounded-md px-3 py-2 text-xs ${
            message.kind === "error"
              ? "bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400"
              : message.kind === "success"
                ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400"
                : "bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* 选择知识库 */}
      {(phase === "selectRepo" || phase === "loadingRepos") && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">
            <FolderOpen size={14} />
            {t("yuqueImport.repoStep")}
          </div>
          {phase === "loadingRepos" ? (
            <div className="flex items-center gap-2 py-4 text-xs text-zinc-500">
              <Loader2 size={15} className="animate-spin" />
              {t("yuqueImport.loadingRepos")}
            </div>
          ) : (
            <div className="max-h-64 space-y-1.5 overflow-y-auto">
              {repos.map((repo) => (
                <button
                  key={`${repo.user}/${repo.slug}`}
                  type="button"
                  onClick={() => void handleSelectRepo(repo)}
                  className="flex w-full items-center gap-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-950/20"
                >
                  <BookOpen size={15} className="shrink-0 text-blue-500" />
                  <span className="min-w-0 flex-1 truncate">{repo.name}</span>
                  <span className="shrink-0 text-[11px] text-zinc-400">{repo.user}/{repo.slug}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 选择文档 */}
      {(phase === "selectDocs" || phase === "loadingDocs") && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">
            <FileText size={14} />
            {t("yuqueImport.docStep", { repo: activeRepo?.name || "" })}
            <button
              type="button"
              onClick={backToRepos}
              disabled={importing}
              className="ml-auto inline-flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-600 disabled:opacity-50"
            >
              <RefreshCw size={12} />
              {t("yuqueImport.backToRepos")}
            </button>
          </div>

          {phase === "loadingDocs" ? (
            <div className="flex items-center gap-2 py-4 text-xs text-zinc-500">
              <Loader2 size={15} className="animate-spin" />
              {t("yuqueImport.loadingDocs")}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="inline-flex items-center gap-1.5 hover:text-blue-600"
                >
                  {docs.every((d) => selectedUrls.has(d.url)) ? (
                    <CheckSquare size={14} className="text-blue-500" />
                  ) : (
                    <Square size={14} />
                  )}
                  {t("yuqueImport.selectAll")}
                </button>
                <span>
                  {t("yuqueImport.selectedCount", { count: selectedCount, total: docs.length })}
                </span>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {docs.map((doc) => (
                  <label
                    key={doc.url}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <input
                      type="checkbox"
                      checked={selectedUrls.has(doc.url)}
                      onChange={() => toggleDoc(doc.url)}
                      className="accent-blue-500"
                    />
                    <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                  </label>
                ))}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-zinc-100 dark:border-zinc-800 pt-3">
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={importing || selectedCount === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {importing ? <Loader2 size={15} className="animate-spin" /> : <CloudDownload size={15} />}
                  {t("yuqueImport.importAction", { count: selectedCount })}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 导入结果 */}
      {result && phase === "done" && (
        <div className="space-y-2 rounded-lg border border-emerald-200 dark:border-emerald-800/40 bg-emerald-50/60 dark:bg-emerald-950/20 p-3">
          <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 size={16} />
            {t("yuqueImport.resultSummary", {
              count: result.count,
              images: result.images,
            })}
          </div>
          {result.failedImages > 0 && (
            <div className="text-xs text-amber-600 dark:text-amber-400">
              {t("yuqueImport.resultImagesFailed", { failed: result.failedImages })}
            </div>
          )}
          {result.errors.length > 0 && (
            <details className="text-xs text-red-600 dark:text-red-400">
              <summary className="cursor-pointer">{t("yuqueImport.resultErrors", { count: result.errors.length })}</summary>
              <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-4">
                {result.errors.slice(0, 50).map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-emerald-200/60 dark:border-emerald-800/40 pt-2">
            <button
              type="button"
              onClick={backToRepos}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              <RefreshCw size={13} />
              {t("yuqueImport.importMore")}
            </button>
            {result.failedImages > 0 && (
              <button
                type="button"
                onClick={handleRetryImages}
                disabled={retryingImages}
                className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-60"
              >
                {retryingImages ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {t("yuqueImport.retryImagesAction")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 错误详情 + 重试 */}
      {phase === "error" && message?.kind === "error" && (
        <div className="space-y-2">
          <div className="flex items-start gap-2 text-xs text-red-500">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{message.text}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRetry}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              <RefreshCw size={13} />
              {t("yuqueImport.retryAction")}
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <RotateCcw size={13} />
              {t("yuqueImport.resetAction")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

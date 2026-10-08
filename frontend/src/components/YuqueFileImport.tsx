import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle, FileUp, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { readYuqueExport, importYuqueFiles, type YuqueFileDocument, type YuqueFileResult } from "@/lib/yuqueFileImport";
import type { Notebook } from "@/types";

interface Props {
  workspaceId: string; workspaceName: string; userId: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onImported: () => void;
  onView: (result: YuqueFileResult) => Promise<void>;
}

export default function YuqueFileImport({ workspaceId, workspaceName, userId, disabled, onBusyChange, onImported, onView }: Props) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [documents, setDocuments] = useState<YuqueFileDocument[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ current: number; total: number; title: string } | null>(null);
  const [result, setResult] = useState<YuqueFileResult | null>(null);
  const rootName = t("yuqueFileImport.rootName");
  const chosen = documents.filter((doc) => selected.has(doc.key));
  const warnings = [...new Set(chosen.flatMap((doc) => doc.warnings))];
  const canRun = !disabled && !!userId && !!workspaceId && !busy;

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    api.getNotebooks(workspaceId).then((items) => { if (!cancelled) setNotebooks(items); }).catch(() => {});
    return () => { cancelled = true; mounted.current = false; };
  }, [workspaceId]);

  const setWorking = (value: boolean) => {
    busyRef.current = value;
    if (mounted.current) setBusy(value);
    onBusyChange(value);
  };

  const read = async (files: File[]) => {
    if (busyRef.current || !canRun || !files.length) return;
    setWorking(true); setError(""); setResult(null); setProgress(null); setDocuments([]);
    try {
      const docs = await readYuqueExport(files);
      if (mounted.current) { setDocuments(docs); setSelected(new Set(docs.map((doc) => doc.key))); }
    } catch (cause) {
      if (mounted.current) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(t(`yuqueFileImport.errors.${message}`, { defaultValue: t("yuqueFileImport.readFailed", { message }) }));
      }
    } finally { setWorking(false); }
  };

  const run = async (retry = false) => {
    if (busyRef.current || !canRun) return;
    const pending = retry ? documents.filter((doc) => result?.failed.some((item) => item.key === doc.key)) : chosen;
    if (!pending.length) return;
    setWorking(true); setError("");
    try {
      const imported = await importYuqueFiles(pending, {
        userId, workspaceId, rootName, targetNotebookId: target || undefined,
        shouldContinue: () => mounted.current,
        onProgress: (current, total, title) => { if (mounted.current) setProgress({ current, total, title }); },
      });
      if (mounted.current) {
        setResult(retry && result ? {
          ...imported, created: result.created + imported.created, skipped: result.skipped + imported.skipped,
          firstNoteId: result.firstNoteId || imported.firstNoteId, notebookId: result.notebookId || imported.notebookId,
        } : imported);
        if (imported.created || imported.skipped) onImported();
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setWorking(false); }
  };

  const toggle = (key: string) => setSelected((old) => {
    const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const bookNames = [...new Set(documents.map((doc) => doc.book))];
  const button = "inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50";
  return <section className="space-y-4" aria-label={t("yuqueFileImport.title")}>
    <div>
      <h5 className="font-semibold text-zinc-900 dark:text-zinc-100">{t("yuqueFileImport.title")}</h5>
      <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{t("yuqueFileImport.description")}</p>
    </div>
    {!documents.length && <>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">{t("yuqueFileImport.supported")}</p>
      <details className="text-xs leading-6 text-zinc-500 dark:text-zinc-400">
        <summary className="cursor-pointer">{t("yuqueFileImport.guideTitle")}</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">{(["guideExport", "guideChoose", "guideNative"] as const).map((key) => <li key={key}>{t(`yuqueFileImport.${key}`)}</li>)}</ol>
      </details>
      <button type="button" className={button} disabled={!canRun} onClick={() => input.current?.click()}><FileUp size={16}/>{t("yuqueFileImport.choose")}</button>
    </>}
    <input ref={input} type="file" className="hidden" accept=".md,.markdown,.zip" multiple aria-label={t("yuqueFileImport.choose")} onChange={(event) => {
      const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ""; void read(files);
    }}/>
    {!!documents.length && !result && <>
      <div className="space-y-2">
        <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("yuqueFileImport.selectBooks")}</p>
        {bookNames.map((book) => {
          const docs = documents.filter((doc) => doc.book === book);
          const count = docs.filter((doc) => selected.has(doc.key)).length;
          return <label key={book} className="flex items-center gap-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
            <input type="checkbox" disabled={busy} checked={count === docs.length} ref={(node) => { if (node) node.indeterminate = count > 0 && count < docs.length; }} onChange={() => setSelected((old) => {
              const next = new Set(old); docs.forEach((doc) => count === docs.length ? next.delete(doc.key) : next.add(doc.key)); return next;
            })}/><span className="min-w-0 flex-1 break-words">{book || t("yuqueFileImport.looseFiles")}</span><span>{t("yuqueFileImport.docCount", { count: docs.length })}</span>
          </label>;
        })}
        <details>
          <summary className="cursor-pointer text-xs text-indigo-600 dark:text-indigo-400">{t("yuqueFileImport.selectSome")}</summary>
          <div className="mt-2 max-h-60 space-y-1 overflow-y-auto">{documents.map((doc) => <label key={doc.key} className="flex items-start gap-2 py-1 text-xs text-zinc-600 dark:text-zinc-300">
            <input type="checkbox" className="mt-0.5" disabled={busy} checked={selected.has(doc.key)} onChange={() => toggle(doc.key)}/><span className="break-all">{[...doc.path, doc.title].join(" / ")}</span>
          </label>)}</div>
        </details>
      </div>
      <div className="space-y-2 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-800/50">
        <p>{t("yuqueFileImport.ready", { count: chosen.length })}</p>
        <label className="block text-xs text-zinc-600 dark:text-zinc-300">{t("yuqueFileImport.destination")}: {workspaceName}
          <select value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)} className="mt-1 block w-full rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900">
            <option value="">{rootName}</option>
            {notebooks.filter((notebook) => (!notebook.permission || ["write", "manage"].includes(notebook.permission)) && notebook.myRole !== "viewer").map((notebook) => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}
          </select>
        </label>
        <p className="text-xs leading-5 text-zinc-500">{t("yuqueFileImport.duplicateHint")}</p>
      </div>
      {warnings.map((warning) => <p key={warning} className="text-xs leading-5 text-amber-700 dark:text-amber-400">{t(`yuqueFileImport.warnings.${warning}`)}</p>)}
      <div className="flex flex-wrap gap-3">
        <button type="button" className={button} disabled={!canRun || !chosen.length} onClick={() => void run()}>{t("yuqueFileImport.start", { count: chosen.length })}</button>
        <button type="button" disabled={!canRun} className="text-xs text-zinc-500" onClick={() => input.current?.click()}>{t("yuqueFileImport.chooseAgain")}</button>
      </div>
    </>}
    {busy && <div role="status" aria-live="polite" className="space-y-2 text-sm text-zinc-600 dark:text-zinc-300">
      <p className="flex items-center gap-2"><Loader2 size={16} className="animate-spin"/>{progress ? t("yuqueFileImport.progress", { current: progress.current, total: progress.total }) : t("yuqueFileImport.reading")}</p>
      {progress && <><progress className="w-full" value={progress.current} max={progress.total}/><p className="break-words text-xs">{progress.title}</p></>}
      <p className="text-xs">{t("yuqueFileImport.stay")}</p>
    </div>}
    {result && !busy && <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-700" role="status">
      <p className="flex items-center gap-2 font-medium"><CheckCircle size={16}/>{t("yuqueFileImport.result", { created: result.created, skipped: result.skipped })}</p>
      {!!result.failed.length && <details><summary className="cursor-pointer text-sm text-amber-700 dark:text-amber-400">{t("yuqueFileImport.failed", { count: result.failed.length })}</summary><ul className="mt-2 space-y-1 text-xs">{result.failed.map((item) => <li key={item.key}>{item.title}: {item.message}</li>)}</ul></details>}
      {warnings.map((warning) => <p key={warning} className="text-xs text-amber-700 dark:text-amber-400">{t(`yuqueFileImport.warnings.${warning}`)}</p>)}
      <div className="flex flex-wrap gap-3">
        {result.firstNoteId && <button type="button" className={button} disabled={!canRun} onClick={() => { void onView(result).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }}>{t("yuqueFileImport.view")}</button>}
        {!!result.failed.length && <button type="button" className="text-sm text-indigo-600" disabled={!canRun} onClick={() => void run(true)}>{t("yuqueFileImport.retry")}</button>}
        <button type="button" disabled={!canRun} className="text-xs text-zinc-500" onClick={() => { setDocuments([]); setResult(null); setError(""); }}>{t("yuqueFileImport.other")}</button>
      </div>
    </div>}
    {error && <p role="alert" className="break-words text-sm text-red-600 dark:text-red-400">{error}</p>}
  </section>;
}

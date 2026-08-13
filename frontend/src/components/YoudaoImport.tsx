import React, { useCallback, useMemo, useRef, useState } from "react";
import { AlertCircle, BookOpen, CloudUpload, FolderOpen, Loader2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import type { ImportProgress } from "@/lib/importService";
import {
  formatFileSize,
  runYoudaoImport,
  scanYoudaoExport,
  type YoudaoScanResult,
} from "@/lib/youdaoNoteService";
import { useAppActions } from "@/store/AppContext";

type Phase = "idle" | "scanning" | "ready" | "importing" | "done" | "error";
type StatusMessage =
  | { key: string; values?: Record<string, string | number> }
  | { raw: string }
  | null;

export default function YoudaoImport() {
  const { t } = useTranslation();
  const actions = useAppActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [scan, setScan] = useState<YoudaoScanResult | null>(null);
  const [rootName, setRootName] = useState(() => t("youdaoImport.defaultRootName"));
  const [status, setStatus] = useState<StatusMessage>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const statusText = useMemo(() => {
    if (!status) return "";
    if ("raw" in status) return status.raw;
    return t(status.key, status.values);
  }, [status, t]);

  const progressText = useMemo(() => {
    if (!progress) return "";
    if (progress.phase === "reading") {
      return progress.current <= 0
        ? t("youdaoImport.parsingFiles")
        : t("youdaoImport.parsingProgress", {
            current: progress.current,
            total: progress.total,
          });
    }
    if (progress.phase === "uploading") {
      return t("youdaoImport.uploadingProgress", {
        current: progress.current,
        total: progress.total,
      });
    }
    if (progress.phase === "done") return t("youdaoImport.doneProgress");
    if (progress.phase === "error") return t("youdaoImport.errorProgress");
    return progress.message;
  }, [progress, t]);

  const reset = useCallback(() => {
    setPhase("idle");
    setScan(null);
    setRootName(t("youdaoImport.defaultRootName"));
    setStatus(null);
    setProgress(null);
    setErrors([]);
    if (inputRef.current) inputRef.current.value = "";
  }, [t]);

  const pick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!event.target.files?.length) return;
      setPhase("scanning");
      setStatus({ key: "youdaoImport.scanning" });
      try {
        const value = scanYoudaoExport(event.target.files);
        setScan(value);
        setPhase("ready");
        setStatus({
          key: "youdaoImport.scanComplete",
          values: {
            notes: value.stats.notes,
            attachments: value.stats.attachments,
          },
        });
      } catch (error) {
        setPhase("error");
        setStatus({ raw: (error as Error).message });
      }
    },
    [],
  );

  const toggle = useCallback(
    (path: string) =>
      setScan((current) =>
        current
          ? {
              ...current,
              entries: current.entries.map((entry) =>
                entry.relPath === path ? { ...entry, selected: !entry.selected } : entry,
              ),
            }
          : current,
      ),
    [],
  );

  const start = useCallback(async () => {
    if (!scan) return;
    setPhase("importing");
    setStatus({ key: "youdaoImport.importing" });
    setErrors([]);
    setProgress(null);
    try {
      const value = await runYoudaoImport(scan, { rootName, onProgress: setProgress });
      setErrors(value.errors);
      setPhase(value.errors.length ? "error" : "done");
      setStatus(
        value.errors.length
          ? {
              key: "youdaoImport.importedWithErrors",
              values: { notes: value.noteCount, errors: value.errors.length },
            }
          : {
              key: "youdaoImport.importSuccess",
              values: {
                notes: value.noteCount,
                attachments: value.attachmentCount,
              },
            },
      );
      try {
        actions.setNotebooks(await api.getNotebooks());
        actions.refreshNotes();
      } catch {
        /* next refresh */
      }
    } catch (error) {
      setPhase("error");
      setStatus({ raw: (error as Error).message || t("youdaoImport.importFailed") });
    }
  }, [actions, rootName, scan, t]);

  const entries = useMemo(
    () => scan?.entries.filter((entry) => entry.kind !== "skipped") || [],
    [scan],
  );
  const selected = entries.filter((entry) => entry.selected).length;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <BookOpen size={18} className="text-rose-500" />
        <div>
          <h4 className="font-semibold">{t("youdaoImport.title")}</h4>
          <p className="text-xs text-zinc-500">{t("youdaoImport.description")}</p>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-800/30">
        {phase === "idle" && (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              {...({ webkitdirectory: "", directory: "" } as any)}
              className="hidden"
              onChange={pick}
            />
            <button
              onClick={() => inputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-rose-500 px-4 py-2.5 text-sm font-medium text-white"
            >
              <FolderOpen size={16} />
              {t("youdaoImport.chooseDirectory")}
            </button>
          </>
        )}

        {phase === "scanning" && (
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
            <Loader2 size={16} className="animate-spin" />
            {statusText}
          </p>
        )}

        {scan && phase !== "scanning" && (
          <div className="space-y-3">
            <label className="block text-xs text-zinc-500">
              {t("youdaoImport.rootNotebookName")}
              <input
                value={rootName}
                onChange={(event) => setRootName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>

            <div className="grid grid-cols-3 gap-2 text-xs">
              <Stat value={scan.stats.notes} label={t("youdaoImport.notes")} />
              <Stat value={scan.stats.attachments} label={t("youdaoImport.attachments")} />
              <Stat value={formatFileSize(scan.stats.totalBytes)} label={t("youdaoImport.totalSize")} />
            </div>

            <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/50">
              {entries.map((entry) => (
                <label
                  key={entry.relPath}
                  className="flex gap-2 border-b border-zinc-100 px-3 py-2 last:border-0 dark:border-zinc-800"
                >
                  <input
                    type="checkbox"
                    checked={entry.selected}
                    disabled={phase === "importing"}
                    onChange={() => toggle(entry.relPath)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{entry.fileName}</span>
                    <span className="block truncate text-[10px] text-zinc-400">
                      {entry.notebookPath.join(" / ") || t("youdaoImport.rootDirectory")}
                    </span>
                  </span>
                  <span className="text-[10px] text-zinc-400">{formatFileSize(entry.size)}</span>
                </label>
              ))}
            </div>

            {progress && phase === "importing" && (
              <p className="rounded-lg bg-rose-50 p-3 text-xs text-rose-700 dark:bg-rose-500/10">
                {progressText} · {progress.current}/{progress.total}
              </p>
            )}

            {statusText && (
              <p
                className={`flex gap-2 text-sm ${
                  phase === "error" ? "text-red-600" : "text-zinc-600"
                }`}
              >
                {phase === "importing" && <Loader2 size={15} className="animate-spin" />}
                {phase === "error" && <AlertCircle size={15} />}
                <span>{statusText}</span>
              </p>
            )}

            {!!errors.length && (
              <ul className="max-h-32 overflow-y-auto rounded-lg bg-red-50 p-2 text-[11px] text-red-600">
                {errors.map((error, index) => (
                  <li key={`${error}-${index}`}>{error}</li>
                ))}
              </ul>
            )}

            <div className="flex gap-2">
              <button
                onClick={reset}
                disabled={phase === "importing"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-200 px-4 py-2.5 text-sm"
              >
                <RotateCcw size={15} />
                {t("youdaoImport.chooseAgain")}
              </button>
              <button
                onClick={start}
                disabled={phase === "importing" || !selected || phase === "done"}
                className="flex flex-[2] items-center justify-center gap-2 rounded-lg bg-rose-500 px-4 py-2.5 text-sm font-medium text-white disabled:bg-zinc-300"
              >
                <CloudUpload size={16} />
                {phase === "importing"
                  ? t("youdaoImport.importingAction")
                  : phase === "done"
                    ? t("youdaoImport.importDone")
                    : t("youdaoImport.importSelected", { count: selected })}
              </button>
            </div>
          </div>
        )}

        {!scan && phase === "error" && (
          <>
            <p className="flex gap-2 text-sm text-red-600">
              <AlertCircle size={15} />
              {statusText}
            </p>
            <button onClick={reset} className="mt-3 text-xs text-rose-600">
              {t("youdaoImport.backToChoose")}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="rounded-lg bg-zinc-100 p-2 dark:bg-zinc-800">
      <strong className="block text-sm">{value}</strong>
      <span className="text-[10px] text-zinc-500">{label}</span>
    </div>
  );
}

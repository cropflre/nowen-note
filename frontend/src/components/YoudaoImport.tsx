import React, { useCallback, useMemo, useRef, useState } from "react";
import { AlertCircle, BookOpen, CloudUpload, FolderOpen, Loader2, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import type { ImportProgress } from "@/lib/importService";
import { formatFileSize, runYoudaoImport, scanYoudaoExport, type YoudaoScanResult } from "@/lib/youdaoNoteService";
import { useAppActions } from "@/store/AppContext";

type Phase = "idle" | "scanning" | "ready" | "importing" | "done" | "error";

export default function YoudaoImport() {
  const actions = useAppActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [scan, setScan] = useState<YoudaoScanResult | null>(null);
  const [rootName, setRootName] = useState("有道云笔记");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const reset = useCallback(() => { setPhase("idle"); setScan(null); setRootName("有道云笔记"); setMessage(""); setProgress(null); setErrors([]); if (inputRef.current) inputRef.current.value = ""; }, []);
  const pick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    setPhase("scanning"); setMessage("正在扫描有道云笔记导出目录…");
    try { const value = scanYoudaoExport(e.target.files); setScan(value); setPhase("ready"); setMessage(`扫描完成：${value.stats.notes} 篇笔记、${value.stats.attachments} 个附件`); }
    catch (error) { setPhase("error"); setMessage((error as Error).message); }
  }, []);
  const toggle = useCallback((path: string) => setScan((current) => current ? { ...current, entries: current.entries.map((entry) => entry.relPath === path ? { ...entry, selected: !entry.selected } : entry) } : current), []);
  const start = useCallback(async () => {
    if (!scan) return;
    setPhase("importing"); setMessage("正在导入有道云笔记…"); setErrors([]);
    try {
      const value = await runYoudaoImport(scan, { rootName, onProgress: setProgress });
      setErrors(value.errors); setPhase(value.errors.length ? "error" : "done");
      setMessage(value.errors.length ? `已导入 ${value.noteCount} 篇，存在 ${value.errors.length} 条错误` : `成功导入 ${value.noteCount} 篇笔记和 ${value.attachmentCount} 个附件`);
      try { actions.setNotebooks(await api.getNotebooks()); actions.refreshNotes(); } catch { /* next refresh */ }
    } catch (error) { setPhase("error"); setMessage((error as Error).message || "导入失败"); }
  }, [actions, rootName, scan]);
  const entries = useMemo(() => scan?.entries.filter((entry) => entry.kind !== "skipped") || [], [scan]);
  const selected = entries.filter((entry) => entry.selected).length;

  return <section className="space-y-3">
    <div className="flex items-center gap-2"><BookOpen size={18} className="text-rose-500"/><div><h4 className="font-semibold">有道云笔记目录导入</h4><p className="text-xs text-zinc-500">选择有道云笔记批量导出的完整文件夹。</p></div></div>
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-800/30">
      {phase === "idle" && <><input ref={inputRef} type="file" multiple {...({ webkitdirectory: "", directory: "" } as any)} className="hidden" onChange={pick}/><button onClick={() => inputRef.current?.click()} className="flex w-full items-center justify-center gap-2 rounded-lg bg-rose-500 px-4 py-2.5 text-sm font-medium text-white"><FolderOpen size={16}/>选择有道导出目录</button></>}
      {phase === "scanning" && <p className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500"><Loader2 size={16} className="animate-spin"/>{message}</p>}
      {scan && phase !== "scanning" && <div className="space-y-3">
        <label className="block text-xs text-zinc-500">最外层笔记本名称<input value={rootName} onChange={(e) => setRootName(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"/></label>
        <div className="grid grid-cols-3 gap-2 text-xs"><Stat n={scan.stats.notes} t="笔记"/><Stat n={scan.stats.attachments} t="附件"/><Stat n={formatFileSize(scan.stats.totalBytes)} t="总大小"/></div>
        <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/50">{entries.map((entry) => <label key={entry.relPath} className="flex gap-2 border-b border-zinc-100 px-3 py-2 last:border-0 dark:border-zinc-800"><input type="checkbox" checked={entry.selected} disabled={phase === "importing"} onChange={() => toggle(entry.relPath)}/><span className="min-w-0 flex-1"><span className="block truncate text-xs">{entry.fileName}</span><span className="block truncate text-[10px] text-zinc-400">{entry.notebookPath.join(" / ") || "根目录"}</span></span><span className="text-[10px] text-zinc-400">{formatFileSize(entry.size)}</span></label>)}</div>
        {progress && phase === "importing" && <p className="rounded-lg bg-rose-50 p-3 text-xs text-rose-700 dark:bg-rose-500/10">{progress.message} · {progress.current}/{progress.total}</p>}
        {message && <p className={`flex gap-2 text-sm ${phase === "error" ? "text-red-600" : "text-zinc-600"}`}>{phase === "importing" && <Loader2 size={15} className="animate-spin"/>}{phase === "error" && <AlertCircle size={15}/>}<span>{message}</span></p>}
        {!!errors.length && <ul className="max-h-32 overflow-y-auto rounded-lg bg-red-50 p-2 text-[11px] text-red-600">{errors.map((error, i) => <li key={`${error}-${i}`}>{error}</li>)}</ul>}
        <div className="flex gap-2"><button onClick={reset} disabled={phase === "importing"} className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-200 px-4 py-2.5 text-sm"><RotateCcw size={15}/>重新选择</button><button onClick={start} disabled={phase === "importing" || !selected || phase === "done"} className="flex flex-[2] items-center justify-center gap-2 rounded-lg bg-rose-500 px-4 py-2.5 text-sm font-medium text-white disabled:bg-zinc-300"><CloudUpload size={16}/>{phase === "importing" ? "正在导入" : phase === "done" ? "导入完成" : `导入 ${selected} 项`}</button></div>
      </div>}
      {!scan && phase === "error" && <><p className="flex gap-2 text-sm text-red-600"><AlertCircle size={15}/>{message}</p><button onClick={reset} className="mt-3 text-xs text-rose-600">返回重新选择</button></>}
    </div>
  </section>;
}
function Stat({ n, t }: { n: number | string; t: string }) { return <div className="rounded-lg bg-zinc-100 p-2 dark:bg-zinc-800"><strong className="block text-sm">{n}</strong><span className="text-[10px] text-zinc-500">{t}</span></div>; }

import React, { useCallback, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle, CloudUpload, FileArchive, FolderOpen, Loader2, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import type { ImportProgress } from "@/lib/importService";
import {
  formatObsidianFileSize, runObsidianImport, scanObsidianFolder, scanObsidianZip,
  type ObsidianImportResult, type ObsidianScanResult,
} from "@/lib/obsidianImportService";
import { useAppActions } from "@/store/AppContext";

type Phase = "idle" | "scanning" | "ready" | "importing" | "done" | "error";

export default function ObsidianImport() {
  const actions = useAppActions();
  const folderRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [scan, setScan] = useState<ObsidianScanResult | null>(null);
  const [rootName, setRootName] = useState("");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ObsidianImportResult | null>(null);

  const reset = useCallback(() => {
    setPhase("idle"); setScan(null); setRootName(""); setMessage(""); setProgress(null); setResult(null);
    if (folderRef.current) folderRef.current.value = "";
    if (zipRef.current) zipRef.current.value = "";
  }, []);

  const accept = useCallback((value: ObsidianScanResult) => {
    setScan(value); setRootName(value.rootFolderName); setResult(null); setPhase("ready");
    setMessage(`扫描完成：${value.stats.notes} 篇笔记、${value.stats.folders} 个目录、${value.stats.attachments} 个附件`);
  }, []);

  const pickFolder = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    setPhase("scanning"); setMessage("正在扫描 Obsidian Vault…");
    try { accept(scanObsidianFolder(e.target.files)); }
    catch (error) { setPhase("error"); setMessage((error as Error).message); }
  }, [accept]);

  const pickZip = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setPhase("scanning"); setMessage("正在读取 Obsidian ZIP…");
    try { accept(await scanObsidianZip(file)); }
    catch (error) { setPhase("error"); setMessage((error as Error).message); }
  }, [accept]);

  const toggle = useCallback((path?: string) => setScan((current) => {
    if (!current) return current;
    const notes = current.entries.filter((entry) => entry.kind === "note");
    const next = path ? undefined : !notes.every((entry) => entry.selected);
    return { ...current, entries: current.entries.map((entry) => entry.kind !== "note" ? entry : { ...entry, selected: path ? entry.vaultPath === path ? !entry.selected : entry.selected : !!next }) };
  }), []);

  const start = useCallback(async () => {
    if (!scan) return;
    setPhase("importing"); setResult(null); setMessage("正在导入 Obsidian Vault…");
    try {
      const imported = await runObsidianImport(scan, { rootName, onProgress: setProgress });
      setResult(imported); setPhase(imported.errors.length ? "error" : "done");
      setMessage(imported.errors.length ? `已导入 ${imported.noteCount} 篇，存在 ${imported.errors.length} 条错误` : `成功导入 ${imported.noteCount} 篇笔记和 ${imported.attachmentCount} 个附件`);
      try { actions.setNotebooks(await api.getNotebooks()); actions.refreshNotes(); } catch { /* next refresh */ }
    } catch (error) { setPhase("error"); setMessage((error as Error).message || "导入失败"); }
  }, [actions, rootName, scan]);

  const notes = useMemo(() => scan?.entries.filter((entry) => entry.kind === "note") || [], [scan]);
  const selected = notes.filter((entry) => entry.selected).length;
  const report = result ? [...result.errors, ...result.warnings, ...result.missingReferences, ...result.ambiguousReferences] : [];

  return <section className="space-y-3">
    <div><h4 className="font-semibold text-zinc-900 dark:text-zinc-100">Obsidian Vault 导入</h4>
      <p className="text-xs text-zinc-500">保留目录层级，并迁移图片、视频、音频、PDF 和其他本地附件。</p></div>
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-800/30">
      {phase === "idle" && <div className="grid gap-2 sm:grid-cols-2">
        <input ref={folderRef} type="file" multiple {...({ webkitdirectory: "", directory: "" } as any)} className="hidden" onChange={pickFolder} />
        <input ref={zipRef} type="file" accept=".zip,application/zip" className="hidden" onChange={pickZip} />
        <button onClick={() => folderRef.current?.click()} className="flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white"><FolderOpen size={16}/>选择 Vault 文件夹</button>
        <button onClick={() => zipRef.current?.click()} className="flex items-center justify-center gap-2 rounded-lg border border-violet-200 bg-white px-4 py-2.5 text-sm font-medium text-violet-700 dark:bg-zinc-900"><FileArchive size={16}/>选择 Vault ZIP</button>
      </div>}
      {phase === "scanning" && <Status spin text={message} />}
      {scan && phase !== "scanning" && <div className="space-y-3">
        <label className="block text-xs text-zinc-500">最外层笔记本名称
          <input value={rootName} onChange={(e) => setRootName(e.target.value)} disabled={phase === "importing"} className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200" />
        </label>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <Stat n={scan.stats.notes} label="笔记"/><Stat n={scan.stats.folders} label="目录"/><Stat n={scan.stats.attachments} label="附件"/>
          <Stat n={scan.stats.images} label="图片"/><Stat n={scan.stats.videos + scan.stats.pdfs} label="视频 / PDF"/><Stat n={formatObsidianFileSize(scan.stats.totalBytes)} label="总大小"/>
        </div>
        <div className="flex justify-between text-xs"><button onClick={() => toggle()} className="font-medium text-violet-600">{selected === notes.length ? "取消全选" : "全选笔记"}</button><span className="text-zinc-400">{selected} / {notes.length}</span></div>
        <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/50">
          {notes.map((entry) => <label key={entry.vaultPath} className="flex cursor-pointer gap-2 border-b border-zinc-100 px-3 py-2 last:border-0 dark:border-zinc-800">
            <input type="checkbox" checked={entry.selected} disabled={phase === "importing"} onChange={() => toggle(entry.vaultPath)} />
            <span className="min-w-0 flex-1"><span className="block truncate text-xs text-zinc-700 dark:text-zinc-200">{entry.fileName}</span><span className="block truncate text-[10px] text-zinc-400">{entry.vaultPath}</span></span>
            <span className="text-[10px] text-zinc-400">{formatObsidianFileSize(entry.size)}</span>
          </label>)}
          {!notes.length && <p className="p-6 text-center text-xs text-zinc-400">没有找到 Markdown 笔记</p>}
        </div>
        {progress && phase === "importing" && <div className="rounded-lg bg-violet-50 p-3 text-xs text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"><div className="flex justify-between"><span className="truncate">{progress.message}</span><span>{progress.current}/{progress.total}</span></div></div>}
        {message && <Status spin={phase === "importing"} ok={phase === "done"} error={phase === "error"} text={message}/>} 
        {!!report.length && <details className="text-xs text-amber-700"><summary className="cursor-pointer font-medium">导入报告（{report.length}）</summary><ul className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded-lg bg-amber-50 p-2 dark:bg-amber-500/10">{report.map((line, i) => <li key={`${line}-${i}`} className="break-all">{line}</li>)}</ul></details>}
        <div className="flex gap-2"><button onClick={reset} disabled={phase === "importing"} className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-200 px-4 py-2.5 text-sm"><RotateCcw size={15}/>重新选择</button>
          <button onClick={start} disabled={phase === "importing" || !selected || phase === "done"} className="flex flex-[2] items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white disabled:bg-zinc-300"><CloudUpload size={16}/>{phase === "importing" ? "正在导入" : phase === "done" ? "导入完成" : `导入 ${selected} 篇`}</button></div>
      </div>}
      {!scan && phase === "error" && <><Status error text={message}/><button onClick={reset} className="mt-3 text-xs font-medium text-violet-600">返回重新选择</button></>}
    </div>
  </section>;
}

function Stat({ n, label }: { n: number | string; label: string }) { return <div className="rounded-lg bg-zinc-100 p-2 dark:bg-zinc-800"><strong className="block text-sm">{n}</strong><span className="text-[10px] text-zinc-500">{label}</span></div>; }
function Status({ text, spin, ok, error }: { text: string; spin?: boolean; ok?: boolean; error?: boolean }) { return <div className={`flex items-start gap-2 py-2 text-sm ${error ? "text-red-600" : "text-zinc-600 dark:text-zinc-300"}`}>{spin ? <Loader2 size={15} className="mt-0.5 animate-spin"/> : ok ? <CheckCircle size={15} className="mt-0.5 text-emerald-500"/> : error ? <AlertCircle size={15} className="mt-0.5"/> : null}<span>{text}</span></div>; }

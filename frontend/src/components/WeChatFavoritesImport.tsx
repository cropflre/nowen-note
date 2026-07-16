import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CalendarDays,
  CheckCircle,
  FileArchive,
  Loader2,
  RefreshCw,
  Tags,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, getCurrentWorkspace } from "@/lib/api";
import { useAppActions } from "@/store/AppContext";
import {
  importWeChatFavoritesPackage,
  preflightWeChatFavoritesPackage,
  type WeChatDuplicateStrategy,
  type WeChatFavoritesImportConfig,
  type WeChatFavoritesImportReport,
} from "@/lib/wechatFavoritesImportService";

type Phase = "idle" | "scanning" | "ready" | "importing" | "done" | "error";

const TYPE_LABELS: Record<string, { zh: string; en: string }> = {
  text: { zh: "文本", en: "Text" },
  image: { zh: "图片", en: "Images" },
  voice: { zh: "语音", en: "Voice" },
  video: { zh: "视频", en: "Video" },
  link: { zh: "链接", en: "Links" },
  location: { zh: "位置", en: "Locations" },
  music: { zh: "音乐", en: "Music" },
  file: { zh: "文件", en: "Files" },
  chatHistory: { zh: "聊天记录", en: "Chat history" },
  product: { zh: "商品", en: "Products" },
  note: { zh: "笔记", en: "Notes" },
  channels: { zh: "视频号", en: "Channels" },
  emoji: { zh: "表情", en: "Emoji" },
  other: { zh: "其他", en: "Other" },
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const DEFAULT_CONFIG: WeChatFavoritesImportConfig = {
  rootNotebookName: "微信收藏",
  groupByYear: true,
  preserveTags: true,
  continueOnMissingMedia: true,
  duplicateStrategy: "skip",
  selectedTypes: [],
};

export default function WeChatFavoritesImport() {
  const { i18n } = useTranslation();
  const zh = i18n.language.toLowerCase().startsWith("zh");
  const actions = useAppActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [config, setConfig] = useState<WeChatFavoritesImportConfig>(DEFAULT_CONFIG);
  const [preflight, setPreflight] = useState<WeChatFavoritesImportReport | null>(null);
  const [report, setReport] = useState<WeChatFavoritesImportReport | null>(null);
  const [message, setMessage] = useState("");
  const [showDetails, setShowDetails] = useState(false);

  const workspaceId = getCurrentWorkspace();

  useEffect(() => {
    if (phase !== "importing") return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase]);

  const strings = zh ? {
    title: "微信收藏导入",
    description: "导入 WeChatDataAnalysis 导出的微信收藏 JSON ZIP，保留文本、媒体、来源、时间和标签。",
    choose: "选择微信收藏 ZIP",
    scanning: "服务端正在安全扫描 ZIP 并识别收藏数据…",
    importing: "正在导入收藏、附件和标签，请勿关闭页面…",
    rescan: "重新预检",
    import: "开始导入",
    reset: "重新选择",
    root: "根笔记本名称",
    byYear: "按收藏年份创建子笔记本",
    tags: "保留微信收藏标签",
    missing: "媒体缺失时继续导入正文",
    duplicate: "重复数据处理",
    selectTypes: "导入类型",
    report: "导入报告",
    details: "失败与警告明细",
    noFile: "请先选择 ZIP 文件",
    success: "微信收藏导入完成",
    partial: "导入完成，但存在部分失败或警告",
    currentScope: workspaceId ? "当前工作区" : "个人空间",
  } : {
    title: "WeChat Favorites Import",
    description: "Import a WeChatDataAnalysis favorites JSON ZIP with text, media, source metadata, timestamps and tags.",
    choose: "Choose favorites ZIP",
    scanning: "The server is safely scanning the ZIP and detecting favorites…",
    importing: "Importing favorites, attachments and tags. Do not close this page…",
    rescan: "Run preflight again",
    import: "Start import",
    reset: "Choose another file",
    root: "Root notebook name",
    byYear: "Create child notebooks by favorite year",
    tags: "Preserve WeChat favorite tags",
    missing: "Continue when local media is missing",
    duplicate: "Duplicate handling",
    selectTypes: "Types to import",
    report: "Import report",
    details: "Failure and warning details",
    noFile: "Choose a ZIP file first",
    success: "WeChat favorites import completed",
    partial: "Import completed with failures or warnings",
    currentScope: workspaceId ? "Current workspace" : "Personal space",
  };

  const typeEntries = useMemo(
    () => Object.entries(preflight?.stats.types || {}).sort((a, b) => b[1] - a[1]),
    [preflight],
  );

  const runPreflight = async (targetFile = file, nextConfig = config) => {
    if (!targetFile) {
      setMessage(strings.noFile);
      return;
    }
    setPhase("scanning");
    setMessage(strings.scanning);
    setReport(null);
    try {
      const result = await preflightWeChatFavoritesPackage(targetFile, nextConfig, workspaceId);
      setPreflight(result);
      const allTypes = Object.keys(result.stats.types || {});
      if (nextConfig.selectedTypes.length === 0 && allTypes.length > 0) {
        setConfig((current) => ({ ...current, selectedTypes: allTypes }));
      }
      setPhase("ready");
      setMessage(zh
        ? `识别到 ${result.counts.total} 条收藏，${result.stats.mediaAvailable}/${result.stats.mediaReferences} 个媒体引用可用。`
        : `Detected ${result.counts.total} favorites; ${result.stats.mediaAvailable}/${result.stats.mediaReferences} media references are available.`);
    } catch (error) {
      setPhase("error");
      setMessage((error as Error)?.message || String(error));
      setPreflight(null);
    }
  };

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] || null;
    if (!selected) return;
    setFile(selected);
    setConfig(DEFAULT_CONFIG);
    setPreflight(null);
    setReport(null);
    setShowDetails(false);
    await runPreflight(selected, DEFAULT_CONFIG);
  };

  const handleImport = async () => {
    if (!file) return;
    setPhase("importing");
    setMessage(strings.importing);
    setReport(null);
    try {
      const result = await importWeChatFavoritesPackage(file, config, workspaceId);
      setReport(result);
      setPhase(result.counts.failed > 0 ? "error" : "done");
      setMessage(result.counts.failed > 0 || result.counts.partial > 0 ? strings.partial : strings.success);
      try {
        const notebooks = await api.getNotebooks();
        actions.setNotebooks(notebooks);
        actions.refreshNotes();
      } catch { /* import result remains valid even if refresh fails */ }
    } catch (error) {
      setPhase("error");
      setMessage((error as Error)?.message || String(error));
    }
  };

  const toggleType = (type: string) => {
    setConfig((current) => ({
      ...current,
      selectedTypes: current.selectedTypes.includes(type)
        ? current.selectedTypes.filter((item) => item !== type)
        : [...current.selectedTypes, type],
    }));
  };

  const setStrategy = (duplicateStrategy: WeChatDuplicateStrategy) => {
    setConfig((current) => ({ ...current, duplicateStrategy }));
  };

  const reset = () => {
    setFile(null);
    setPreflight(null);
    setReport(null);
    setConfig(DEFAULT_CONFIG);
    setMessage("");
    setPhase("idle");
    setShowDetails(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <section className="rounded-xl border border-emerald-200/70 bg-emerald-50/30 p-4 dark:border-emerald-900/40 dark:bg-emerald-500/5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
          <FileArchive size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{strings.title}</h4>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{strings.description}</p>
          <span className="mt-1.5 inline-flex rounded-md bg-white/80 px-2 py-0.5 text-[11px] text-emerald-700 dark:bg-zinc-900/60 dark:text-emerald-300">
            {strings.currentScope}
          </span>
        </div>
      </div>

      {phase === "idle" && (
        <div className="mt-4">
          <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={handleFile} />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
          >
            <Upload size={16} /> {strings.choose}
          </button>
        </div>
      )}

      {file && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">{file.name}</p>
              <p className="text-[11px] text-zinc-400">{formatBytes(file.size)}</p>
            </div>
            {phase !== "importing" && (
              <button type="button" onClick={reset} className="text-xs text-zinc-500 hover:text-red-500">{strings.reset}</button>
            )}
          </div>

          {(phase === "scanning" || phase === "importing") && (
            <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:border-blue-900/50 dark:bg-blue-500/10 dark:text-blue-300">
              <Loader2 size={14} className="animate-spin" /> {message}
            </div>
          )}

          {phase === "error" && !report && message && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-500/10 dark:text-red-300">
              <AlertCircle size={14} className="mt-0.5 shrink-0" /> <span className="break-all">{message}</span>
            </div>
          )}

          {preflight && phase !== "scanning" && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label={zh ? "收藏" : "Favorites"} value={preflight.counts.total} />
                <Stat label={zh ? "本地媒体" : "Local media"} value={`${preflight.stats.mediaAvailable}/${preflight.stats.mediaReferences}`} />
                <Stat label={zh ? "重复来源" : "Existing"} value={preflight.counts.duplicateExisting} />
                <Stat label={zh ? "媒体体积" : "Media size"} value={formatBytes(preflight.stats.mediaBytes)} />
              </div>

              <div className="grid gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/50 sm:grid-cols-2">
                <label className="text-xs text-zinc-600 dark:text-zinc-300">
                  <span className="mb-1 block font-medium">{strings.root}</span>
                  <input
                    value={config.rootNotebookName}
                    maxLength={60}
                    disabled={phase === "importing"}
                    onChange={(event) => setConfig((current) => ({ ...current, rootNotebookName: event.target.value }))}
                    className="w-full rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </label>
                <div className="text-xs text-zinc-600 dark:text-zinc-300">
                  <span className="mb-1 block font-medium">{strings.duplicate}</span>
                  <div className="grid grid-cols-3 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700">
                    {(["skip", "update", "duplicate"] as WeChatDuplicateStrategy[]).map((strategy) => (
                      <button
                        key={strategy}
                        type="button"
                        disabled={phase === "importing"}
                        onClick={() => setStrategy(strategy)}
                        className={`px-2 py-2 text-[11px] ${config.duplicateStrategy === strategy ? "bg-emerald-600 text-white" : "bg-white text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"}`}
                      >
                        {zh
                          ? strategy === "skip" ? "跳过" : strategy === "update" ? "更新" : "副本"
                          : strategy === "skip" ? "Skip" : strategy === "update" ? "Update" : "Copy"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid gap-2 text-xs text-zinc-600 dark:text-zinc-300 sm:grid-cols-3">
                <Toggle checked={config.groupByYear} disabled={phase === "importing"} icon={<CalendarDays size={14} />} label={strings.byYear} onChange={(value) => setConfig((current) => ({ ...current, groupByYear: value }))} />
                <Toggle checked={config.preserveTags} disabled={phase === "importing"} icon={<Tags size={14} />} label={strings.tags} onChange={(value) => setConfig((current) => ({ ...current, preserveTags: value }))} />
                <Toggle checked={config.continueOnMissingMedia} disabled={phase === "importing"} icon={<AlertTriangle size={14} />} label={strings.missing} onChange={(value) => setConfig((current) => ({ ...current, continueOnMissingMedia: value }))} />
              </div>

              {typeEntries.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">{strings.selectTypes}</p>
                  <div className="flex flex-wrap gap-2">
                    {typeEntries.map(([type, count]) => {
                      const checked = config.selectedTypes.includes(type);
                      const label = TYPE_LABELS[type]?.[zh ? "zh" : "en"] || type;
                      return (
                        <button
                          type="button"
                          key={type}
                          disabled={phase === "importing"}
                          onClick={() => toggleType(type)}
                          className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${checked ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "border-zinc-200 bg-white text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"}`}
                        >
                          {checked ? "✓ " : ""}{label} {count}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {(preflight.warnings.length > 0 || preflight.stats.mediaMissing > 0) && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-300">
                  <p>{zh ? `预检发现 ${preflight.stats.mediaMissing} 个媒体引用缺失。` : `${preflight.stats.mediaMissing} media references are missing.`}</p>
                  {preflight.warnings.slice(0, 3).map((warning) => <p key={warning} className="mt-1 break-all">• {warning}</p>)}
                </div>
              )}

              {phase !== "importing" && !report && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void runPreflight()}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-200 px-3 py-2.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    <RefreshCw size={14} /> {strings.rescan}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleImport()}
                    disabled={config.selectedTypes.length === 0}
                    className="flex flex-[2] items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Upload size={14} /> {strings.import}
                  </button>
                </div>
              )}
            </>
          )}

          {report && (
            <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
              <div className="flex items-start gap-2">
                {report.counts.failed > 0 ? <AlertTriangle size={16} className="mt-0.5 text-amber-500" /> : <CheckCircle size={16} className="mt-0.5 text-emerald-500" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{strings.report}</p>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{message}</p>
                  <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                    <Mini label={zh ? "新增" : "Created"} value={report.counts.imported} />
                    <Mini label={zh ? "更新" : "Updated"} value={report.counts.updated} />
                    <Mini label={zh ? "跳过" : "Skipped"} value={report.counts.skipped} />
                    <Mini label={zh ? "部分" : "Partial"} value={report.counts.partial} />
                    <Mini label={zh ? "失败" : "Failed"} value={report.counts.failed} />
                    <Mini label={zh ? "附件" : "Files"} value={report.counts.attachments} />
                  </div>
                  {(report.items.some((item) => item.status === "failed" || item.warnings?.length) || report.warnings.length > 0) && (
                    <div className="mt-3">
                      <button type="button" onClick={() => setShowDetails((value) => !value)} className="text-xs font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400">
                        {strings.details} {showDetails ? "▲" : "▼"}
                      </button>
                      {showDetails && (
                        <div className="mt-2 max-h-56 space-y-2 overflow-y-auto rounded-md bg-zinc-50 p-2 text-[11px] dark:bg-zinc-950/50">
                          {report.warnings.map((warning) => <p key={warning} className="break-all text-amber-600">• {warning}</p>)}
                          {report.items.filter((item) => item.status === "failed" || item.warnings?.length).map((item) => (
                            <div key={`${item.externalId}-${item.status}`} className="border-t border-zinc-200 pt-2 first:border-0 first:pt-0 dark:border-zinc-800">
                              <p className="font-medium text-zinc-700 dark:text-zinc-200">{item.title}</p>
                              {item.error && <p className="break-all text-red-500">{item.error}</p>}
                              {item.warnings?.map((warning) => <p key={warning} className="break-all text-amber-600">• {warning}</p>)}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <button type="button" onClick={reset} className="mt-3 w-full rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">{strings.reset}</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900/60"><div className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{value}</div><div className="mt-0.5 text-[10px] text-zinc-400">{label}</div></div>;
}

function Mini({ label, value }: { label: string; value: number }) {
  return <div className="rounded-md bg-zinc-50 px-2 py-1.5 text-center dark:bg-zinc-800/60"><div className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{value}</div><div className="text-[9px] text-zinc-400">{label}</div></div>;
}

function Toggle({ checked, disabled, icon, label, onChange }: { checked: boolean; disabled: boolean; icon: React.ReactNode; label: string; onChange: (value: boolean) => void }) {
  return (
    <label className={`flex cursor-pointer items-start gap-2 rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900/50 ${disabled ? "opacity-60" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500" />
      <span className="mt-0.5 text-emerald-600 dark:text-emerald-400">{icon}</span>
      <span className="leading-relaxed">{label}</span>
    </label>
  );
}

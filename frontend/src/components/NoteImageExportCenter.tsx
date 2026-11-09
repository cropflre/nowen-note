import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileImage,
  FileOutput,
  Files,
  Image as ImageIcon,
  Loader2,
  Moon,
  Share2,
  Smartphone,
  Sun,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import {
  NOTE_IMAGE_EXPORT_REQUEST_EVENT,
  settleNoteImageExportRequest,
  type NoteImageExportDestination,
  type NoteImageExportFormat,
  type NoteImageExportLayout,
  type NoteImageExportRequestDetail,
  type NoteImageExportTheme,
} from "@/lib/noteImageExportBridge";
import {
  exportNoteImageDetailed,
  type NoteImageExportProgress,
  type NoteImageExportResult,
} from "@/lib/noteImageExportCore";
import { isAndroidNative, isHarmonyNative, openNativeExportUri } from "@/lib/nativeImageSave";

interface ActiveRequest extends NoteImageExportRequestDetail {
  settled: boolean;
}

function optionClass(active: boolean, disabled = false): string {
  return cn(
    "relative rounded-xl border p-3 text-left transition-all",
    active
      ? "border-accent-primary bg-accent-primary/8 ring-1 ring-accent-primary/20"
      : "border-app-border bg-app-surface hover:border-accent-primary/45 hover:bg-app-hover",
    disabled && "opacity-45 cursor-not-allowed hover:border-app-border hover:bg-app-surface",
  );
}

function languageCopy() {
  const lang = (navigator.language || "zh-CN").toLowerCase();
  const zh = lang.startsWith("zh");
  return zh ? {
    title: "导出笔记图片",
    subtitle: "基于最终阅读预览生成，保留 Markdown、代码块、表格和图片样式。",
    format: "图片格式",
    destination: "保存方式",
    layout: "超长内容",
    theme: "导出主题",
    png: "PNG",
    pngHint: "默认推荐，清晰无损",
    jpg: "JPEG",
    jpgHint: "体积更小，可调质量",
    svg: "SVG",
    svgHint: "高级矢量格式",
    gallery: "保存到相册",
    galleryHint: "Pictures/Nowen Note",
    files: "保存到系统文件",
    filesHint: "打开系统文件选择器",
    share: "分享到其他 App",
    shareHint: "微信、QQ、邮件等",
    download: "下载文件",
    downloadHint: "保存到浏览器下载目录",
    auto: "自动",
    autoHint: "长内容自动分页，避免空白图",
    long: "长图",
    longHint: "安全范围内生成一张长图",
    pages: "分页图片",
    pagesHint: "按内容块拆成多张图片",
    current: "跟随当前",
    light: "浅色",
    dark: "深色",
    quality: "JPEG 质量",
    export: "开始导出",
    exportAgain: "重新导出",
    cancel: "取消",
    close: "关闭",
    open: "打开结果",
    copyPath: "复制位置",
    pdf: "改为导出 PDF",
    pdfHint: "超长文档也可以使用分页 PDF。",
    resultTitle: "导出完成",
    savedAt: "保存位置",
    pagesCount: "生成文件",
    warnings: "导出提示",
    failedAssets: "加载失败的图片/资源",
    canceled: "已取消保存",
    failed: "导出失败",
  } : {
    title: "Export note as image",
    subtitle: "Rendered from the final reading preview with Markdown, code, tables and image styling preserved.",
    format: "Format",
    destination: "Destination",
    layout: "Long content",
    theme: "Theme",
    png: "PNG",
    pngHint: "Recommended, lossless",
    jpg: "JPEG",
    jpgHint: "Smaller file with quality control",
    svg: "SVG",
    svgHint: "Advanced vector format",
    gallery: "Save to gallery",
    galleryHint: "Pictures/Nowen Note",
    files: "Save to Files",
    filesHint: "Open the system file picker",
    share: "Share to another app",
    shareHint: "Messages, mail and more",
    download: "Download",
    downloadHint: "Use the browser download folder",
    auto: "Auto",
    autoHint: "Paginate when needed to avoid blank canvases",
    long: "Long image",
    longHint: "One image when within safe limits",
    pages: "Paged images",
    pagesHint: "Split on nearby content blocks",
    current: "Current",
    light: "Light",
    dark: "Dark",
    quality: "JPEG quality",
    export: "Export",
    exportAgain: "Export again",
    cancel: "Cancel",
    close: "Close",
    open: "Open result",
    copyPath: "Copy location",
    pdf: "Export PDF instead",
    pdfHint: "Paged PDF is also available for very long notes.",
    resultTitle: "Export complete",
    savedAt: "Saved to",
    pagesCount: "Files",
    warnings: "Export notes",
    failedAssets: "Images/resources that failed to load",
    canceled: "Save canceled",
    failed: "Export failed",
  };
}

export default function NoteImageExportCenter() {
  const copy = useMemo(languageCopy, []);
  const android = isAndroidNative();
  const harmony = isHarmonyNative();
  const defaultDestination = harmony ? "files" : android ? "gallery" : "download";
  const [request, setRequest] = useState<ActiveRequest | null>(null);
  const [format, setFormat] = useState<NoteImageExportFormat>("png");
  const [destination, setDestination] = useState<NoteImageExportDestination>(defaultDestination);
  const [layout, setLayout] = useState<NoteImageExportLayout>("auto");
  const [theme, setTheme] = useState<NoteImageExportTheme>("current");
  const [quality, setQuality] = useState(90);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<NoteImageExportProgress | null>(null);
  const [result, setResult] = useState<NoteImageExportResult | null>(null);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<NoteImageExportRequestDetail>).detail;
      if (!detail?.requestId || !detail.note) return;

      setRequest((current) => {
        if (current && !current.settled) settleNoteImageExportRequest(current.requestId, false);
        return { ...detail, settled: false };
      });
      setFormat(detail.options.format || "png");
      setDestination(harmony ? "files" : detail.options.destination || defaultDestination);
      setLayout(detail.options.layout || "auto");
      setTheme(detail.options.theme || "current");
      setQuality(Math.round((detail.options.quality ?? 0.9) * 100));
      setBusy(false);
      setProgress(null);
      setResult(null);
    };

    window.addEventListener(NOTE_IMAGE_EXPORT_REQUEST_EVENT, handleRequest);
    return () => window.removeEventListener(NOTE_IMAGE_EXPORT_REQUEST_EVENT, handleRequest);
  }, [defaultDestination, harmony]);

  useEffect(() => {
    if (!request || busy || result?.ok) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeBeforeCompletion();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  useEffect(() => {
    if (format === "svg" && destination === "gallery") setDestination(android ? "files" : "download");
  }, [format, destination, android]);

  const settle = (ok: boolean) => {
    setRequest((current) => {
      if (!current || current.settled) return current;
      settleNoteImageExportRequest(current.requestId, ok);
      return { ...current, settled: true };
    });
  };

  const closeBeforeCompletion = () => {
    if (busy) return;
    settle(false);
    setRequest(null);
    setResult(null);
    setProgress(null);
  };

  const closeAfterCompletion = () => {
    if (busy) return;
    if (!request?.settled) settle(!!result?.ok);
    setRequest(null);
    setResult(null);
    setProgress(null);
  };

  const handleExport = async () => {
    if (!request || busy) return;
    setBusy(true);
    setResult(null);
    setProgress({ phase: "prepare", current: 0, total: 1, message: "正在准备…" });

    const next = await exportNoteImageDetailed(request.note, {
      format,
      destination,
      layout,
      theme,
      quality: quality / 100,
      pixelRatio: request.options.pixelRatio,
      onProgress: setProgress,
    });

    setResult(next);
    setBusy(false);
    setProgress(null);

    if (next.ok) {
      settle(true);
    } else if (next.canceled) {
      toast.info(copy.canceled);
    } else {
      settle(false);
    }
  };

  const handleOpen = async () => {
    if (!result?.openUri) return;
    try {
      await openNativeExportUri(result.openUri, result.files[0]?.mimeType || "image/*");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCopyPath = async () => {
    if (!result?.displayPath) return;
    try {
      await navigator.clipboard.writeText(result.displayPath);
      toast.success(copy.copyPath);
    } catch {
      toast.error("复制失败");
    }
  };

  const handlePdf = async () => {
    if (!request || busy) return;
    setBusy(true);
    try {
      const { exportSingleNoteAsPDF } = await import("@/lib/exportService");
      const pdf = await exportSingleNoteAsPDF(request.note.id);
      if (pdf.ok) {
        settle(true);
        setResult({
          ok: true,
          format: "png",
          destination: "download",
          files: [],
          warnings: [],
          failedResources: [],
          paginated: true,
          displayPath: pdf.mode === "desktop" ? (pdf.path || "已保存 PDF") : "浏览器下载目录",
        });
      } else if (pdf.mode !== "canceled") {
        toast.error((pdf as { error?: string }).error || copy.failed);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!request) return null;

  const formatOptions: Array<{ id: NoteImageExportFormat; label: string; hint: string }> = [
    { id: "png", label: copy.png, hint: copy.pngHint },
    { id: "jpg", label: copy.jpg, hint: copy.jpgHint },
    { id: "svg", label: copy.svg, hint: copy.svgHint },
  ];
  const destinationOptions: Array<{
    id: NoteImageExportDestination;
    label: string;
    hint: string;
    icon: typeof Download;
    visible: boolean;
    disabled?: boolean;
  }> = [
    { id: "gallery", label: copy.gallery, hint: copy.galleryHint, icon: Smartphone, visible: android, disabled: format === "svg" },
    { id: "files", label: copy.files, hint: copy.filesHint, icon: Files, visible: android || harmony },
    { id: "share", label: copy.share, hint: copy.shareHint, icon: Share2, visible: !harmony && (android || typeof navigator.share === "function") },
    { id: "download", label: copy.download, hint: copy.downloadHint, icon: Download, visible: !android && !harmony },
  ];
  const layoutOptions: Array<{ id: NoteImageExportLayout; label: string; hint: string }> = [
    { id: "auto", label: copy.auto, hint: copy.autoHint },
    { id: "long", label: copy.long, hint: copy.longHint },
    { id: "pages", label: copy.pages, hint: copy.pagesHint },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[230] flex items-end sm:items-center justify-center bg-black/45 backdrop-blur-sm sm:p-4">
      <div
        className="w-full sm:max-w-3xl max-h-[92dvh] sm:max-h-[88vh] overflow-hidden rounded-t-2xl sm:rounded-2xl border border-app-border bg-app-elevated shadow-2xl flex flex-col"
        style={{ paddingBottom: "var(--safe-area-bottom)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-app-border">
          <div className="flex min-w-0 gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
              <ImageIcon size={20} />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-tx-primary">{copy.title}</h2>
              <p className="mt-1 text-xs leading-relaxed text-tx-tertiary">{copy.subtitle}</p>
              <p className="mt-1 truncate text-xs font-medium text-tx-secondary">{request.note.title || "无标题笔记"}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={result?.ok ? closeAfterCompletion : closeBeforeCompletion}
            disabled={busy}
            className="rounded-lg p-2 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:opacity-40"
            aria-label={copy.close}
          >
            <X size={17} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {result?.ok ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/8 p-5">
                <div className="flex items-start gap-3">
                  <CheckCircle2 size={22} className="mt-0.5 shrink-0 text-emerald-500" />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-tx-primary">{copy.resultTitle}</h3>
                    <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                      <div className="rounded-lg bg-app-surface/70 px-3 py-2">
                        <div className="text-xs text-tx-tertiary">{copy.pagesCount}</div>
                        <div className="mt-0.5 font-medium text-tx-primary">{result.files.length || 1}</div>
                      </div>
                      <div className="min-w-0 rounded-lg bg-app-surface/70 px-3 py-2">
                        <div className="text-xs text-tx-tertiary">{copy.savedAt}</div>
                        <div className="mt-0.5 break-all font-medium text-tx-primary">{result.displayPath || "已交给系统处理"}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {(result.warnings.length > 0 || result.failedResources.length > 0) && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 p-4 text-sm">
                  <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
                    <AlertTriangle size={16} />
                    {copy.warnings}
                  </div>
                  <ul className="mt-2 space-y-1 text-xs text-tx-secondary">
                    {result.warnings.map((warning, index) => <li key={`${warning}-${index}`}>• {warning}</li>)}
                  </ul>
                  {result.failedResources.length > 0 && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-medium text-tx-primary">
                        {copy.failedAssets}（{result.failedResources.length}）
                      </summary>
                      <div className="mt-2 max-h-36 space-y-2 overflow-y-auto rounded-lg bg-app-surface p-2">
                        {result.failedResources.map((failure, index) => (
                          <div key={`${failure.src}-${index}`} className="text-[11px] text-tx-secondary">
                            <div className="break-all font-medium text-tx-primary">{failure.src}</div>
                            <div className="mt-0.5 break-words text-tx-tertiary">{failure.reason}</div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-tx-tertiary">{copy.format}</h3>
                <div className="grid grid-cols-3 gap-2">
                  {formatOptions.map((item) => (
                    <button key={item.id} type="button" onClick={() => setFormat(item.id)} disabled={busy} className={optionClass(format === item.id)}>
                      {format === item.id && <Check size={14} className="absolute right-2 top-2 text-accent-primary" />}
                      <FileImage size={18} className={format === item.id ? "text-accent-primary" : "text-tx-tertiary"} />
                      <div className="mt-2 text-sm font-semibold text-tx-primary">{item.label}</div>
                      <div className="mt-1 text-[11px] leading-snug text-tx-tertiary">{item.hint}</div>
                    </button>
                  ))}
                </div>
              </section>

              {format === "jpg" && (
                <section className="rounded-xl border border-app-border bg-app-surface p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-tx-secondary">{copy.quality}</span>
                    <span className="font-semibold text-tx-primary">{quality}%</span>
                  </div>
                  <input type="range" min={55} max={98} value={quality} disabled={busy} onChange={(event) => setQuality(Number(event.target.value))} className="mt-2 w-full accent-[var(--accent-primary)]" />
                </section>
              )}

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-tx-tertiary">{copy.destination}</h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {destinationOptions.filter((item) => item.visible).map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => !item.disabled && setDestination(item.id)}
                        disabled={busy || item.disabled}
                        className={optionClass(destination === item.id, item.disabled)}
                      >
                        {destination === item.id && <Check size={14} className="absolute right-2 top-2 text-accent-primary" />}
                        <div className="flex items-center gap-3">
                          <Icon size={18} className={destination === item.id ? "text-accent-primary" : "text-tx-tertiary"} />
                          <div>
                            <div className="text-sm font-medium text-tx-primary">{item.label}</div>
                            <div className="mt-0.5 text-[11px] text-tx-tertiary">{item.hint}</div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {format !== "svg" && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-tx-tertiary">{copy.layout}</h3>
                  <div className="grid grid-cols-3 gap-2">
                    {layoutOptions.map((item) => (
                      <button key={item.id} type="button" onClick={() => setLayout(item.id)} disabled={busy} className={optionClass(layout === item.id)}>
                        {layout === item.id && <Check size={14} className="absolute right-2 top-2 text-accent-primary" />}
                        <div className="text-sm font-medium text-tx-primary">{item.label}</div>
                        <div className="mt-1 text-[11px] leading-snug text-tx-tertiary">{item.hint}</div>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-tx-tertiary">{copy.theme}</h3>
                <div className="inline-flex rounded-xl border border-app-border bg-app-surface p-1">
                  {([
                    ["current", copy.current, FileOutput],
                    ["light", copy.light, Sun],
                    ["dark", copy.dark, Moon],
                  ] as const).map(([id, label, Icon]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setTheme(id)}
                      disabled={busy}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors",
                        theme === id ? "bg-app-elevated text-accent-primary shadow-sm" : "text-tx-tertiary hover:text-tx-primary",
                      )}
                    >
                      <Icon size={13} /> {label}
                    </button>
                  ))}
                </div>
              </section>

              {busy && progress && (
                <div className="rounded-xl border border-accent-primary/20 bg-accent-primary/6 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-tx-primary">
                    <Loader2 size={16} className="animate-spin text-accent-primary" />
                    {progress.message}
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-app-hover">
                    <div className="h-full rounded-full bg-accent-primary transition-all" style={{ width: `${progress.total ? Math.max(8, (progress.current / progress.total) * 100) : 12}%` }} />
                  </div>
                </div>
              )}

              {result && !result.ok && !result.canceled && (
                <div className="rounded-xl border border-red-500/25 bg-red-500/8 p-3 text-sm text-red-600 dark:text-red-400">
                  <div className="font-medium">{copy.failed}</div>
                  <div className="mt-1 break-words text-xs">{result.error || "未知错误"}</div>
                </div>
              )}

              <button type="button" onClick={handlePdf} disabled={busy} className="flex w-full items-center justify-between rounded-xl border border-app-border bg-app-surface px-3 py-2.5 text-left hover:bg-app-hover disabled:opacity-50">
                <div className="flex items-center gap-2">
                  <FileOutput size={16} className="text-tx-tertiary" />
                  <div>
                    <div className="text-xs font-medium text-tx-primary">{copy.pdf}</div>
                    <div className="mt-0.5 text-[11px] text-tx-tertiary">{copy.pdfHint}</div>
                  </div>
                </div>
                <ExternalLink size={14} className="text-tx-tertiary" />
              </button>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-app-border px-5 py-3">
          {result?.ok ? (
            <>
              {result.displayPath && (
                <button type="button" onClick={handleCopyPath} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-tx-secondary hover:bg-app-hover">
                  <Copy size={14} /> {copy.copyPath}
                </button>
              )}
              {result.openUri && (
                <button type="button" onClick={handleOpen} className="inline-flex items-center gap-1.5 rounded-lg border border-app-border px-3 py-2 text-xs text-tx-primary hover:bg-app-hover">
                  <ExternalLink size={14} /> {copy.open}
                </button>
              )}
              <button type="button" onClick={() => { setResult(null); setProgress(null); }} className="inline-flex items-center gap-1.5 rounded-lg border border-app-border px-3 py-2 text-xs text-tx-primary hover:bg-app-hover">
                <FileImage size={14} /> {copy.exportAgain}
              </button>
              <button type="button" onClick={closeAfterCompletion} className="rounded-lg bg-accent-primary px-4 py-2 text-xs font-medium text-white hover:opacity-90">
                {copy.close}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={closeBeforeCompletion} disabled={busy} className="rounded-lg px-4 py-2 text-sm text-tx-secondary hover:bg-app-hover disabled:opacity-40">
                {copy.cancel}
              </button>
              <button type="button" onClick={handleExport} disabled={busy} className="inline-flex min-w-28 items-center justify-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-55">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                {copy.export}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

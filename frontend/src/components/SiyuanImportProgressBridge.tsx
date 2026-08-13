import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";

const SIYUAN_IMPORT_ENDPOINT = "/export/import/siyuan-package";
const NORMALIZED_INPUT_FLAG = "nowenSiyuanPackageNormalized";
const PROGRESS_HOST_ATTRIBUTE = "data-nowen-siyuan-import-progress-host";

export interface SiyuanZipInspection {
  isSiyuanWorkspace: boolean;
  syFileCount: number;
  rootName: string;
}

type FeedbackState = {
  id: number;
  tone: "working" | "success" | "error";
  title: string;
  detail: string;
  percent?: number;
  indeterminate?: boolean;
};

export function inspectSiyuanEntryNames(entryNames: string[]): SiyuanZipInspection {
  const files = entryNames
    .map((name) => String(name || "").replace(/\\/g, "/").replace(/^\/+/, ""))
    .filter(Boolean);
  const syFiles = files.filter((name) => /(^|\/)data\/[^/]+\/.+\.sy$/i.test(name) || /(^|\/)[^/]+\.sy$/i.test(name));
  const firstSegments = syFiles
    .map((name) => name.split("/").filter(Boolean)[0] || "")
    .filter((segment) => segment && segment.toLowerCase() !== "data");
  const sharedRoot = firstSegments.length > 0 && firstSegments.every((segment) => segment === firstSegments[0])
    ? firstSegments[0]
    : "";
  return {
    isSiyuanWorkspace: syFiles.length > 0,
    syFileCount: syFiles.length,
    rootName: sharedRoot,
  };
}

export function normalizeSiyuanPackageName(fileName: string, rootName = ""): string {
  if (/\.sy\.zip$/i.test(fileName)) return fileName;
  const safeRoot = rootName.trim().replace(/[\\/:*?"<>|]/g, "-");
  if (safeRoot) return `${safeRoot}.sy.zip`;
  const base = fileName.replace(/\.zip$/i, "").replace(/\.sy$/i, "") || "siyuan-workspace";
  return `${base}.sy.zip`;
}

export function isSiyuanImportRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  try {
    const pathname = new URL(url, window.location.href).pathname;
    return pathname.endsWith(SIYUAN_IMPORT_ENDPOINT) || pathname.includes(`${SIYUAN_IMPORT_ENDPOINT}/jobs/`);
  } catch {
    return url.includes(SIYUAN_IMPORT_ENDPOINT);
  }
}

async function inspectSiyuanWorkspaceZip(file: File): Promise<SiyuanZipInspection> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(file);
  return inspectSiyuanEntryNames(Object.keys(zip.files));
}

function isSharedImportInput(input: HTMLInputElement): boolean {
  const accept = String(input.accept || "").toLowerCase();
  return input.type === "file" && input.multiple && accept.includes(".md") && accept.includes(".zip");
}

export function findSiyuanImportPanel(input: HTMLInputElement): HTMLElement | null {
  let current = input.parentElement;
  while (current) {
    if (
      current.classList.contains("rounded-xl")
      && current.classList.contains("border")
      && current.classList.contains("p-3")
      && current.classList.contains("sm:p-4")
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function replaceInputFile(input: HTMLInputElement, file: File): void {
  if (typeof DataTransfer !== "undefined") {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    return;
  }
  const fallback = {
    0: file,
    length: 1,
    item: (index: number) => index === 0 ? file : null,
  } as unknown as FileList;
  Object.defineProperty(input, "files", { configurable: true, value: fallback });
}

function ProgressCard({ state }: { state: FeedbackState }) {
  const Icon = state.tone === "success" ? CheckCircle : state.tone === "error" ? AlertCircle : Loader2;
  const iconClass = state.tone === "success"
    ? "text-emerald-500"
    : state.tone === "error"
      ? "text-red-500"
      : "animate-spin text-emerald-500";
  const cardClass = state.tone === "error"
    ? "border-red-200/70 bg-red-50/50 dark:border-red-900/50 dark:bg-red-500/5"
    : "border-emerald-200/70 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-500/5";
  const progress = Math.max(0, Math.min(100, state.percent || 0));

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      className={`mt-3 w-full rounded-xl border p-3 shadow-sm ${cardClass}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${iconClass}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{state.title}</div>
            {!state.indeterminate && typeof state.percent === "number" && (
              <span className="shrink-0 text-xs font-medium tabular-nums text-zinc-500 dark:text-zinc-400">
                {Math.round(progress)}%
              </span>
            )}
          </div>
          <div className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{state.detail}</div>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-white/80 dark:bg-zinc-800"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state.indeterminate ? undefined : Math.round(progress)}
            aria-valuetext={state.indeterminate ? "处理中" : undefined}
          >
            {state.indeterminate ? (
              <motion.div
                className="h-full w-2/5 rounded-full bg-emerald-500"
                initial={{ x: "-120%" }}
                animate={{ x: "300%" }}
                transition={{ duration: 1.25, ease: "easeInOut", repeat: Infinity }}
              />
            ) : (
              <motion.div
                className={`h-full rounded-full ${state.tone === "error" ? "bg-red-500" : "bg-emerald-500"}`}
                initial={false}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.25 }}
              />
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export default function SiyuanImportProgressBridge() {
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const nextId = useRef(1);
  const hideTimer = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const clearHideTimer = () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    };

    const findLiveSharedInput = (): HTMLInputElement | null => {
      const inputs = document.querySelectorAll<HTMLInputElement>('input[type="file"][multiple]');
      return Array.from(inputs).find(isSharedImportInput) || null;
    };

    const ensureProgressHost = (input?: HTMLInputElement | null): HTMLElement | null => {
      const directPanel = input ? findSiyuanImportPanel(input) : null;
      const rememberedPanel = panelRef.current?.isConnected ? panelRef.current : null;
      const liveInput = directPanel || rememberedPanel ? null : findLiveSharedInput();
      const panel = directPanel || rememberedPanel || (liveInput ? findSiyuanImportPanel(liveInput) : null);
      if (!panel) return null;

      panelRef.current = panel;
      let host = hostRef.current;
      if (!host) {
        host = document.createElement("div");
        host.setAttribute(PROGRESS_HOST_ATTRIBUTE, "true");
        hostRef.current = host;
        setPortalHost(host);
      }
      if (host.parentElement !== panel) panel.appendChild(host);
      return host;
    };

    const show = (patch: Omit<FeedbackState, "id">, input?: HTMLInputElement | null) => {
      clearHideTimer();
      if (!ensureProgressHost(input)) return;
      setFeedback({ id: nextId.current++, ...patch });
      window.requestAnimationFrame(() => {
        ensureProgressHost(input);
      });
    };

    const hideLater = (delay: number) => {
      clearHideTimer();
      hideTimer.current = window.setTimeout(() => setFeedback(null), delay);
    };

    const onChangeCapture = (event: Event) => {
      const input = event.target instanceof HTMLInputElement ? event.target : null;
      if (!input || !isSharedImportInput(input)) return;

      ensureProgressHost(input);
      if (input.dataset[NORMALIZED_INPUT_FLAG] === "1") {
        delete input.dataset[NORMALIZED_INPUT_FLAG];
        return;
      }
      const files = Array.from(input.files || []);
      if (files.length !== 1 || !/\.zip$/i.test(files[0].name) || /\.sy\.zip$/i.test(files[0].name)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const file = files[0];
      show({
        tone: "working",
        title: "正在检查思源导入包",
        detail: `正在读取 ${file.name} 的目录结构…`,
        percent: 18,
      }, input);

      void (async () => {
        try {
          const inspection = await inspectSiyuanWorkspaceZip(file);
          if (inspection.isSiyuanWorkspace) {
            show({
              tone: "working",
              title: "已识别为思源工作空间",
              detail: `发现 ${inspection.syFileCount} 个 .sy 文档，正在准备导入列表…`,
              percent: 78,
            }, input);
            const renamed = new File([file], normalizeSiyuanPackageName(file.name, inspection.rootName), {
              type: file.type || "application/zip",
              lastModified: file.lastModified,
            });
            replaceInputFile(input, renamed);
          }
          input.dataset[NORMALIZED_INPUT_FLAG] = "1";
          input.dispatchEvent(new Event("change", { bubbles: true }));
          show({
            tone: "success",
            title: inspection.isSiyuanWorkspace ? "思源导入包已就绪" : "文件读取完成",
            detail: inspection.isSiyuanWorkspace
              ? "请确认导入格式与目标目录，然后点击导入按钮。"
              : "已按通用 ZIP 导入流程继续处理。",
            percent: 100,
          }, input);
          hideLater(1400);
        } catch (error) {
          input.dataset[NORMALIZED_INPUT_FLAG] = "1";
          input.dispatchEvent(new Event("change", { bubbles: true }));
          show({
            tone: "error",
            title: "思源导入包检查失败",
            detail: error instanceof Error ? error.message : String(error),
            percent: 100,
          }, input);
          hideLater(4000);
        }
      })();
    };

    const originalFetch = window.fetch.bind(window);
    const patchedFetch: typeof window.fetch = async (input, init) => {
      if (!isSiyuanImportRequest(input)) return originalFetch(input, init);
      const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "POST") {
        show({
          tone: "working",
          title: "正在创建思源导入任务",
          detail: "正在上传数据包，请不要关闭页面…",
          indeterminate: true,
        });
      }
      const processingTimer = method === "POST" ? window.setTimeout(() => {
        show({
          tone: "working",
          title: "正在创建后台任务",
          detail: "上传完成后会立即返回任务编号，后续进度不依赖当前 HTTP 连接。",
          indeterminate: true,
        });
      }, 900) : null;
      try {
        const response = await originalFetch(input, init);
        if (processingTimer !== null) window.clearTimeout(processingTimer);
        const data = await response.clone().json().catch(() => ({}));
        const job = data?.job as {
          status?: "queued" | "running" | "completed" | "failed";
          message?: string;
          error?: string | null;
          result?: {
            success?: boolean;
            count?: number;
            stats?: {
              syFiles?: number;
              parsedNotes?: number;
              createdNotes?: number;
              failedNotes?: number;
            };
          } | null;
        } | undefined;
        const parsedNotes = job?.result?.stats?.parsedNotes ?? job?.result?.stats?.syFiles ?? 0;
        const createdNotes = job?.result?.stats?.createdNotes ?? job?.result?.count ?? 0;
        const failedNotes = job?.result?.stats?.failedNotes ?? Math.max(0, parsedNotes - createdNotes);
        const validCompletedResult = job?.result?.success === true
          && createdNotes > 0
          && createdNotes === job.result.count
          && failedNotes === 0;
        if (response.ok && job?.status === "completed" && validCompletedResult) {
          show({
            tone: "success",
            title: "思源笔记导入完成",
            detail: job.message || "内容树和笔记列表正在刷新。",
            percent: 100,
          });
          hideLater(2200);
        } else if (response.ok && job?.status === "completed") {
          show({
            tone: "error",
            title: "思源笔记写入失败",
            detail: `已成功解析 ${parsedNotes} 篇思源文档，但 ${createdNotes} 篇写入成功，${failedNotes} 篇失败。`,
            percent: 100,
          });
          hideLater(5000);
        } else if (response.ok && job?.status === "failed") {
          show({
            tone: "error",
            title: "思源笔记导入失败",
            detail: job.error || job.message || "后台任务明确返回失败。",
            percent: 100,
          });
          hideLater(5000);
        } else if (response.ok) {
          show({
            tone: "working",
            title: "正在后台导入思源笔记",
            detail: job?.message || "任务已经建立，正在等待后台处理…",
            indeterminate: true,
          });
        } else if (response.status === 404 || response.status >= 500) {
          show({
            tone: "working",
            title: "正在确认思源导入任务",
            detail: `连接返回 HTTP ${response.status}，正在按请求编号查询后台状态…`,
            indeterminate: true,
          });
        } else {
          show({
            tone: "error",
            title: "思源导入请求失败",
            detail: data?.error || `服务器返回 HTTP ${response.status}。`,
            percent: 100,
          });
          hideLater(5000);
        }
        return response;
      } catch (error) {
        if (processingTimer !== null) window.clearTimeout(processingTimer);
        show({
          tone: "working",
          title: "正在等待思源导入状态",
          detail: "连接暂时中断，稍后会继续查询同一个后台任务，不会重新导入。",
          indeterminate: true,
        });
        throw error;
      }
    };

    document.addEventListener("change", onChangeCapture, true);
    window.fetch = patchedFetch;
    return () => {
      document.removeEventListener("change", onChangeCapture, true);
      if (window.fetch === patchedFetch) window.fetch = originalFetch;
      clearHideTimer();
      hostRef.current?.remove();
      hostRef.current = null;
      panelRef.current = null;
    };
  }, []);

  if (typeof document === "undefined" || !portalHost) return null;
  return createPortal(
    <AnimatePresence>{feedback ? <ProgressCard key={feedback.id} state={feedback} /> : null}</AnimatePresence>,
    portalHost,
  );
}

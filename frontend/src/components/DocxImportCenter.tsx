import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  FileType2,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  cancelActiveDocxImport,
  dismissActiveDocxImport,
  retryActiveDocxImport,
  subscribeDocxImportProgress,
  type DocxImportUiState,
} from "@/lib/docxImportProgress";
import { formatImportBytes } from "@/lib/docxImportSafety";

function stageLabel(state: DocxImportUiState): string {
  const labels: Record<DocxImportUiState["stage"], string> = {
    read: "读取文件",
    preflight: "安全预检",
    parse: "后台解析",
    images: "抽取图片",
    convert: "转换富文本",
    create: "创建事务",
    upload: "上传附件",
    save: "确认保存",
    verify: "刷新校验",
    complete: "导入完成",
  };
  return labels[state.stage];
}

export default function DocxImportCenter() {
  const [state, setState] = useState<DocxImportUiState | null>(null);

  useEffect(() => subscribeDocxImportProgress(setState), []);

  if (!state || typeof document === "undefined") return null;

  const running = state.status === "running";
  const failed = state.status === "error";
  const success = state.status === "success";
  const archive = state.metrics.archiveStats;

  return createPortal(
    <div className="fixed inset-0 z-[260] flex items-end justify-center bg-black/45 backdrop-blur-sm sm:items-center sm:p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Word 文档导入进度"
        className="w-full max-w-xl overflow-hidden rounded-t-2xl border border-app-border bg-app-elevated shadow-2xl sm:rounded-2xl"
        style={{ paddingBottom: "var(--safe-area-bottom)" }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-app-border px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500">
              {running ? (
                <Loader2 size={20} className="animate-spin" />
              ) : failed ? (
                <AlertTriangle size={20} className="text-amber-500" />
              ) : (
                <CheckCircle2 size={20} className="text-emerald-500" />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-tx-primary">
                {failed ? "Word 文档导入失败" : success ? "Word 文档导入完成" : "正在导入 Word 文档"}
              </h2>
              <p className="mt-1 truncate text-xs text-tx-tertiary" title={state.fileName}>
                {state.fileName} · {formatImportBytes(state.fileSize)}
              </p>
            </div>
          </div>
          {!running && (
            <button
              type="button"
              onClick={dismissActiveDocxImport}
              className="rounded-md p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
              aria-label="关闭"
            >
              <X size={17} />
            </button>
          )}
        </header>

        <div className="space-y-4 px-5 py-5">
          <div>
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-medium text-tx-secondary">{stageLabel(state)}</span>
              <span className="tabular-nums text-tx-tertiary">{Math.round(state.percent)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-app-hover">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${failed ? "bg-amber-500" : success ? "bg-emerald-500" : "bg-accent-primary"}`}
                style={{ width: `${Math.max(2, Math.min(100, state.percent))}%` }}
              />
            </div>
            <p className="mt-2 text-sm leading-6 text-tx-secondary">{state.message}</p>
          </div>

          {failed && state.error && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm leading-6 text-amber-700 dark:text-amber-300">
              {state.error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 rounded-xl border border-app-border bg-app-surface/60 p-3 text-xs sm:grid-cols-4">
            <div>
              <div className="text-tx-tertiary">内部文件</div>
              <div className="mt-1 font-medium text-tx-secondary">{archive?.entryCount ?? "—"}</div>
            </div>
            <div>
              <div className="text-tx-tertiary">解压体积</div>
              <div className="mt-1 font-medium text-tx-secondary">{archive ? formatImportBytes(archive.uncompressedBytes) : "—"}</div>
            </div>
            <div>
              <div className="text-tx-tertiary">图片</div>
              <div className="mt-1 font-medium text-tx-secondary">
                {state.metrics.uploadedImages ?? 0}/{state.metrics.imageCount ?? archive?.imageCount ?? 0}
              </div>
            </div>
            <div>
              <div className="text-tx-tertiary">正文字符</div>
              <div className="mt-1 font-medium text-tx-secondary">
                {state.metrics.contentChars?.toLocaleString() ?? "—"}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-app-hover/60 px-3 py-2 text-xs leading-5 text-tx-tertiary">
            <FileType2 size={14} className="mt-0.5 shrink-0" />
            <span>解析在独立 Worker 中执行；图片不会以 Base64 写入正文。失败或取消时会清理已创建的笔记和附件。</span>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-app-border px-5 py-3">
          {running ? (
            <Button variant="outline" onClick={cancelActiveDocxImport}>
              取消并回滚
            </Button>
          ) : failed ? (
            <>
              <Button variant="ghost" onClick={dismissActiveDocxImport}>关闭</Button>
              <Button onClick={retryActiveDocxImport} disabled={!state.canRetry}>
                <RotateCcw size={15} className="mr-1.5" />
                使用原文件重试
              </Button>
            </>
          ) : (
            <Button onClick={dismissActiveDocxImport}>完成</Button>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

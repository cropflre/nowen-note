import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  FileText,
  Layers3,
  RefreshCw,
  Scissors,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import OriginalAIChatPanel from "./AIChatPanel";
import { api } from "@/lib/api";
import { useApp } from "@/store/AppContext";
import {
  exportDiagnosticsFile,
  getReliableAIStatus,
  reliableAsk,
  type ReliableAskMode,
  type ReliableDiagnostics,
  type ReliableReference,
  type ReliableStatus,
} from "@/lib/aiReliable";
import { cn } from "@/lib/utils";

interface Props {
  onClose: () => void;
  onNavigateToNote?: (noteId: string) => void;
}

const CONTEXT_COLLAPSED_KEY = "nowen-ai-reliable-context-collapsed";

const MODE_OPTIONS: Array<{
  id: ReliableAskMode;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { id: "knowledge", label: "知识库检索", description: "沿用面板内的全部知识库或笔记本范围", icon: Database },
  { id: "current-note", label: "当前整篇笔记", description: "直接读取当前笔记正文，不依赖向量召回", icon: FileText },
  { id: "selection", label: "选中文本", description: "仅使用选择或粘贴的片段作为证据", icon: Scissors },
];

function formatTime(value: string | null | undefined): string {
  if (!value) return "尚未建立";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function StatusPill({ status }: { status: ReliableStatus | null }) {
  if (!status) return null;
  const stale = status.index.stale;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        !status.enabled
          ? "border-zinc-300 bg-zinc-100 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
          : stale
            ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-300"
            : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/30 dark:text-emerald-300",
      )}
    >
      <ShieldCheck size={11} />
      {!status.enabled ? "AI 已关闭" : stale ? "索引更新中" : "索引已同步"}
    </span>
  );
}

export default function AIChatReliabilityShell(props: Props) {
  const { state } = useApp();
  const activeNote = state.activeNote;
  const [mode, setMode] = useState<ReliableAskMode>("knowledge");
  const [selectedText, setSelectedText] = useState("");
  const [status, setStatus] = useState<ReliableStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [diagnostics, setDiagnostics] = useState<ReliableDiagnostics | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [contextCollapsed, setContextCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(CONTEXT_COLLAPSED_KEY) === "1";
  });
  const originalAskRef = useRef(api.aiAsk);

  const refreshStatus = useCallback(async () => {
    setLoadingStatus(true);
    setStatusError("");
    try {
      setStatus(await getReliableAIStatus());
    } catch (error) {
      setStatusError((error as Error)?.message || "诊断状态加载失败");
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CONTEXT_COLLAPSED_KEY, contextCollapsed ? "1" : "0");
    } catch {
      // Storage can be unavailable in privacy mode; collapsing still works locally.
    }
  }, [contextCollapsed]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 30_000);
    const refresh = () => void refreshStatus();
    window.addEventListener("storage", refresh);
    window.addEventListener("nowen:ai-manual-enabled-changed", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("nowen:ai-manual-enabled-changed", refresh);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (mode !== "selection" || selectedText.trim()) return;
    const browserSelection = window.getSelection()?.toString().trim();
    if (browserSelection) setSelectedText(browserSelection);
  }, [mode, selectedText]);

  // Bridge the existing mature chat/session UI to the reliable backend without
  // duplicating its history, streaming, references, upload and conversation code.
  useEffect(() => {
    const previous = api.aiAsk;
    const patched = async (
      question: string,
      history?: { role: string; content: string }[],
      onChunk?: (chunk: string) => void,
      onReferences?: (refs: any[]) => void,
      options?: { notebookId?: string; includeChildren?: boolean },
    ): Promise<string> => {
      const response = await reliableAsk(
        {
          question,
          history,
          mode,
          currentNoteId: activeNote?.id,
          selectedText,
          notebookId: mode === "knowledge" ? options?.notebookId : undefined,
          includeChildren: mode === "knowledge" ? options?.includeChildren : undefined,
        },
        {
          onChunk,
          onReferences: (references: ReliableReference[]) => onReferences?.(references as any[]),
          onDiagnostics: (value) => {
            setDiagnostics(value);
            setExpanded(value.context.truncated || value.index.stale);
            void refreshStatus();
          },
        },
      );
      return response;
    };
    (api as any).aiAsk = patched;
    return () => {
      if ((api as any).aiAsk === patched) (api as any).aiAsk = previous || originalAskRef.current;
    };
  }, [activeNote?.id, mode, refreshStatus, selectedText]);

  const currentMode = MODE_OPTIONS.find((item) => item.id === mode)!;
  const currentNoteUnavailable = mode === "current-note" && !activeNote?.id;
  const selectionUnavailable = mode === "selection" && !selectedText.trim();
  const contextWarning = currentNoteUnavailable
    ? "当前没有打开的笔记，请先打开一篇笔记或切换范围。"
    : selectionUnavailable
      ? "请在下方粘贴需要提问的文本；若编辑器中仍有浏览器选区，切换到本模式时会自动读取。"
      : "";

  const statusSummary = useMemo(() => {
    if (!status) return "正在读取模型与索引状态";
    return `${status.provider || "未配置"} · ${status.model || "未选择模型"}`;
  }, [status]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg">
      <section className="shrink-0 border-b border-app-border bg-app-surface/95 px-3 py-2 shadow-sm backdrop-blur md:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Activity size={15} className="text-accent-primary" />
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-tx-primary">可靠上下文</div>
              <div className="truncate text-[11px] text-tx-tertiary">
                {contextCollapsed ? `${currentMode.label} · ${statusSummary}` : statusSummary}
              </div>
            </div>
          </div>
          <StatusPill status={status} />
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setContextCollapsed((value) => !value)}
              className="inline-flex items-center gap-1 rounded-lg border border-app-border px-2 py-1 text-[11px] font-medium text-tx-secondary hover:bg-app-hover"
              title={contextCollapsed ? "展开可靠上下文" : "收起可靠上下文"}
              aria-expanded={!contextCollapsed}
            >
              {contextCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
              {contextCollapsed ? "展开" : "收起"}
            </button>
            <button
              type="button"
              onClick={() => void refreshStatus()}
              className="rounded-lg p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
              title="刷新模型与索引状态"
            >
              <RefreshCw size={14} className={loadingStatus ? "animate-spin" : ""} />
            </button>
            {!contextCollapsed && (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium",
                  expanded
                    ? "border-accent-primary/40 bg-accent-primary/10 text-accent-primary"
                    : "border-app-border text-tx-secondary hover:bg-app-hover",
                )}
              >
                <Layers3 size={12} />
                诊断
              </button>
            )}
          </div>
        </div>

        {!contextCollapsed && (
          <>
            <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-app-hover/70 p-1">
              {MODE_OPTIONS.map((item) => {
                const Icon = item.icon;
                const disabled = item.id === "current-note" && !activeNote?.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => setMode(item.id)}
                    title={item.description}
                    className={cn(
                      "flex min-w-0 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition",
                      mode === item.id
                        ? "bg-app-surface text-accent-primary shadow-sm ring-1 ring-app-border"
                        : "text-tx-tertiary hover:text-tx-primary",
                      disabled && "cursor-not-allowed opacity-40",
                    )}
                  >
                    <Icon size={12} />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>

            {mode === "selection" && (
              <textarea
                value={selectedText}
                onChange={(event) => setSelectedText(event.target.value)}
                placeholder="粘贴选中文本，支持 Markdown、HTML 和富文本 JSON…"
                rows={3}
                className="mt-2 max-h-[35vh] min-h-20 w-full resize-y rounded-xl border border-app-border bg-app-bg px-3 py-2 text-xs leading-5 text-tx-primary outline-none placeholder:text-tx-tertiary focus:border-accent-primary"
              />
            )}

            {contextWarning && (
              <p className="mt-2 rounded-lg border border-amber-300/60 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300">
                {contextWarning}
              </p>
            )}
            {statusError && <p className="mt-1 text-[11px] text-red-500">{statusError}</p>}

            {expanded && (
              <div className="mt-2 h-40 min-h-24 max-h-[45vh] resize-y overflow-auto rounded-xl border border-app-border bg-app-bg p-3 text-[11px] text-tx-secondary">
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                  <span className="text-tx-tertiary">本次范围</span>
                  <span>{currentMode.label}{activeNote?.title && mode === "current-note" ? ` · ${activeNote.title}` : ""}</span>
                  <span className="text-tx-tertiary">对话模型</span>
                  <span>{status?.provider || "—"} / {status?.model || "—"}</span>
                  <span className="text-tx-tertiary">Embedding</span>
                  <span>{status?.embeddingModel || "未配置（关键词降级可用）"}</span>
                  <span className="text-tx-tertiary">索引更新时间</span>
                  <span>{formatTime(status?.index.lastIndexedAt)}</span>
                  <span className="text-tx-tertiary">索引覆盖</span>
                  <span>{status ? `${status.index.indexedNotes}/${status.index.totalNotes} 篇笔记，${status.index.indexedAttachments}/${status.index.totalAttachments} 个附件` : "—"}</span>
                  {diagnostics && (
                    <>
                      <span className="text-tx-tertiary">召回路径</span>
                      <span>{diagnostics.retrieval.join(" + ") || "无命中"}</span>
                      <span className="text-tx-tertiary">上下文预算</span>
                      <span>
                        {diagnostics.context.includedChars.toLocaleString()} / {diagnostics.context.originalChars.toLocaleString()} 字
                        {diagnostics.context.truncated ? `，已分段并省略 ${diagnostics.context.omittedChars.toLocaleString()} 字` : "，完整读取"}
                      </span>
                    </>
                  )}
                </div>

                {diagnostics?.hits.length ? (
                  <div className="mt-3 space-y-1.5 border-t border-app-border pt-2">
                    <div className="font-medium text-tx-primary">命中的笔记或分块</div>
                    {diagnostics.hits.map((hit, index) => (
                      <div key={`${hit.kind}-${hit.id}-${index}`} className="rounded-lg bg-app-hover px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-medium text-tx-primary">{index + 1}. {hit.title}</span>
                          <span className="shrink-0 text-tx-tertiary">
                            {hit.rankReason}{hit.score !== undefined ? ` · ${hit.score.toFixed(3)}` : ""}
                          </span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-tx-tertiary">{hit.preview}</p>
                      </div>
                    ))}
                  </div>
                ) : null}

                {diagnostics && (
                  <button
                    type="button"
                    onClick={() => exportDiagnosticsFile(diagnostics)}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-app-border px-2.5 py-1.5 font-medium text-tx-secondary hover:bg-app-hover"
                  >
                    <Download size={12} />
                    导出脱敏诊断 JSON
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <div className={cn("min-h-0 flex-1", (currentNoteUnavailable || selectionUnavailable) && "opacity-70")}>
        <OriginalAIChatPanel {...props} />
      </div>
    </div>
  );
}

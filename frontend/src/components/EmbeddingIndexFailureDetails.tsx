import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, RotateCcw } from "lucide-react";
import { getBaseUrl, getCurrentWorkspace } from "@/lib/api";

interface FailureReason {
  code: string;
  label: string;
  count: number;
  example: string;
}

interface FailureSummary {
  failed: number;
  notes: number;
  attachments: number;
  reasons: FailureReason[];
}

function requestUrl(action: string): string {
  const workspace = getCurrentWorkspace();
  const query = workspace && workspace !== "personal"
    ? `?workspaceId=${encodeURIComponent(workspace)}`
    : "";
  return `${getBaseUrl()}/ai/embeddings/${action}${query}`;
}

async function requestIndex<T>(action: string, method: "GET" | "POST"): Promise<T> {
  const token = localStorage.getItem("nowen-token") || "";
  const response = await fetch(requestUrl(action), {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body as T;
}

/** Failure details are fetched only on demand and scoped to the active workspace. */
export default function EmbeddingIndexFailureDetails({
  failed,
  onRetried,
}: {
  failed: number;
  onRetried: (count: number) => void | Promise<void>;
}) {
  const zh = (localStorage.getItem("i18nextLng") || navigator.language || "").toLowerCase().startsWith("zh");
  const copy = zh ? {
    view: "查看失败原因", hide: "收起失败原因", failed: "失败",
    loading: "正在加载失败原因…", notes: "笔记", attachments: "附件",
    empty: "当前空间已没有失败任务。", retry: "仅重试失败任务",
    confirm: "仅重新处理失败任务？已生成的向量索引会保留，但可能产生 Embedding API 调用费用。",
  } : {
    view: "View failure reasons", hide: "Hide failure reasons", failed: "Failed",
    loading: "Loading failure details…", notes: "Notes", attachments: "Attachments",
    empty: "There are no failed jobs in this workspace.", retry: "Retry failed jobs only",
    confirm: "Retry only failed jobs? Existing vectors will be kept; API usage may incur charges.",
  };
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<FailureSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");

  if (failed <= 0) return null;

  async function loadFailures() {
    setLoading(true);
    setError("");
    try {
      setSummary(await requestIndex<FailureSummary>("failures", "GET"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  async function retryFailed() {
    if (!window.confirm(copy.confirm)) return;
    setRetrying(true);
    setError("");
    try {
      const result = await requestIndex<{ enqueued: number }>("retry-failed", "POST");
      await onRetried(result.enqueued);
      setOpen(false);
      setSummary(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-amber-200 px-3 py-2.5 dark:border-amber-900/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle size={14} /> {copy.failed} {failed}
        </span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            if (!open) void loadFailures();
            setOpen(!open);
          }}
          className="inline-flex items-center gap-1 text-xs text-accent-primary hover:underline"
        >
          {open ? copy.hide : copy.view}
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          {loading ? <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500"><Loader2 size={13} className="animate-spin" /> {copy.loading}</span> : (
            <>
              {summary && <p className="text-[11px] text-zinc-500">{copy.notes} {summary.notes} · {copy.attachments} {summary.attachments}</p>}
              {summary?.reasons.map((reason) => (
                <div key={reason.code} className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/60">
                  <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{reason.label} · {reason.count}</div>
                  <p className="mt-1 break-words text-[11px] text-zinc-500 dark:text-zinc-400">{reason.example}</p>
                </div>
              ))}
              {summary && summary.failed === 0 && <p className="text-xs text-zinc-500">{copy.empty}</p>}
              {summary && summary.failed > 0 && (
                <button
                  type="button"
                  disabled={retrying}
                  onClick={() => void retryFailed()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30"
                >
                  {retrying ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                  {copy.retry}
                </button>
              )}
            </>
          )}
          {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
        </div>
      )}
    </div>
  );
}

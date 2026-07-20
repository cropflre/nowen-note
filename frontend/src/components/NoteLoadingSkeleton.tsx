import { AlertTriangle, ChevronLeft, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NoteLoadingState } from "@/store/AppContext";

interface NoteLoadingSkeletonProps {
  state: NoteLoadingState;
  mode?: "page" | "overlay";
  onRetry: () => void;
  onBack?: () => void;
  loadingLabel: string;
  errorTitle: string;
  errorDescription: string;
  retryLabel: string;
}

export default function NoteLoadingSkeleton({
  state,
  mode = "page",
  onRetry,
  onBack,
  loadingLabel,
  errorTitle,
  errorDescription,
  retryLabel,
}: NoteLoadingSkeletonProps) {
  const title = state.pendingSummary?.title?.trim() || loadingLabel;
  const isError = !!state.error;

  return (
    <div
      className={cn(
        "flex flex-col bg-app-bg overflow-hidden transition-opacity duration-150 ease-out",
        mode === "overlay" ? "absolute inset-0 z-50" : "flex-1",
      )}
      aria-busy={!isError}
      aria-live="polite"
      data-note-loading-state={isError ? "error" : state.slow ? "slow" : "loading"}
    >
      <div className="flex min-h-14 items-center gap-3 border-b border-app-border px-3 md:px-6">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-accent-primary active:bg-app-hover md:hidden"
            aria-label="返回笔记列表"
          >
            <ChevronLeft size={22} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-tx-primary">{title}</div>
          {state.slow && !isError && (
            <div className="mt-0.5 text-[11px] text-tx-tertiary">{loadingLabel}</div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-hidden px-4 py-6 md:px-8">
        <div className="mx-auto w-full max-w-4xl">
          {isError ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-danger/10">
                <AlertTriangle size={22} className="text-accent-danger" />
              </div>
              <h2 className="text-sm font-semibold text-tx-primary">{errorTitle}</h2>
              <p className="mt-2 max-w-sm text-xs leading-relaxed text-tx-tertiary">
                {state.error || errorDescription}
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
              >
                <RefreshCw size={14} />
                {retryLabel}
              </button>
            </div>
          ) : (
            <div className="space-y-6" aria-hidden="true">
              <div className="space-y-2">
                <div className="h-8 w-3/5 rounded-md bg-app-hover animate-pulse motion-reduce:animate-none" />
                <div className="h-3 w-40 rounded bg-app-hover/70 animate-pulse motion-reduce:animate-none" />
              </div>
              <div className="space-y-3">
                {["100%", "92%", "78%", "96%", "68%", "84%"].map((width, index) => (
                  <div
                    key={`${width}-${index}`}
                    className="h-4 rounded bg-app-hover animate-pulse motion-reduce:animate-none"
                    style={{ width }}
                  />
                ))}
              </div>
              <div className="space-y-3 pt-2">
                {["88%", "73%", "58%"].map((width, index) => (
                  <div
                    key={`${width}-${index}`}
                    className="h-4 rounded bg-app-hover/80 animate-pulse motion-reduce:animate-none"
                    style={{ width }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

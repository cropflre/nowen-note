import React from "react";

interface LazyWorkspaceFallbackProps {
  label?: string;
}

export default function LazyWorkspaceFallback({ label = "正在加载工作区…" }: LazyWorkspaceFallbackProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-full min-h-[160px] w-full items-center justify-center bg-app-bg text-sm text-tx-tertiary"
    >
      <span className="inline-flex items-center gap-2">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-app-border border-t-accent-primary" />
        {label}
      </span>
    </div>
  );
}

import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazyAIChatPanel = React.lazy(() => import("./AIChatReliabilityShell"));

interface LazyAIChatPanelRuntimeProps {
  onClose: () => void;
  onNavigateToNote?: (noteId: string) => void;
}

export default function LazyAIChatPanelRuntime(props: LazyAIChatPanelRuntimeProps) {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载 AI 助手…" />}>
      <LazyAIChatPanel {...props} />
    </Suspense>
  );
}

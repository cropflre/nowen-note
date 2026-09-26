import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";
import type { MindMapCenterProps } from "./MindMapEditor";

const LazyMindMapEditor = React.lazy(() => import("./MindMapEditor"));

export default function LazyMindMapEditorRuntime(props: MindMapCenterProps) {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载思维导图…" />}>
      <LazyMindMapEditor {...props} />
    </Suspense>
  );
}

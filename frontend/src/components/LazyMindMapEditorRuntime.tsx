import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazyMindMapEditor = React.lazy(() => import("./MindMapEditor"));

export default function LazyMindMapEditorRuntime() {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载思维导图…" />}>
      <LazyMindMapEditor />
    </Suspense>
  );
}

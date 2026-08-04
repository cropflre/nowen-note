import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazyEditorSplitView = React.lazy(() => import("./EditorSplitView"));

export default function LazyEditorSplitViewRuntime() {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载分屏编辑器…" />}>
      <LazyEditorSplitView />
    </Suspense>
  );
}

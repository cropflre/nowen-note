import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazyNotebookShareJoinView = React.lazy(() => import("./NotebookShareJoinView"));

interface LazyNotebookShareJoinViewRuntimeProps {
  token: string;
}

export default function LazyNotebookShareJoinViewRuntime({ token }: LazyNotebookShareJoinViewRuntimeProps) {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载共享笔记本…" />}>
      <LazyNotebookShareJoinView token={token} />
    </Suspense>
  );
}

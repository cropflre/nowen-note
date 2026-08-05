import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazySharedNoteView = React.lazy(() => import("./SharedNoteCommentDisplayRuntime"));

interface LazySharedNoteViewRuntimeProps {
  shareToken: string;
}

export default function LazySharedNoteViewRuntime({ shareToken }: LazySharedNoteViewRuntimeProps) {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载分享内容…" />}>
      <LazySharedNoteView shareToken={shareToken} />
    </Suspense>
  );
}

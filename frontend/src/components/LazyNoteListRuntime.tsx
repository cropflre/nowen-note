import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazyNoteList = React.lazy(() => import("./NoteList"));

export default function LazyNoteListRuntime() {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载笔记列表…" />}>
      <LazyNoteList />
    </Suspense>
  );
}

import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazyDiaryCenter = React.lazy(() => import("./DiaryCenter"));

export default function LazyDiaryCenterRuntime() {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载日记中心…" />}>
      <LazyDiaryCenter />
    </Suspense>
  );
}

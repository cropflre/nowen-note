import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazyTaskCenter = React.lazy(() => import("./TaskCenter"));

export default function LazyTaskCenterRuntime() {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载任务中心…" />}>
      <LazyTaskCenter />
    </Suspense>
  );
}

import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazyShareManagementPage = React.lazy(() => import("./ShareManagementPage"));

export default function LazyShareManagementPageRuntime() {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载分享管理…" />}>
      <LazyShareManagementPage />
    </Suspense>
  );
}

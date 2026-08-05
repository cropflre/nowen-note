import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazyFileManager = React.lazy(() => import("./FileManager"));

export default function LazyFileManagerRuntime() {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载文件管理…" />}>
      <LazyFileManager />
    </Suspense>
  );
}

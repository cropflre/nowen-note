import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazySidebar = React.lazy(() => import("./Sidebar"));

interface LazySidebarRuntimeProps {
  variant?: "desktop" | "mobile";
}

export default function LazySidebarRuntime(props: LazySidebarRuntimeProps = {}) {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载目录…" />}>
      <LazySidebar {...props} />
    </Suspense>
  );
}

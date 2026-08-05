import React, { Suspense, useEffect, useState } from "react";

const LazyDeferredGlobalFeatureCenters = React.lazy(
  () => import("./DeferredGlobalFeatureCenters"),
);

const TOKEN_KEY = "nowen-token";
const TOKEN_CHANGED_EVENT = "nowen:token-changed";
const IDLE_TIMEOUT_MS = 2_000;

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function hasLoginToken(): boolean {
  try {
    return Boolean(window.localStorage.getItem(TOKEN_KEY));
  } catch {
    return false;
  }
}

/**
 * Keep low-frequency global tools completely out of the unauthenticated login path. Existing
 * sessions load them at the first idle opportunity; a successful same-tab login emits the shared
 * token-changed event and schedules the same work without requiring a reload.
 */
export default function DeferredGlobalFeatureCentersMount() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let disposed = false;
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;

    const cancelScheduledMount = () => {
      const idleWindow = window as IdleWindow;
      if (idleHandle !== null && idleWindow.cancelIdleCallback) {
        idleWindow.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      idleHandle = null;
      timeoutHandle = null;
    };

    const scheduleMount = () => {
      if (disposed || mounted || !hasLoginToken() || idleHandle !== null || timeoutHandle !== null) {
        return;
      }

      const commit = () => {
        idleHandle = null;
        timeoutHandle = null;
        if (!disposed && hasLoginToken()) setMounted(true);
      };
      const idleWindow = window as IdleWindow;
      if (idleWindow.requestIdleCallback) {
        idleHandle = idleWindow.requestIdleCallback(commit, { timeout: IDLE_TIMEOUT_MS });
      } else {
        timeoutHandle = window.setTimeout(commit, 250);
      }
    };

    const syncToken = () => {
      if (hasLoginToken()) scheduleMount();
      else {
        cancelScheduledMount();
        setMounted(false);
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === TOKEN_KEY) syncToken();
    };

    scheduleMount();
    window.addEventListener(TOKEN_CHANGED_EVENT, syncToken);
    window.addEventListener("storage", handleStorage);
    return () => {
      disposed = true;
      cancelScheduledMount();
      window.removeEventListener(TOKEN_CHANGED_EVENT, syncToken);
      window.removeEventListener("storage", handleStorage);
    };
  }, [mounted]);

  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <LazyDeferredGlobalFeatureCenters />
    </Suspense>
  );
}

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  getActiveEditorRuntimeDecision,
  subscribeEditorRuntime,
} from "@/lib/editorRuntimeStore";

export interface LazyNodeViewOptions {
  forceMount?: boolean;
  rootMargin?: string;
  /**
   * In lightweight mode, keep the expensive inner view behind an explicit user action instead of
   * mounting it automatically near the viewport. The ProseMirror wrapper remains mounted.
   */
  manualInLightweight?: boolean;
}

/**
 * Keep the ProseMirror NodeView wrapper mounted while deferring only the expensive inner view.
 * This preserves document positions, selection and transactions, unlike virtualizing the whole
 * contenteditable tree.
 */
export function useLazyNodeView<T extends Element>({
  forceMount = false,
  rootMargin = "900px 0px",
  manualInLightweight = false,
}: LazyNodeViewOptions = {}) {
  const decision = useSyncExternalStore(
    subscribeEditorRuntime,
    getActiveEditorRuntimeDecision,
    getActiveEditorRuntimeDecision,
  );
  const lazyEnabled = !decision.capabilities.eagerHeavyNodes;
  const [element, setElement] = useState<T | null>(null);
  const [nearViewport, setNearViewport] = useState(() => !lazyEnabled);
  const [manualRequested, setManualRequested] = useState(false);

  const observeRef = useCallback((next: T | null) => {
    setElement(next);
  }, []);
  const requestRender = useCallback(() => {
    setManualRequested(true);
  }, []);

  const requiresInteraction =
    lazyEnabled
    && manualInLightweight
    && decision.mode === "lightweight-edit"
    && !forceMount
    && !manualRequested;

  useEffect(() => {
    if (!lazyEnabled || forceMount || manualRequested) {
      setNearViewport(true);
      return;
    }
    if (requiresInteraction) {
      setNearViewport(false);
      return;
    }
    if (!element || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }

    setNearViewport(false);
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNearViewport(true);
    }, { rootMargin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, forceMount, lazyEnabled, manualRequested, requiresInteraction, rootMargin]);

  return {
    decision,
    lazyEnabled,
    requiresInteraction,
    shouldRenderHeavyContent:
      !lazyEnabled || forceMount || manualRequested || (!requiresInteraction && nearViewport),
    observeRef,
    requestRender,
  };
}

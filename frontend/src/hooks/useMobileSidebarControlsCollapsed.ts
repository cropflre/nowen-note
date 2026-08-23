import { useCallback, useSyncExternalStore } from "react";

let collapsed = true;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return collapsed;
}

export function useMobileSidebarControlsCollapsed(): readonly [boolean, (next: boolean) => void] {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setCollapsed = useCallback((next: boolean) => {
    if (collapsed === next) return;
    collapsed = next;
    listeners.forEach((listener) => listener());
  }, []);

  return [current, setCollapsed] as const;
}

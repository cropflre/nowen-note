import { useCallback, useEffect, useState } from "react";

export const MOBILE_RAIL_HIDDEN_STORAGE_KEY = "nowen-mobile-rail-hidden";
export const MOBILE_RAIL_HIDDEN_CHANGED_EVENT = "nowen:mobile-rail-hidden-changed";

export function loadMobileRailHidden(): boolean {
  try {
    const stored = localStorage.getItem(MOBILE_RAIL_HIDDEN_STORAGE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

export function saveMobileRailHidden(hidden: boolean): void {
  try {
    localStorage.setItem(MOBILE_RAIL_HIDDEN_STORAGE_KEY, String(hidden));
  } catch {
    // Keep the in-memory state usable when storage is unavailable.
  }
  window.dispatchEvent(new Event(MOBILE_RAIL_HIDDEN_CHANGED_EVENT));
}

export function useMobileRailHidden(): readonly [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState(loadMobileRailHidden);

  useEffect(() => {
    const sync = () => setHidden(loadMobileRailHidden());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === MOBILE_RAIL_HIDDEN_STORAGE_KEY) sync();
    };

    window.addEventListener(MOBILE_RAIL_HIDDEN_CHANGED_EVENT, sync);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(MOBILE_RAIL_HIDDEN_CHANGED_EVENT, sync);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  const save = useCallback((nextHidden: boolean) => {
    setHidden(nextHidden);
    saveMobileRailHidden(nextHidden);
  }, []);

  return [hidden, save] as const;
}

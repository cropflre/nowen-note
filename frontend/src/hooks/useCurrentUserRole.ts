import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export type CurrentUserRole = { status: "loading" } | { status: "failed" } | { status: "ready"; isAdmin: boolean };

/**
 * Current account role for UI affordances only (the server authorizes every request).
 * Reloads on sign-in or workspace changes and ignores responses from a previous identity.
 */
export function useCurrentUserRole(): { role: CurrentUserRole; retry: () => void } {
  const [role, setRole] = useState<CurrentUserRole>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true, generation = 0;
    const load = async () => {
      const current = ++generation;
      setRole({ status: "loading" });
      try {
        const result = await api.getMe();
        if (active && current === generation) setRole({ status: "ready", isAdmin: result?.role === "admin" });
      } catch {
        if (active && current === generation) setRole({ status: "failed" });
      }
    };
    void load();
    window.addEventListener("nowen:token-changed", load);
    window.addEventListener("nowen:workspace-changed", load);
    return () => {
      active = false; generation++;
      window.removeEventListener("nowen:token-changed", load);
      window.removeEventListener("nowen:workspace-changed", load);
    };
  }, [attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { role, retry };
}

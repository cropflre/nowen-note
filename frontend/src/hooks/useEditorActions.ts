import { useEffect, useState } from "react";
import { pluginApi, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT } from "@/lib/pluginApi";
import { currentUiPlatform } from "@/lib/pluginUiRegistry";
import { registerEditorActions, type RegisteredEditorAction } from "@/lib/editorActions/registry";

let cache: Promise<RegisteredEditorAction[]> | null = null;
const subscribers = new Set<() => void>();
let listening = false;

function invalidate() {
  cache = null;
  for (const notify of subscribers) notify();
}

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  for (const event of [PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, "nowen:token-changed", "nowen:workspace-changed"]) window.addEventListener(event, invalidate);
}

/** One request pair per session (and after every contribution, account or workspace change), shared by all editors. */
function load(): Promise<RegisteredEditorAction[]> {
  if (!cache) {
    const platform = currentUiPlatform();
    // Plugin UI inside the native apps is planned separately; their editors keep working without extensions.
    const pending = platform !== "web" && platform !== "desktop" ? Promise.resolve([])
      : pluginApi.features().then(async (features) => (features.editorActions ? registerEditorActions(await pluginApi.contributions(), platform) : []));
    cache = pending.catch(() => { cache = null; return []; });
  }
  return cache;
}

export function useEditorActions(enabled: boolean): RegisteredEditorAction[] {
  const [actions, setActions] = useState<RegisteredEditorAction[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    listen();
    const bump = () => setVersion((value) => value + 1);
    subscribers.add(bump);
    return () => { subscribers.delete(bump); };
  }, []);
  useEffect(() => {
    if (!enabled) { setActions((current) => (current.length ? [] : current)); return; }
    let active = true;
    void load().then((list) => { if (active) setActions(list); });
    return () => { active = false; };
  }, [enabled, version]);
  return actions;
}

/** Test helper: forget the cached list. */
export function resetEditorActionsCache(): void {
  cache = null;
}

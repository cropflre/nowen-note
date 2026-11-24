import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  pluginApi, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT,
  type ExtensionPlatformFeatureFlags, type InstalledPlugin, type RegistrySource,
} from "@/lib/pluginApi";
import { buildExtensionListings, type CatalogSourceResult, type ExtensionListing } from "@/lib/extensionCatalog";
import { currentUiPlatform } from "@/lib/pluginUiRegistry";
import { builtinTextKey, describeExtensionError } from "./extensionCenterUi";

export interface ExtensionCatalogState {
  status: "idle" | "loading" | "ready" | "error";
  /** True while a background refresh runs; the previous listings stay visible. */
  refreshing: boolean;
  /** Registry indexes are still being fetched; installed plugins and built-ins are already shown. */
  catalogPending: boolean;
  error?: string;
  listings: ExtensionListing[];
  sourceErrors: Array<{ source: RegistrySource; message: string }>;
  sourceCount: number;
  features?: ExtensionPlatformFeatureFlags;
}

const EMPTY: ExtensionCatalogState = { status: "idle", refreshing: false, catalogPending: false, listings: [], sourceErrors: [], sourceCount: 0 };
/** A slow or unreachable Registry must not keep the page waiting; the server keeps its own fetch limits. */
export const REGISTRY_INDEX_TIMEOUT_MS = 20_000;

/**
 * Loads the server's view of installed plugins first, then every enabled, verified Registry source in
 * the background. One failing source never hides the others; nothing is cached across identities.
 */
export function useExtensionCatalog(options: { enabled: boolean; isAdmin: boolean; dashboardAvailable: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<ExtensionCatalogState>(EMPTY);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  /** Last verified index per source for this identity, so refreshes do not flash registry cards away. */
  const indexCache = useRef(new Map<string, CatalogSourceResult>());
  const tRef = useRef(t); tRef.current = t;

  const load = useCallback(async (reset: boolean) => {
    if (!options.enabled) return;
    const current = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    if (reset) indexCache.current.clear();
    setState((previous) => reset || previous.status !== "ready" ? { ...EMPTY, status: "loading" } : { ...previous, refreshing: true });
    const translate = tRef.current;
    let features: ExtensionPlatformFeatureFlags, installed: InstalledPlugin[], sources: RegistrySource[];
    try {
      [features, installed, sources] = await Promise.all([
        pluginApi.features(),
        pluginApi.list(),
        pluginApi.registrySources().catch(() => [] as RegistrySource[]),
      ]);
    } catch (error) {
      if (current === generation.current) setState({ ...EMPTY, status: "error", error: describeExtensionError(error, translate) });
      return;
    }
    const policy = options.isAdmin ? await pluginApi.getRuntimePolicy().catch(() => null) : null;
    if (current !== generation.current) return;
    const enabledSources = sources.filter((source) => source.enabled);
    const build = (results: CatalogSourceResult[]) => buildExtensionListings({
      sources: results,
      installed,
      isAdmin: options.isAdmin,
      nowenVersion: features.currentNowenVersion,
      runtimePlatform: features.runtimePlatform,
      uiPlatform: currentUiPlatform(),
      nodeRuntimeAllowed: policy ? policy.allowNodeRuntime : null,
      dashboardAvailable: options.dashboardAvailable,
      builtinText: (id) => ({
        name: translate(`extensionCenter.builtin.${builtinTextKey(id)}.name`),
        description: translate(`extensionCenter.builtin.${builtinTextKey(id)}.description`),
      }),
    });
    const cached = enabledSources.flatMap((source) => {
      const hit = indexCache.current.get(source.id);
      return hit?.index ? [{ source, index: hit.index }] : [];
    });
    setState({
      status: "ready", refreshing: false, catalogPending: enabledSources.length > 0,
      listings: build(cached), features, sourceCount: enabledSources.length, sourceErrors: [],
    });

    const results: CatalogSourceResult[] = await Promise.all(enabledSources.map(async (source) => {
      // Each source gets its own deadline so one slow Registry cannot cancel the others.
      const sourceAbort = new AbortController();
      const cancel = () => sourceAbort.abort();
      abort.signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, REGISTRY_INDEX_TIMEOUT_MS);
      try { return { source, index: await pluginApi.registryIndex(source.id, sourceAbort.signal) }; }
      catch (error) {
        const timedOut = (error as { name?: string }).name === "AbortError";
        return { source, error: { code: (error as { code?: string }).code, message: timedOut ? translate("extensionCenter.error.network") : describeExtensionError(error, translate, { raw: true }) } };
      } finally {
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", cancel);
      }
    }));
    if (current !== generation.current) return;
    for (const result of results) if (result.index) indexCache.current.set(result.source.id, result);
    setState({
      status: "ready", refreshing: false, catalogPending: false, listings: build(results), features, sourceCount: enabledSources.length,
      sourceErrors: results.flatMap((result) => result.error ? [{ source: result.source, message: result.error.message }] : []),
    });
  }, [options.enabled, options.isAdmin, options.dashboardAvailable]);

  useEffect(() => {
    if (!options.enabled) { generation.current++; indexCache.current.clear(); setState(EMPTY); return; }
    void load(true);
    const refresh = () => { void load(false); };
    const reset = () => { void load(true); };
    window.addEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("nowen:token-changed", reset);
    window.addEventListener("nowen:workspace-changed", reset);
    return () => {
      generation.current++;
      controller.current?.abort();
      window.removeEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("nowen:token-changed", reset);
      window.removeEventListener("nowen:workspace-changed", reset);
    };
  }, [load, options.enabled]);

  const reload = useCallback(() => { void load(false); }, [load]);
  return { state, reload };
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, ChevronDown, Loader2 } from "lucide-react";
import { aiProfiles, emitAIProfilesChanged, getAIProfilesScope, type AvailableAIProfiles, type AIProfileSelection } from "@/lib/aiProfiles";

function getCopy() {
  const language = (localStorage.getItem("i18nextLng") || navigator.language || "").toLowerCase();
  return language.startsWith("zh")
    ? { label: "AI 配置", empty: "暂无 AI 配置", personal: "个人配置", shared: "共享配置 · 管理员提供", unavailable: "当前共享配置不可用，请重新选择模型" }
    : { label: "AI profile", empty: "No AI profiles", personal: "Personal profiles", shared: "Shared · administrator provided", unavailable: "Shared profile unavailable. Choose another model." };
}

function ensureHost(): HTMLElement | null {
  const header = document.querySelector<HTMLElement>("[data-ai-chat-header]");
  if (!header) return null;
  const existing = header.querySelector<HTMLElement>("[data-nowen-ai-profile-switcher-host]");
  if (existing) return existing;

  const host = document.createElement("div");
  host.setAttribute("data-nowen-ai-profile-switcher-host", "1");
  host.className = "col-span-2 row-start-2 ml-auto mr-1 min-w-0 shrink md:col-auto md:row-auto";
  const actions = header.lastElementChild;
  if (actions) header.insertBefore(host, actions);
  else header.appendChild(host);
  return host;
}

export default function AIProfileSwitcherBridge() {
  const copy = useMemo(getCopy, []);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [available, setAvailable] = useState<AvailableAIProfiles | null>(null);
  const [error, setError] = useState("");
  const loadSeq = useRef(0);
  const identity = useRef(getAIProfilesScope());
  const [switching, setSwitching] = useState(false);
  const frameRef = useRef<number | null>(null);
  const previousHostRef = useRef<HTMLElement | null>(null);

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    const scope = getAIProfilesScope();
    try {
      const result = await aiProfiles.available();
      if (seq !== loadSeq.current || scope !== getAIProfilesScope()) return;
      setAvailable(result);
      setError("");
    } catch (error) {
      if (seq !== loadSeq.current || scope !== getAIProfilesScope()) return;
      setAvailable(null);
      setError((error as Error).message);
    }
  }, []);

  const reconcile = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const nextHost = ensureHost();
      setHost(nextHost);
      if (nextHost && nextHost !== previousHostRef.current) {
        previousHostRef.current = nextHost;
        void reload();
      }
      if (!nextHost) previousHostRef.current = null;
    });
  }, [reload]);

  useEffect(() => {
    reconcile();
    const observer = new MutationObserver(reconcile);
    observer.observe(document.body, { childList: true, subtree: true });
    const onProfilesChanged = () => { void reload(); };
    const reset = () => {
      if (identity.current === getAIProfilesScope()) return;
      identity.current = getAIProfilesScope();
      loadSeq.current++; setAvailable(null); setError(""); void reload();
    };
    window.addEventListener("nowen:ai-profiles-changed", onProfilesChanged);
    window.addEventListener("focus", onProfilesChanged);
    window.addEventListener("nowen:token-changed", reset);
    window.addEventListener("nowen:server-url-changed", reset);
    window.addEventListener("nowen:mobile-local-mode-changed", reset);
    window.addEventListener("storage", reset);
    return () => {
      loadSeq.current++;
      observer.disconnect();
      window.removeEventListener("nowen:ai-profiles-changed", onProfilesChanged);
      window.removeEventListener("focus", onProfilesChanged);
      window.removeEventListener("nowen:token-changed", reset);
      window.removeEventListener("nowen:server-url-changed", reset);
      window.removeEventListener("nowen:mobile-local-mode-changed", reset);
      window.removeEventListener("storage", reset);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [reconcile, reload]);

  const directoryError = error || available?.remoteError || "";
  const selectedValue = available ? `${available.active.scope}:${available.active.id}` : "";
  const handleChange = useCallback(async (value: string) => {
    if (!value || value === selectedValue || switching || !available) return;
    const separator = value.indexOf(":");
    const active = { scope: value.slice(0, separator), id: value.slice(separator + 1) } as AIProfileSelection;
    const scope = getAIProfilesScope();
    setSwitching(true); setError("");
    try {
      if (available.sharedSupported) await aiProfiles.activateSelection(active);
      else await aiProfiles.activate(active.id);
      if (scope !== getAIProfilesScope()) return;
      await reload();
      emitAIProfilesChanged(active.id);
    } catch (error) {
      if (scope === getAIProfilesScope()) setError((error as Error).message);
    } finally {
      setSwitching(false);
    }
  }, [selectedValue, switching, available, reload]);

  if (!host) return null;

  return createPortal(
    <label className="relative flex min-w-0 max-w-[220px] items-center">
      <span className="sr-only">{copy.label}</span>
      <Bot size={12} className="pointer-events-none absolute left-2 text-violet-500" />
      <select
        value={selectedValue}
        disabled={switching || !available}
        onChange={(event) => void handleChange(event.target.value)}
        onFocus={() => void reload()}
        title={directoryError || (available?.unavailable ? copy.unavailable : copy.label)}
        className="h-8 w-[104px] min-w-0 appearance-none truncate rounded-lg border border-app-border bg-app-bg pl-6 pr-6 text-[10px] font-medium text-tx-secondary outline-none transition-colors hover:border-accent-primary/40 focus:border-accent-primary disabled:opacity-50 sm:w-[168px] sm:text-[11px]"
      >
        {!available && <option value="">{copy.empty}</option>}
        {available?.unavailable && <option value={selectedValue} disabled>{copy.unavailable}</option>}
        {available && <optgroup label={copy.personal}>
          {available.personalProfiles.map((profile) => <option key={profile.id} value={`personal:${profile.id}`}>{profile.name} · {profile.model || profile.provider}</option>)}
        </optgroup>}
        {!!available?.sharedProfiles.length && <optgroup label={copy.shared}>
          {available.sharedProfiles.map((profile) => <option key={profile.id} value={`shared:${profile.id}`}>{profile.name} · {profile.model || profile.provider}</option>)}
        </optgroup>}
      </select>
      {directoryError && <span role="alert" className="sr-only">{directoryError}</span>}
      {switching
        ? <Loader2 size={12} className="pointer-events-none absolute right-2 animate-spin text-accent-primary" />
        : <ChevronDown size={12} className="pointer-events-none absolute right-2 text-tx-tertiary" />}
    </label>,
    host,
  );
}

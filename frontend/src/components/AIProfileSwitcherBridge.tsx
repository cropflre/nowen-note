import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, ChevronDown, Loader2 } from "lucide-react";
import { aiProfiles, emitAIProfilesChanged, type AIProfile } from "@/lib/aiProfiles";

function getCopy() {
  const language = (localStorage.getItem("i18nextLng") || navigator.language || "").toLowerCase();
  return language.startsWith("zh")
    ? { label: "AI 配置", empty: "暂无 AI 配置" }
    : { label: "AI profile", empty: "No AI profiles" };
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
  const [profiles, setProfiles] = useState<AIProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [switching, setSwitching] = useState(false);
  const frameRef = useRef<number | null>(null);
  const previousHostRef = useRef<HTMLElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await aiProfiles.list();
      setProfiles(result.profiles);
      setActiveProfileId(result.activeProfileId);
    } catch {
      setProfiles([]);
      setActiveProfileId("");
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
    window.addEventListener("nowen:ai-profiles-changed", onProfilesChanged);
    return () => {
      observer.disconnect();
      window.removeEventListener("nowen:ai-profiles-changed", onProfilesChanged);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [reconcile, reload]);

  const handleChange = useCallback(async (profileId: string) => {
    if (!profileId || profileId === activeProfileId || switching) return;
    setSwitching(true);
    try {
      const result = await aiProfiles.activate(profileId);
      setActiveProfileId(result.activeProfileId);
      emitAIProfilesChanged(result.activeProfileId);
    } catch (error) {
      console.warn("[ai-profile-switcher] activation failed", error);
    } finally {
      setSwitching(false);
    }
  }, [activeProfileId, switching]);

  if (!host) return null;

  return createPortal(
    <label className="relative flex min-w-0 max-w-[220px] items-center">
      <span className="sr-only">{copy.label}</span>
      <Bot size={12} className="pointer-events-none absolute left-2 text-violet-500" />
      <select
        value={activeProfileId}
        disabled={switching || profiles.length === 0}
        onChange={(event) => void handleChange(event.target.value)}
        title={copy.label}
        className="h-8 w-[104px] min-w-0 appearance-none truncate rounded-lg border border-app-border bg-app-bg pl-6 pr-6 text-[10px] font-medium text-tx-secondary outline-none transition-colors hover:border-accent-primary/40 focus:border-accent-primary disabled:opacity-50 sm:w-[168px] sm:text-[11px]"
      >
        {profiles.length === 0 ? (
          <option value="">{copy.empty}</option>
        ) : profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name} · {profile.model || profile.provider}
          </option>
        ))}
      </select>
      {switching
        ? <Loader2 size={12} className="pointer-events-none absolute right-2 animate-spin text-accent-primary" />
        : <ChevronDown size={12} className="pointer-events-none absolute right-2 text-tx-tertiary" />}
    </label>,
    host,
  );
}

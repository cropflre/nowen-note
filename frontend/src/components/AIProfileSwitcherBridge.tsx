import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, ChevronDown, Loader2 } from "lucide-react";
import { aiProfiles, emitAIProfilesChanged, type AIProfile } from "@/lib/aiProfiles";

function getCopy() {
  const language = (localStorage.getItem("i18nextLng") || navigator.language || "").toLowerCase();
  return language.startsWith("zh")
    ? { label: "AI 配置", loading: "切换中", empty: "暂无 AI 配置", failed: "切换 AI 配置失败" }
    : { label: "AI profile", loading: "Switching", empty: "No AI profiles", failed: "Failed to switch AI profile" };
}

function findAIChatHeader(): HTMLElement | null {
  const roots = Array.from(document.querySelectorAll<HTMLElement>("div.flex.h-full.bg-app-bg"));
  for (const root of roots) {
    const children = Array.from(root.children) as HTMLElement[];
    if (children.length < 2) continue;
    const sidebar = children[0];
    const main = children[1];
    if (sidebar.tagName !== "ASIDE" || !sidebar.className.includes("border-r")) continue;
    if (!main.className.includes("flex-col") || !main.className.includes("flex-1")) continue;
    const header = Array.from(main.children).find((child) => {
      const element = child as HTMLElement;
      return element.className.includes("border-b") && element.className.includes("justify-between");
    }) as HTMLElement | undefined;
    if (header) return header;
  }
  return null;
}

function ensureHost(): HTMLElement | null {
  const header = findAIChatHeader();
  if (!header) return null;
  const existing = header.querySelector<HTMLElement>("[data-nowen-ai-profile-switcher-host]");
  if (existing) return existing;

  const host = document.createElement("div");
  host.setAttribute("data-nowen-ai-profile-switcher-host", "1");
  host.className = "ml-auto mr-1 min-w-0";
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

  const reconcile = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setHost(ensureHost());
    });
  }, []);

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

  useEffect(() => {
    reconcile();
    void reload();
    const observer = new MutationObserver(reconcile);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("nowen:ai-profiles-changed", reload as EventListener);
    return () => {
      observer.disconnect();
      window.removeEventListener("nowen:ai-profiles-changed", reload as EventListener);
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
    <label className="relative flex items-center min-w-0 max-w-[220px]">
      <span className="sr-only">{copy.label}</span>
      <Bot size={12} className="absolute left-2.5 text-violet-500 pointer-events-none" />
      <select
        value={activeProfileId}
        disabled={switching || profiles.length === 0}
        onChange={(event) => void handleChange(event.target.value)}
        title={copy.label}
        className="h-8 min-w-[128px] max-w-[220px] appearance-none rounded-lg border border-app-border bg-app-bg pl-7 pr-7 text-[11px] font-medium text-tx-secondary outline-none transition-colors hover:border-accent-primary/40 focus:border-accent-primary disabled:opacity-50"
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
        ? <Loader2 size={12} className="absolute right-2 animate-spin text-accent-primary pointer-events-none" />
        : <ChevronDown size={12} className="absolute right-2 text-tx-tertiary pointer-events-none" />}
    </label>,
    host,
  );
}

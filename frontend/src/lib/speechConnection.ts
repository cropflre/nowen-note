import { useSyncExternalStore } from "react";
import { voiceApi } from "@/lib/api";
import { getAIProfilesScope } from "@/lib/aiProfiles";
import { getAccessToken } from "@/lib/authSession";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";

const listeners = new Set<() => void>();
let check: { scope: string; available: boolean } | null = null;
let listening = false;

export function getSpeechConnectionScope(): string | null {
  return getAccessToken() && !isMobileLocalMode() ? getAIProfilesScope() : null;
}

function publish() {
  listeners.forEach(listener => listener());
}

export async function verifySpeechConnection(scope: string | null, configured?: boolean): Promise<boolean> {
  if (!scope || scope !== getSpeechConnectionScope()) return false;
  listenForScopeChanges();
  const pending = { scope, available: false };
  const isCurrent = () => check === pending && scope === getSpeechConnectionScope();
  check = pending;
  publish();

  if (!(configured ?? (await voiceApi.settings()).configured) || !isCurrent()) return false;
  const { success } = await voiceApi.test();
  if (!isCurrent() || success !== true) return false;
  pending.available = true;
  publish();
  return true;
}

function refresh() {
  const scope = getSpeechConnectionScope();
  if (scope === check?.scope) return;
  if (scope && listeners.size) void verifySpeechConnection(scope).catch(() => undefined);
  else {
    check = null;
    publish();
  }
}

export function refreshSpeechConnectionAfterSave(scope: string | null) {
  if (!scope || scope !== getSpeechConnectionScope()) return;
  check = null;
  if (listeners.size) refresh();
}

const scopeEvents = ["storage", "nowen:token-changed", "nowen:server-url-changed", "nowen:mobile-local-mode-changed"];

function listenForScopeChanges() {
  if (listening) return;
  listening = true;
  scopeEvents.forEach(event => window.addEventListener(event, refresh));
  window.addEventListener("online", () => {
    if (!check?.available) check = null;
    refresh();
  });
}

function subscribe(listener: () => void) {
  listenForScopeChanges();
  listeners.add(listener);
  refresh();
  return () => { listeners.delete(listener); };
}

export function useSpeechConnectionAvailable(): boolean {
  return useSyncExternalStore(subscribe, () => Boolean(check?.available && check.scope === getSpeechConnectionScope()), () => false);
}

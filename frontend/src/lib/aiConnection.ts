import { useSyncExternalStore } from "react";
import { aiProfiles, getAIProfilesScope, type AIProfile, type AvailableAIProfiles, type SharedAIProfile } from "@/lib/aiProfiles";
import { getAccessToken } from "@/lib/authSession";
import { getNonChatModelKind } from "@/lib/chatModelType";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";

const listeners = new Set<() => void>();
let available = false;
let scope: string | null = null;
let verifiedProfile: string | null = null;
let pendingVerification: { scope: string; profile: string; success: boolean } | null = null;
let requestVersion = 0;
let checking = false;

function getConnectionScope(): string | null {
  return getAccessToken() && !isMobileLocalMode() ? getAIProfilesScope() : null;
}

function profileKey(profile: AIProfile | SharedAIProfile) {
  const shared = "enabled" in profile;
  return JSON.stringify([
    shared ? "shared" : "personal",
    profile.id,
    profile.provider,
    profile.model,
    shared ? undefined : profile.apiUrl,
    profile.updatedAt,
    "revision" in profile ? profile.revision : undefined,
  ]);
}

function activeProfileKey(directory: AvailableAIProfiles) {
  if (!directory.aiEnabled || directory.unavailable) return null;
  if (directory.active.scope === "shared") {
    const profile = directory.sharedProfiles.find(({ id }) => id === directory.active.id);
    return profile?.enabled && profile.model && !getNonChatModelKind(profile.model) ? profileKey(profile) : null;
  }
  const profile = directory.personalProfiles.find(({ id }) => id === directory.active.id);
  if (!profile?.apiUrl || !profile.model || getNonChatModelKind(profile.model)) return null;
  const hasAuth = profile.apiKeySet || Object.values(profile.customHeaders || {}).some(Boolean)
    || profile.provider === "ollama" || profile.provider === "lmstudio";
  return hasAuth ? profileKey(profile) : null;
}

function publish(next: boolean) {
  if (available === next) return;
  available = next;
  listeners.forEach(listener => listener());
}

async function refresh(restart = false) {
  const nextScope = getConnectionScope();
  if (scope !== nextScope) {
    scope = nextScope;
    verifiedProfile = null;
    if (pendingVerification?.scope !== nextScope) pendingVerification = null;
    requestVersion++;
    checking = false;
    publish(false);
  }
  if (!nextScope || (!restart && checking)) return;

  const version = ++requestVersion;
  checking = true;
  const isCurrent = () => version === requestVersion && nextScope === getConnectionScope();
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timeout = setTimeout(abort, 12_000);

  try {
    const directory = await aiProfiles.available({ activeOnly: true, signal: controller.signal });
    if (!isCurrent()) return;
    const key = activeProfileKey(directory);
    const explicitResult = pendingVerification?.scope === nextScope && pendingVerification.profile === key
      ? pendingVerification.success
      : undefined;
    pendingVerification = null;
    const alreadyVerified = key !== null && (explicitResult ?? (key === verifiedProfile));
    verifiedProfile = alreadyVerified ? key : null;
    publish(alreadyVerified);
    if (!key || alreadyVerified || explicitResult === false) return;

    clearTimeout(timeout);
    timeout = setTimeout(abort, 20_000);
    const result = await aiProfiles.testActive(controller.signal);
    if (!isCurrent() || result.success !== true) return;
    verifiedProfile = key;
    publish(true);
  } catch {
    if (isCurrent() && (restart || navigator.onLine !== false)) {
      verifiedProfile = null;
      publish(false);
    }
  } finally {
    clearTimeout(timeout);
    if (version === requestVersion) checking = false;
  }
}

/** Reuse the Settings test when it describes the current saved profile. */
export function rememberAIProfileConnection(profile: AIProfile | SharedAIProfile, success: boolean) {
  const currentScope = getConnectionScope();
  if (!currentScope) return;
  const key = profileKey(profile);
  pendingVerification = { scope: currentScope, profile: key, success };
  if (!success && currentScope === scope && key === verifiedProfile) {
    verifiedProfile = null;
    publish(false);
  }
}

const recheck = () => void refresh();
const onScopeChanged = () => {
  if (scope !== getConnectionScope()) recheck();
};
const invalidateAndRecheck = () => {
  verifiedProfile = null;
  publish(false);
  void refresh(true);
};
const onProfilesChanged = () => void refresh(true);
const events = {
  focus: recheck,
  online: recheck,
  storage: onScopeChanged,
  "nowen:token-changed": onScopeChanged,
  "nowen:server-url-changed": onScopeChanged,
  "nowen:mobile-local-mode-changed": onScopeChanged,
  "nowen:ai-manual-enabled-changed": invalidateAndRecheck,
  "nowen:ai-profiles-changed": onProfilesChanged,
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    Object.entries(events).forEach(([event, callback]) => window.addEventListener(event, callback));
    recheck();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    Object.entries(events).forEach(([event, callback]) => window.removeEventListener(event, callback));
    scope = null;
    verifiedProfile = null;
    pendingVerification = null;
    requestVersion++;
    checking = false;
    publish(false);
  };
}

export function useAIConnectionAvailable(): boolean {
  return useSyncExternalStore(subscribe, () => available, () => false);
}

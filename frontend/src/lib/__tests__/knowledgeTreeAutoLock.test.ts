// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installKnowledgeTreeAutoLock,
  shouldLockAfterBackground,
  shouldLockAfterIdle,
} from "@/lib/knowledgeTreeAutoLock";
import {
  KNOWLEDGE_TREE_PASSWORD_LOCKED_EVENT,
  loadUnlockedFolderIds,
  rememberUnlockedFolder,
} from "@/lib/knowledgeTreePassword";
import { normalizeUserPreferences } from "@/lib/userPreferenceAccountCache";

function token(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `header.${encoded}.signature`;
}

describe("knowledge tree folder auto lock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T08:00:00.000Z"));
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("nowen-token", token({ userId: "user-1" }));
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("locks an unlocked folder after the configured idle interval", () => {
    rememberUnlockedFolder("folder-1", token({
      userId: "user-1",
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    }));
    const reasons: string[] = [];
    const listener = (event: Event) => reasons.push((event as CustomEvent).detail.reason);
    window.addEventListener(KNOWLEDGE_TREE_PASSWORD_LOCKED_EVENT, listener);

    const cleanup = installKnowledgeTreeAutoLock({ idleMinutes: 5, lockOnBackground: true });
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(loadUnlockedFolderIds().size).toBe(0);
    expect(reasons).toContain("idle");
    cleanup();
    window.removeEventListener(KNOWLEDGE_TREE_PASSWORD_LOCKED_EVENT, listener);
  });

  it("locks after the app stays in the background for five minutes", () => {
    rememberUnlockedFolder("folder-2", token({
      userId: "user-1",
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    }));
    const cleanup = installKnowledgeTreeAutoLock({ idleMinutes: 60, lockOnBackground: true });

    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(loadUnlockedFolderIds().size).toBe(0);
    cleanup();
  });

  it("keeps the session unlocked in background when that option is disabled", () => {
    rememberUnlockedFolder("folder-3", token({
      userId: "user-1",
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    }));
    const cleanup = installKnowledgeTreeAutoLock({ idleMinutes: 60, lockOnBackground: false });

    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(loadUnlockedFolderIds().has("folder-3")).toBe(true);
    cleanup();
  });

  it("normalizes the synced account preference to safe supported values", () => {
    expect(normalizeUserPreferences({ folderAutoLockMinutes: 30 }).folderAutoLockMinutes).toBe(30);
    expect(normalizeUserPreferences({ folderAutoLockMinutes: 10 }).folderAutoLockMinutes).toBe(15);
    expect(normalizeUserPreferences({ folderLockOnBackground: false }).folderLockOnBackground).toBe(false);
  });

  it("exposes deterministic idle and background deadline helpers", () => {
    expect(shouldLockAfterIdle(0, 5 * 60 * 1000, 5)).toBe(true);
    expect(shouldLockAfterIdle(0, 60 * 60 * 1000, 0)).toBe(false);
    expect(shouldLockAfterBackground(0, 5 * 60 * 1000)).toBe(true);
  });
});

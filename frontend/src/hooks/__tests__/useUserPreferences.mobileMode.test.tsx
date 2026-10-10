import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserPreferencesProvider, useUserPreferences } from "../useUserPreferences";
import { DEFAULT_USER_PREFERENCES, readAccountPreferenceCache } from "@/lib/userPreferenceAccountCache";
import { enterMobileLocalMode, requestMobileAccountLogin, MOBILE_LOCAL_USER_ID } from "@/lib/mobileLocalMode";
import { setMobileSyncEnabled } from "@/lib/mobileSyncStatus";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { getUserPreferences: mocks.get, updateUserPreferences: mocks.put } }));
vi.mock("@/lib/knowledgeTreeAutoLock", () => ({ installKnowledgeTreeAutoLock: () => () => {} }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLElement;
let preferences: ReturnType<typeof useUserPreferences>;
const token = (userId: string) => `header.${btoa(JSON.stringify({userId}))}.sig`;
const remote = (userId = "account") => ({
  ...DEFAULT_USER_PREFERENCES, userId, hasPreferences: true, revision: 7,
  defaultEditorMode: "md", readingDensity: "compact", codeBlockTheme: "dracula",
  hiddenNavigationModules: ["shares"],
});
function Probe() {
  preferences = useUserPreferences();
  return <span>{JSON.stringify(preferences.prefs)}</span>;
}
const mount = async () => { await act(async () => root.render(<UserPreferencesProvider><Probe /></UserPreferencesProvider>)); };
beforeEach(() => {
  localStorage.clear(); mocks.get.mockReset(); mocks.put.mockReset();
  Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
  setMobileSyncEnabled(true);
  localStorage.setItem("nowen-token", token("account"));
  mocks.get.mockResolvedValue(remote());
  mocks.put.mockImplementation(async (patch) => ({ ...remote(), ...patch, revision: 8 }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(window,"Capacitor"); });
describe("account preferences across Android device-only mode", () => {
  it("keeps account settings local while sync is off, then uploads them after enabling sync", async () => {
    await mount();
    await act(async () => setMobileSyncEnabled(false));
    mocks.get.mockClear(); mocks.put.mockClear();
    await act(async () => preferences.setPref("codeBlockTheme", "github-light"));
    await act(async () => window.dispatchEvent(new Event("online")));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(readAccountPreferenceCache(localStorage, "account")?.pending.codeBlockTheme).toBe("github-light");
    await act(async () => setMobileSyncEnabled(true));
    expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({ codeBlockTheme: "github-light" }));
    expect(preferences.prefs.codeBlockTheme).toBe("github-light");
  });
  it("restores synced account preferences after device-only preferences change", async () => {
    await mount();
    expect(preferences.prefs.defaultEditorMode).toBe("md");
    await act(async () => enterMobileLocalMode());
    expect(preferences.prefs.readingDensity).toBe(DEFAULT_USER_PREFERENCES.readingDensity);
    await act(async () => preferences.setPref("codeBlockTheme", "github-light"));
    await act(async () => preferences.setPref("defaultEditorMode", "tiptap"));
    expect(readAccountPreferenceCache(localStorage, MOBILE_LOCAL_USER_ID)?.prefs.codeBlockTheme).toBe("github-light");
    expect(mocks.put).not.toHaveBeenCalled();
    await act(async () => requestMobileAccountLogin());
    expect(preferences.prefs).toMatchObject({
      defaultEditorMode: "md", readingDensity: "compact", codeBlockTheme: "dracula", hiddenNavigationModules: ["shares"],
    });
    expect(mocks.put).not.toHaveBeenCalled();
    expect(readAccountPreferenceCache(localStorage, "account")?.prefs.codeBlockTheme).toBe("dracula");
  });
  it("retries offline preference patches when the network returns", async () => {
    await mount(); mocks.put.mockRejectedValueOnce(new Error("offline"));
    await act(async () => preferences.setPref("readingDensity", "cozy"));
    expect(readAccountPreferenceCache(localStorage, "account")?.pending.readingDensity).toBe("cozy");
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(preferences.prefs.readingDensity).toBe("cozy");
    expect(readAccountPreferenceCache(localStorage, "account")?.pending).toEqual({});
  });
  it("ignores an old account response after switching to another account", async () => {
    let finish!: (value: unknown) => void;
    mocks.get.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await mount();
    mocks.get.mockResolvedValue({ ...remote("other"), codeBlockTheme: "github-light" });
    await act(async () => {
      localStorage.setItem("nowen-token", token("other"));
      window.dispatchEvent(new Event("nowen:token-changed"));
    });
    await act(async () => finish(remote()));
    expect(preferences.prefs.codeBlockTheme).toBe("github-light");
  });
});

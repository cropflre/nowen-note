import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailableAIProfiles } from "@/lib/aiProfiles";

const mocks = vi.hoisted(() => ({
  scope: "server:account-a",
  available: vi.fn(),
  testActive: vi.fn(),
}));
vi.mock("@/lib/aiProfiles", () => ({ aiProfiles: mocks, getAIProfilesScope: () => mocks.scope }));

import { rememberAIProfileConnection, useAIConnectionAvailable } from "@/lib/aiConnection";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const personal = {
  id: "my-profile", name: "My AI", provider: "custom", apiUrl: "https://ai.example.test/v1", apiKey: "****",
  apiKeySet: true, model: "chat", createdAt: "v1", updatedAt: "v1",
};
const shared = { id: "team-ai", name: "Team AI", provider: "custom", model: "team-chat", enabled: true, revision: 1 };
const directory: AvailableAIProfiles = {
  aiEnabled: true, unavailable: false, sharedSupported: true, isAdmin: false,
  personalProfiles: [personal], sharedProfiles: [shared], active: { scope: "personal", id: personal.id },
};

function AIEntry() {
  return useAIConnectionAvailable() ? <button>AI Chat</button> : null;
}

describe("AI connection availability", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.scope = "server:account-a";
    mocks.available.mockResolvedValue(directory);
    mocks.testActive.mockResolvedValue({ success: true });
    localStorage.setItem("nowen-token", "session");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("skips probing an empty default configuration", async () => {
    mocks.available.mockResolvedValue({ ...directory, personalProfiles: [{ ...personal, apiKey: "", apiKeySet: false }] });
    await act(async () => root.render(<AIEntry />));
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.testActive).not.toHaveBeenCalled();
  });

  it("keeps multiple entry points hidden until their one probe succeeds", async () => {
    let finish!: (result: { success: boolean }) => void;
    mocks.testActive.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<><AIEntry /><AIEntry /></>));
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.available).toHaveBeenCalledTimes(1);
    expect(mocks.testActive).toHaveBeenCalledTimes(1);

    await act(async () => finish({ success: true }));
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });

  it("accepts a successful Settings test only for the saved active profile version", async () => {
    mocks.testActive.mockResolvedValue({ success: false });
    await act(async () => root.render(<AIEntry />));
    expect(container.querySelector("button")).toBeNull();

    const saved = { ...personal, updatedAt: "v2" };
    mocks.available.mockResolvedValue({ ...directory, personalProfiles: [saved] });
    await act(async () => {
      rememberAIProfileConnection(saved, true);
      window.dispatchEvent(new Event("nowen:ai-profiles-changed"));
    });
    expect(container.querySelector("button")).not.toBeNull();
    expect(mocks.testActive).toHaveBeenCalledTimes(1);
  });

  it("preserves an unchanged verification and hides after a failed test of that profile", async () => {
    await act(async () => root.render(<AIEntry />));
    const entry = container.querySelector("button");
    expect(entry).not.toBeNull();

    await act(async () => { window.dispatchEvent(new Event("nowen:ai-profiles-changed")); });
    expect(container.querySelector("button")).toBe(entry);
    await act(async () => {
      rememberAIProfileConnection(personal, false);
      window.dispatchEvent(new Event("nowen:ai-profiles-changed"));
    });
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.testActive).toHaveBeenCalledTimes(1);
  });

  it("checks an activated shared profile and hides it when its access is revoked", async () => {
    await act(async () => root.render(<AIEntry />));
    const active = { scope: "shared", id: shared.id };
    mocks.available.mockResolvedValue({ ...directory, active });
    await act(async () => { window.dispatchEvent(new Event("nowen:ai-profiles-changed")); });
    expect(container.querySelector("button")).not.toBeNull();
    expect(mocks.testActive).toHaveBeenCalledTimes(2);

    mocks.available.mockResolvedValue({ ...directory, active, sharedProfiles: [], unavailable: true });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.testActive).toHaveBeenCalledTimes(2);
  });

  it("hides when manual AI is disabled and probes again when enabled", async () => {
    await act(async () => root.render(<AIEntry />));
    expect(container.querySelector("button")).not.toBeNull();

    mocks.available.mockResolvedValue({ ...directory, aiEnabled: false });
    await act(async () => { window.dispatchEvent(new Event("nowen:ai-manual-enabled-changed")); });
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.testActive).toHaveBeenCalledTimes(1);

    mocks.available.mockResolvedValue(directory);
    await act(async () => { window.dispatchEvent(new Event("nowen:ai-manual-enabled-changed")); });
    expect(container.querySelector("button")).not.toBeNull();
    expect(mocks.testActive).toHaveBeenCalledTimes(2);
  });

  it("retains confirmed linkage while browser offline checks fail", async () => {
    await act(async () => root.render(<AIEntry />));
    const entry = container.querySelector("button");
    expect(entry).not.toBeNull();

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    mocks.available.mockRejectedValue(new Error("Offline"));
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(container.querySelector("button")).toBe(entry);
    expect(mocks.testActive).toHaveBeenCalledTimes(1);
  });

  it("ignores a successful in-flight test after an account change", async () => {
    let finish!: (result: { success: boolean }) => void;
    mocks.testActive.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<AIEntry />));

    mocks.scope = "server:account-b";
    mocks.available.mockResolvedValue({ ...directory, personalProfiles: [] });
    await act(async () => {
      window.dispatchEvent(new Event("nowen:token-changed"));
      finish({ success: true });
    });
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.testActive).toHaveBeenCalledTimes(1);
  });
});

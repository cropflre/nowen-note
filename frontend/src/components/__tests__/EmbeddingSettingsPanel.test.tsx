/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { getAISettings: mocks.getSettings, updateAISettings: mocks.updateSettings },
  getBaseUrl: () => "/api", getCurrentWorkspace: () => "personal",
}));
vi.mock("@/lib/aiProfiles", () => ({ aiProfiles: { list: async () => ({ profiles: [] }) } }));
vi.mock("@/lib/aiReliable", () => ({ getReliableAIStatus: mocks.status }));
vi.mock("@/components/EmbeddingIndexFailureDetails", () => ({ default: () => null }));
import EmbeddingSettingsPanel from "../EmbeddingSettingsPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("EmbeddingSettingsPanel index timeout", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("i18nextLng", "zh-CN");
    mocks.getSettings.mockResolvedValue({ ai_embedding_model: "bge-m3" });
    mocks.status.mockResolvedValue({
      embeddingModel: "bge-m3",
      embedding: { source: "chat", profileId: null },
      index: { configured: true, pending: 0, processing: 0, failed: 0, vectorState: "ready" },
    });
    mocks.updateSettings.mockImplementation(async (payload) => payload);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  async function setTimeoutValue(value: string) {
    const input = host.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function save() {
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "保存 Embedding 配置")!;
    await act(async () => button.click());
  }

  it("defaults old settings to 30s and saves a new deadline without asking for an index rebuild", async () => {
    await act(async () => root.render(<EmbeddingSettingsPanel />));
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("30");
    expect(host.querySelector("details")!.open).toBe(false);
    await setTimeoutValue("120");
    await save();
    expect(mocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ ai_embedding_timeout_seconds: "120" }));
    expect(host.textContent).toContain("Embedding 配置已保存。");
    expect(host.textContent).not.toContain("发生变化，请重建");
  });

  it("loads a saved deadline and rejects an out-of-range value before submitting", async () => {
    mocks.getSettings.mockResolvedValue({ ai_embedding_model: "bge-m3", ai_embedding_timeout_seconds: "300" });
    await act(async () => root.render(<EmbeddingSettingsPanel />));
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("300");
    await setTimeoutValue("601");
    await save();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(host.textContent).toContain("请输入 30～600 秒之间的整数。");
  });
});

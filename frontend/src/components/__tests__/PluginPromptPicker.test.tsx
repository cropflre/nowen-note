// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  contributions: vi.fn(),
  state: {
    activeNote: {
      title: "季度复盘",
      contentText: "本季度完成了插件贡献能力。",
      tags: [{ name: "复盘" }, { name: "插件" }],
    },
  },
}));

vi.mock("@/lib/pluginApi", () => ({
  pluginApi: { contributions: mocks.contributions },
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: mocks.state }),
}));

import PluginPromptPicker from "../PluginPromptPicker";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("PluginPromptPicker", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.contributions.mockResolvedValue([{
      pluginId: "nowenlab.productivity-pack",
      publisher: "nowenlab",
      promptPacks: [{
        id: "summarize-note",
        name: "总结当前笔记",
        prompt: "请总结当前笔记。",
        context: ["title", "note", "tags"],
        uiPlatform: ["web", "desktop"],
      }],
    }]);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("adds only the declared note context when a prompt is selected", async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(<PluginPromptPicker onSelect={onSelect} />));
    await flushEffects();

    const trigger = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Prompt Pack"));
    expect(trigger).toBeDefined();
    await act(async () => trigger!.click());

    const prompt = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("总结当前笔记"));
    expect(prompt).toBeDefined();
    await act(async () => prompt!.click());

    expect(onSelect).toHaveBeenCalledWith(
      "请总结当前笔记。\n\n"
      + "以下是 Host 按声明提供的最小上下文：\n"
      + "标题：季度复盘\n\n"
      + "笔记内容：\n本季度完成了插件贡献能力。\n\n"
      + "标签：复盘, 插件",
    );
  });
});

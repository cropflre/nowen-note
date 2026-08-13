import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider, prompt } from "@/components/ui/confirm";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ConfirmProvider", () => {
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Provider 延迟挂载时仍使用应用内输入弹窗", async () => {
    const nativePrompt = vi.spyOn(window, "prompt").mockReturnValue("原生输入");
    const result = prompt({ title: "保存为模板", defaultValue: "测试模板" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(nativePrompt).not.toHaveBeenCalled();

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<ConfirmProvider><div>应用内容</div></ConfirmProvider>);
    });

    expect(document.body.textContent).toContain("保存为模板");
    expect(document.body.querySelector<HTMLInputElement>("input")?.value).toBe("测试模板");

    const cancelButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "取消");
    await act(async () => {
      cancelButton?.click();
    });
    await expect(result).resolves.toBeNull();
  });
});

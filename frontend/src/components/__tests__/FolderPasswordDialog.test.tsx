import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import FolderPasswordDialog from "@/components/FolderPasswordDialog";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  removeFolderPassword: vi.fn(),
  setFolderPassword: vi.fn(),
  unlockFolder: vi.fn(),
}));

vi.mock("@/lib/knowledgeTreeApi", () => ({ knowledgeTreeApi: apiMocks }));

const protectedFolder = {
  id: "folder:protected",
  title: "受保护文件夹",
  isPasswordProtected: 1,
} as KnowledgeTreeNode;

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FolderPasswordDialog", () => {
  let root: Root | null = null;

  beforeEach(() => {
    apiMocks.removeFolderPassword.mockReset().mockResolvedValue({ success: true, isPasswordProtected: false });
    apiMocks.setFolderPassword.mockReset();
    apiMocks.unlockFolder.mockReset();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("使用当前密码取消文件夹密码并回传未保护状态", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onChanged = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root?.render(
        <FolderPasswordDialog
          node={protectedFolder}
          mode="manage"
          onClose={onClose}
          onUnlocked={vi.fn()}
          onChanged={onChanged}
        />,
      );
    });

    const input = document.body.querySelector<HTMLInputElement>('input[autocomplete="current-password"]');
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input!, "folder-secret");
    });
    const removeButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "取消密码");
    expect(removeButton).toBeDefined();

    await act(async () => {
      removeButton!.click();
      await Promise.resolve();
    });

    expect(apiMocks.removeFolderPassword).toHaveBeenCalledWith("folder:protected", "folder-secret");
    expect(onChanged).toHaveBeenCalledWith("folder:protected", false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("取消密码失败时保留对话框并显示错误", async () => {
    apiMocks.removeFolderPassword.mockRejectedValueOnce(new Error("当前密码错误"));
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onChanged = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root?.render(
        <FolderPasswordDialog
          node={protectedFolder}
          mode="manage"
          onClose={onClose}
          onUnlocked={vi.fn()}
          onChanged={onChanged}
        />,
      );
    });
    const input = document.body.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
    await act(async () => {
      setInputValue(input, "wrong-secret");
    });
    const removeButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "取消密码")!;

    await act(async () => {
      removeButton.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("当前密码错误");
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

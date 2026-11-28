import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";

const mocks = vi.hoisted(() => ({
  stabilize: vi.fn<(text: string) => Promise<string>>(),
}));

vi.mock("@/lib/fileShareClipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fileShareClipboard")>();
  return {
    ...actual,
    stabilizeClipboardAttachmentLinks: mocks.stabilize,
  };
});

describe("copyText (Edge & Safari Web compatibility)", () => {
  const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const originalSecureContextDescriptor = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  const originalExecCommand = document.execCommand;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.stabilize.mockImplementation(async (text) => text);
  });

  afterEach(() => {
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    } else {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    }
    if (originalSecureContextDescriptor) {
      Object.defineProperty(window, "isSecureContext", originalSecureContextDescriptor);
    }
    document.execCommand = originalExecCommand;
    document.body.innerHTML = "";
  });

  it("synchronously falls back to execCommand('copy') on non-HTTPS HTTP deployments (isSecureContext=false)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Should not call async clipboard on insecure HTTP"));
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    let copiedValue = "";
    let calledSynchronously = false;
    document.execCommand = vi.fn((cmd: string) => {
      if (cmd !== "copy") return false;
      const active = document.activeElement as HTMLTextAreaElement | null;
      copiedValue = active?.value || "";
      calledSynchronously = true;
      return true;
    });

    const promise = copyText("codex mcp add nowen");
    // 必须在当前同步栈内执行 execCommand("copy")，否则 Safari/Edge 会判定丢失用户手势
    expect(calledSynchronously).toBe(true);
    expect(await promise).toBe(true);
    expect(copiedValue).toBe("codex mcp add nowen");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to execCommand('copy') when navigator.clipboard.writeText rejects (NotAllowedError)", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    let copiedValue = "";
    document.execCommand = vi.fn((cmd: string) => {
      if (cmd !== "copy") return false;
      copiedValue = (document.activeElement as HTMLTextAreaElement | null)?.value || "";
      return true;
    });

    expect(await copyText("fallback-text")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("fallback-text");
    expect(copiedValue).toBe("fallback-text");
  });

  it("mounts fallback textarea inside an active dialog and restores focus afterwards", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const trigger = document.createElement("button");
    trigger.textContent = "复制给 Codex";
    dialog.appendChild(trigger);
    document.body.appendChild(dialog);
    trigger.focus();

    let mountedInsideDialog = false;
    document.execCommand = vi.fn((cmd: string) => {
      if (cmd !== "copy") return false;
      const active = document.activeElement as HTMLTextAreaElement | null;
      mountedInsideDialog = Boolean(active && dialog.contains(active));
      return true;
    });

    expect(await copyText("hello-codex")).toBe(true);
    expect(mountedInsideDialog).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(dialog.querySelector("textarea")).toBeNull();
  });

  it("does not fall back or leak expiring attachment URLs when share stabilization fails", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    document.execCommand = vi.fn(() => true);
    mocks.stabilize.mockRejectedValueOnce(new Error("FILE_EXTERNAL_ACCESS_DISABLED"));

    const attachmentUrl = "https://notes.example/api/attachments/11111111-2222-4333-8444-555555555555/image.png";
    expect(await copyText(`![img](${attachmentUrl})`)).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
  });
});

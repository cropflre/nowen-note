import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlockFormatButton } from "@/components/CodeBlockFormatButton";
import { CodeBlockFormatError } from "@/lib/codeBlockFormatting";
import { toast } from "@/lib/toast";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("code block format affordance", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  it("shows progress and prevents repeated clicks while formatting", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const onFormat = vi.fn(() => pending);
    await act(async () => { root.render(<CodeBlockFormatButton language="json" onFormat={onFormat} />); });
    const button = host.querySelector("button")!;
    await act(async () => { button.click(); button.click(); });
    expect(onFormat).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => { resolve(); await pending; });
    expect(button.disabled).toBe(false);
  });

  it("disables unsupported languages and read-only mutations", async () => {
    const onFormat = vi.fn();
    await act(async () => { root.render(<CodeBlockFormatButton language="python" onFormat={onFormat} />); });
    expect(host.querySelector("button")!.disabled).toBe(true);
    expect(host.querySelector("button")!.title).toBe("codeBlockFormatting.unsupported");
    await act(async () => { root.render(<CodeBlockFormatButton language="json" disabled onFormat={onFormat} />); });
    host.querySelector("button")!.click();
    expect(onFormat).not.toHaveBeenCalled();
    expect(host.querySelector("button")!.title).toBe("codeBlockFormatting.readOnly");
  });

  it("reports invalid syntax without exposing source snippets and allows retry", async () => {
    const onFormat = vi.fn().mockRejectedValue(new CodeBlockFormatError("invalid"));
    await act(async () => { root.render(<CodeBlockFormatButton language="json" onFormat={onFormat} />); });
    await act(async () => { host.querySelector("button")!.click(); });
    expect(toast.error).toHaveBeenCalledWith("codeBlockFormatting.invalid");
    expect(host.querySelector("button")!.disabled).toBe(false);
  });
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HtmlCodeBlockRunButton } from "@/components/HtmlCodeBlockRunButton";
import { MarkdownCodeBlock } from "@/components/MarkdownCodeBlock";
import { CodeBlockView } from "@/components/CodeBlockView";

vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string, fallback: string | { defaultValue?: string }) => typeof fallback === "string" ? fallback : fallback?.defaultValue || key,
}) }));
vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  NodeViewContent: (props: React.HTMLAttributes<HTMLElement>) => <code {...props} />,
}));
vi.mock("@/components/MermaidView", () => ({ default: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("HTML code block manual execution", () => {
  let host: HTMLDivElement;
  let root: Root;
  const source = '<button onclick="this.textContent = \'clicked\'">Click</button><script>window.demo = true</script>';
  // jsdom does not implement the native dialog lifecycle.
  beforeAll(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } },
      close: { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } },
    });
  });
  afterAll(() => {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });
  const clickRun = async () => {
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="运行 HTML"]')!.click(); });
  };

  it.each(["html", "HTML", "htm"])("runs %s only on demand and retains interactive markup in an isolated frame", async (language) => {
    await act(async () => root.render(<HtmlCodeBlockRunButton language={language} source={source} />));
    expect(document.querySelector("iframe")).toBeNull();
    await clickRun();
    const frame = document.querySelector("iframe")!;
    expect(frame.srcdoc).toContain(source);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("allow")).toContain("camera 'none'");
    expect(document.querySelector("dialog")!.open).toBe(true);
    expect(host.querySelector("script")).toBeNull();
  });

  it("reruns the current source in a fresh frame, including when the source has not changed", async () => {
    await act(async () => root.render(<HtmlCodeBlockRunButton language="html" source={source} />));
    await clickRun();
    const firstFrame = document.querySelector("iframe")!;
    await act(async () => root.render(<HtmlCodeBlockRunButton language="html" source="<h1>Updated</h1>" />));
    expect(document.querySelector("iframe")).toBe(firstFrame);
    const rerun = () => Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button")).find((button) => button.textContent === "重新运行")!;
    await act(async () => rerun().click());
    const secondFrame = document.querySelector("iframe")!;
    expect(secondFrame).not.toBe(firstFrame);
    expect(firstFrame.isConnected).toBe(false);
    expect(secondFrame.srcdoc).toContain("<h1>Updated</h1>");
    await act(async () => rerun().click());
    expect(document.querySelector("iframe")).not.toBe(secondFrame);
  });

  it.each(["button", "escape"])("destroys the frame and restores scrolling on %s close", async (method) => {
    document.body.style.overflow = "auto";
    await act(async () => root.render(<HtmlCodeBlockRunButton language="html" source={source} />));
    await clickRun();
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => {
      if (method === "button") document.querySelector<HTMLButtonElement>('button[aria-label="关闭预览"]')!.click();
      else document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });

  it("removes a running preview on language change and does not resume automatically", async () => {
    await act(async () => root.render(<HtmlCodeBlockRunButton language="html" source={source} />));
    await clickRun();
    await act(async () => root.render(<HtmlCodeBlockRunButton language="javascript" source={source} />));
    expect(host.querySelector("button")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    await act(async () => root.render(<HtmlCodeBlockRunButton language="html" source={source} />));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("provides the same manual preview in Markdown and read-only rich text without document mutations", async () => {
    await act(async () => root.render(<MarkdownCodeBlock className="language-html">{source}</MarkdownCodeBlock>));
    await clickRun();
    expect(document.querySelector("iframe")!.srcdoc).toContain(source);
    await act(async () => root.render(null));
    const updateAttributes = vi.fn();
    const editor = { isEditable: false, isDestroyed: false };
    await act(async () => root.render(<CodeBlockView {...({
      node: { attrs: { language: "html" }, textContent: source },
      editor, extension: { options: {} }, updateAttributes, getPos: () => 0,
    } as unknown as React.ComponentProps<typeof CodeBlockView>)} />));
    await clickRun();
    expect(document.querySelector("iframe")!.srcdoc).toContain(source);
    expect(updateAttributes).not.toHaveBeenCalled();
  });
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownPreview } from "@/components/MarkdownPreview";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/MathView", () => ({
  MathView: ({ source }: { source: string }) => <span>{source}</span>,
}));

const SIYUAN_IFRAME = '<iframe src="https://pan.example.test/#/share?sid=kkrjkp7p&amp;amp;p=XfN7xr" title="SiYuan embed"></iframe>';

describe("MarkdownPreview issue 494", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("preserves Callout metadata when raw iframe HTML enables sanitization", async () => {
    const markdown = [
      "> [!TIP] Tip",
      ">",
      "> 这是Tip类型Callout",
      "",
      SIYUAN_IFRAME,
    ].join("\n");

    await act(async () => {
      root.render(<MarkdownPreview markdown={markdown} />);
    });

    const callout = host.querySelector("blockquote");
    expect(callout).not.toBeNull();
    expect(callout?.className).toContain("border-emerald-400/70");
    expect(callout?.textContent).toContain("Tip");
    expect(callout?.textContent).toContain("这是Tip类型Callout");
  });

  it("decodes legacy double-escaped iframe parameters", async () => {
    await act(async () => {
      root.render(<MarkdownPreview markdown={SIYUAN_IFRAME} />);
    });

    const iframe = host.querySelector<HTMLIFrameElement>("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toBe("https://pan.example.test/#/share?sid=kkrjkp7p&p=XfN7xr");
  });
});

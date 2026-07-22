// @vitest-environment jsdom

import React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import EmbedPasswordBridge, { isControlledSameOriginEmbed } from "@/components/EmbedPasswordBridge";

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mountBridge() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  root.render(<EmbedPasswordBridge />);
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function appendPreviewIframe(src: string) {
  const preview = document.createElement("div");
  preview.className = "nowen-md-preview";
  const frame = document.createElement("iframe");
  frame.src = src;
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
  preview.appendChild(frame);
  document.body.appendChild(preview);
  return frame;
}

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("EmbedPasswordBridge", () => {
  it("recognizes only controlled same-origin routes for script-enabled DOM access", () => {
    expect(isControlledSameOriginEmbed(new URL("/embed/unlock", window.location.href), window.location.origin)).toBe(true);
    expect(isControlledSameOriginEmbed(new URL("/note/123", window.location.href), window.location.origin)).toBe(false);
    expect(isControlledSameOriginEmbed(new URL("https://example.com/embed"), window.location.origin)).toBe(false);
  });

  it("fills an accessible same-origin password field and exposes a manual fallback", async () => {
    await mountBridge();
    const iframe = appendPreviewIframe(new URL("/embed/unlock?password=secret-284", window.location.href).toString());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const input = iframe.contentDocument?.createElement("input");
    expect(input).toBeTruthy();
    input!.type = "password";
    iframe.contentDocument!.body.appendChild(input!);
    iframe.dispatchEvent(new Event("load"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(input!.value).toBe("secret-284");
    expect(iframe.getAttribute("sandbox")).toContain("allow-same-origin");
    expect(iframe.parentElement?.textContent).toContain("密码已填写");
    expect(iframe.parentElement?.textContent).toContain("复制密码");
  });

  it("delivers a cross-origin password only after an exact source/origin handshake", async () => {
    await mountBridge();
    const iframe = appendPreviewIframe("https://example.com/embed?pwd=hidden-value");
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    iframe.dispatchEvent(new Event("load"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const offer = postMessage.mock.calls
      .map((call) => call[0] as any)
      .find((message) => message?.type === "nowen:embed-password-offer");
    expect(offer).toBeTruthy();
    expect("password" in offer).toBe(false);
    expect(iframe.parentElement?.textContent).toContain("页面确认后");

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "nowen:embed-password-ready", requestId: offer.requestId },
      origin: "https://example.com",
      source: iframe.contentWindow,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const delivery = postMessage.mock.calls
      .map((call) => call[0] as any)
      .find((message) => message?.type === "nowen:embed-password");
    expect(delivery).toMatchObject({ requestId: offer.requestId, password: "hidden-value" });

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "nowen:embed-password-applied", requestId: offer.requestId, success: true },
      origin: "https://example.com",
      source: iframe.contentWindow,
    }));
    expect(iframe.parentElement?.textContent).toContain("已确认填写");
  });
});

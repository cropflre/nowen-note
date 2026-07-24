import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import PublicSpaceLauncher from "@/components/PublicSpaceLauncher";

describe("PublicSpaceLauncher visibility", () => {
  let root: Root;
  let host: HTMLDivElement;
  let legacyTrigger: HTMLButtonElement;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `
      <aside class="nav-rail"><div class="flex-1 overflow-y-auto"></div></aside>
      <button aria-label="跨空间转移笔记">legacy</button>
    `;
    legacyTrigger = document.querySelector("button")!;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    });
  };
  it("hides the nav entry without restoring the legacy floating trigger", async () => {
    act(() => root.render(<PublicSpaceLauncher visible={false} />));
    await settle();
    expect(legacyTrigger.hidden).toBe(true);
    expect(document.querySelector("[data-nowen-space-actions-mount]")).toBeNull();
    act(() => root.render(<PublicSpaceLauncher visible />));
    await settle();
    expect(document.querySelector("[data-nowen-space-actions-mount]")).not.toBeNull();
    act(() => root.render(<PublicSpaceLauncher visible={false} />));
    await settle();
    expect(legacyTrigger.hidden).toBe(true);
    expect(document.querySelector("[data-nowen-space-actions-mount]")).toBeNull();
  });
});

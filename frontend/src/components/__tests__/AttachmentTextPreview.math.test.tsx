// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AttachmentPreview from "@/components/attachmentPreview/AttachmentPreview";

const katexMocks = vi.hoisted(() => ({ renderKatex: vi.fn() }));
vi.mock("@/lib/katexRenderer", () => ({ renderKatex: katexMocks.renderKatex }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (value: string) => value }) }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = [
  "# 测试：力矩测量链", "",
  "行内频率 $f_{\\mathrm{rip}} = 2\\,f_{WG}$，与其他文字同行。", "",
  "$$", "\\tau_{\\mathrm{rip}}(\\theta_{WG}) = \\sum_{k=1}^{K} a_k \\sin(k\\theta_{WG})", "$$", "",
  "```tex", "$do_not_render$", "```", "", "普通 `inline $not_math$` 代码。",
].join("\n");

function response(text: string, status = 200) {
  return { ok: true, status, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
}

describe("Markdown attachment formula preview (#788)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    fetchMock = vi.fn().mockResolvedValue(response(SOURCE));
    vi.stubGlobal("fetch", fetchMock);
    katexMocks.renderKatex.mockImplementation(async (_source: string, options: { displayMode?: boolean } = {}) => ({
      html: `<span class="katex" data-math-display="${options.displayMode ? "block" : "inline"}">rendered</span>`,
      error: "",
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function awaitPreview() {
    // The shared renderer has a substantial async import graph. Poll the actual UI state
    // instead of assuming a particular CI runner can finish lazy loading in 60ms.
    for (let retry = 0; retry < 40; retry++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      if (host.querySelector(".nowen-md-preview")) {
        // Allow asynchronous MathView / renderKatex promise completions to commit.
        await act(async () => { await Promise.resolve(); });
        return;
      }
    }
    throw new Error(`Markdown preview not mounted; actual UI: ${host.innerHTML.slice(0, 1600)}`);
  }

  async function open(filename = "力矩测量.md", mimeType = "text/plain", size = SOURCE.length) {
    await act(async () => {
      root.render(<AttachmentPreview url="/api/attachments/math-file" filename={filename} mimeType={mimeType} size={size} />);
    });
    await awaitPreview();
  }

  it("routes .md attachments to the real Markdown preview and renders inline + block formulas", async () => {
    await open();
    expect(fetchMock).toHaveBeenCalledWith("/api/attachments/math-file", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(host.querySelector("h1")?.textContent).toContain("力矩测量链");
    expect(katexMocks.renderKatex).toHaveBeenCalledWith("f_{\\mathrm{rip}} = 2\\,f_{WG}", { displayMode: false });
    expect(katexMocks.renderKatex).toHaveBeenCalledWith("\\tau_{\\mathrm{rip}}(\\theta_{WG}) = \\sum_{k=1}^{K} a_k \\sin(k\\theta_{WG})", { displayMode: true });
    expect(host.querySelectorAll(".katex[data-math-display='inline']")).toHaveLength(1);
    expect(host.querySelectorAll(".katex[data-math-display='block']")).toHaveLength(1);
    expect(host.textContent).toContain("do_not_render");
    expect(host.querySelector(".nowen-md-preview")?.textContent).toContain("not_math");
  });

  it("switches to untouched Markdown source and back without modifying the attachment", async () => {
    await open("动力学.markdown", "application/octet-stream");
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    await act(async () => { tabs[1].click(); });
    expect(host.querySelector(".nowen-md-preview")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toBe(SOURCE);
    await act(async () => { tabs[0].click(); });
    await awaitPreview();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps suspicious raw HTML sanitized and does not execute attachment scripts", async () => {
    fetchMock.mockResolvedValue(response("# 标题\n\n<img src=\"x\" onerror=\"alert(1)\">\n\n$E=mc^2$"));
    await open();
    expect(host.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(host.querySelector("script")).toBeNull();
    expect(katexMocks.renderKatex).toHaveBeenCalledWith("E=mc^2", { displayMode: false });
  });

  it("preserves the 2MB Range guard and truncated-source notice", async () => {
    fetchMock.mockResolvedValue(response("# 截断文件\n\n$E=mc^2$", 206));
    await open("big.md", "text/markdown", 2 * 1024 * 1024 + 1);
    expect(fetchMock).toHaveBeenCalledWith("/api/attachments/math-file", expect.objectContaining({
      headers: { Range: "bytes=0-204799" },
    }));
    expect(host.textContent).toContain("已截断");
    expect(host.querySelector(".nowen-md-preview")).not.toBeNull();
  });
});

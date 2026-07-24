import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerAttachmentAccessUrls,
  resetAttachmentAccessStateForTests,
} from "@/lib/noteAttachmentAccessBridge";
import { MarkdownPreview } from "../MarkdownPreview";
import {
  buildMarkdownPreviewHeadingIndex,
  scrollMarkdownPreviewToPosition,
} from "@/lib/markdownPreviewOutline";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/MathView", () => ({
  MathView: ({ source, display }: { source: string; display?: boolean }) => (
    <span data-math-preview={display ? "block" : "inline"}>{source}</span>
  ),
}));

const ATTACHMENT_ID = "123e4567-e89b-42d3-a456-426614174216";

describe("MarkdownPreview task checkboxes", () => {
  let host: HTMLDivElement;
  let root: Root;
  let scrollCalls: HTMLElement[];

  beforeEach(() => {
    resetAttachmentAccessStateForTests();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    scrollCalls = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) { scrollCalls.push(this); },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("emits the clicked task index and next checked state", async () => {
    const onTaskCheckboxChange = vi.fn();

    await act(async () => {
      root.render(
        <React.StrictMode>
          <MarkdownPreview
            markdown={"- [x] done\n- [ ] todo"}
            onTaskCheckboxChange={onTaskCheckboxChange}
          />
        </React.StrictMode>,
      );
    });

    const checkboxes = host.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    expect(checkboxes).toHaveLength(2);

    await act(async () => {
      checkboxes[1].click();
    });

    expect(onTaskCheckboxChange).toHaveBeenCalledWith(1, true);
  });

  it("renders inline and block LaTeX while preserving fenced code", async () => {
    const markdown = [
      "行内公式 $E = mc^2$",
      "",
      "$$",
      String.raw`\frac{-b \pm \sqrt{b^2-4ac}}{2a}`,
      "$$",
      "",
      "```tex",
      "$not_math$",
      "```",
    ].join("\n");

    await act(async () => {
      root.render(<MarkdownPreview markdown={markdown} />);
    });

    expect(host.querySelector('[data-math-preview="inline"]')?.textContent).toBe("E = mc^2");
    expect(host.querySelector('[data-math-preview="block"]')?.textContent).toBe("\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}");
    expect(host.querySelectorAll("[data-math-preview]")).toHaveLength(2);
    expect(host.textContent).toContain("not_math");
  });

  it("resolves signed attachment images inside the editable live preview without changing markdown", async () => {
    const markdown = `![附件图片](/api/attachments/${ATTACHMENT_ID})`;
    host.setAttribute("contenteditable", "true");
    registerAttachmentAccessUrls(
      {
        [ATTACHMENT_ID]: `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=preview-signature&scope=v2.scope`,
      },
      `${window.location.origin}/api/attachments/access/urls?noteId=note-1`,
    );

    await act(async () => {
      root.render(<MarkdownPreview markdown={markdown} />);
    });

    const image = host.querySelector<HTMLImageElement>("img");
    expect(image).not.toBeNull();
    expect(new URL(image!.src).searchParams.get("sig")).toBe("preview-signature");
    expect(markdown).toBe(`![附件图片](/api/attachments/${ATTACHMENT_ID})`);
  });

  it("keeps protocol-relative remote image URLs unchanged", async () => {
    await act(async () => {
      root.render(<MarkdownPreview markdown="![远程图片](//cdn.example.com/image.png)" />);
    });

    expect(host.querySelector("img")?.getAttribute("src")).toBe("//cdn.example.com/image.png");
  });

  it("mounts long previews by viewport segment and preserves global task indices", async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
      root = null;
      rootMargin = "1000px 0px";
      thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const onTaskCheckboxChange = vi.fn();
    const markdown = [
      `# First\n\n- [ ] first\n\n${"a".repeat(60_000)}\n\n`,
      `# Second\n\n- [ ] second\n\n${"b".repeat(60_000)}\n\n`,
      "# Third\n",
    ].join("");

    await act(async () => {
      root.render(<MarkdownPreview markdown={markdown} onTaskCheckboxChange={onTaskCheckboxChange} />);
    });
    expect(host.querySelectorAll("[data-markdown-segment]").length).toBeGreaterThan(1);
    expect(host.textContent).toContain("First");
    expect(host.textContent).not.toContain("Second");

    await act(async () => {
      callbacks[1]?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(host.textContent).toContain("Second");
    const checkboxes = host.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    await act(async () => { checkboxes[1].click(); });
    expect(onTaskCheckboxChange).toHaveBeenLastCalledWith(1, true);

    await act(async () => {
      callbacks[1]?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(host.textContent).not.toContain("Second");
    expect(host.querySelectorAll("[data-markdown-segment]")[1]?.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  function longAnchorMarkdown() {
    return [
      `[跳到目标](#目标)\n\n# 开始\n\n${"a".repeat(60_000)}\n\n`,
      `# 目标\n\n目标正文\n\n${"b".repeat(60_000)}\n\n`,
      "# 结尾\n",
    ].join("");
  }

  function installIntersectionObserver() {
    const callbacks: IntersectionObserverCallback[] = [];
    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
      root = null;
      rootMargin = "1000px 0px";
      thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    return callbacks;
  }

  it("mounts an offscreen segment before scrolling an internal anchor to its exact heading", async () => {
    const callbacks = installIntersectionObserver();
    const markdown = longAnchorMarkdown();
    await act(async () => root.render(<MarkdownPreview markdown={markdown} />));

    const link = host.querySelector<HTMLAnchorElement>("a");
    expect(decodeURIComponent(link?.getAttribute("href") || "")).toBe("#目标");
    expect(link?.target).toBe("");
    expect(host.querySelector("#目标")).toBeNull();
    await act(async () => link?.click());

    const segments = host.querySelectorAll<HTMLElement>("[data-markdown-segment]");
    expect(segments[1].dataset.mdSegmentStart).toBeTruthy();
    expect(segments[1].dataset.mdSegmentEnd).toBeTruthy();
    expect(scrollCalls[0]).toBe(segments[1]);

    await act(async () => {
      callbacks[1]?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
    });
    const target = host.querySelector<HTMLElement>("#目标");
    expect(target?.dataset.mdPos).toBe(String(markdown.indexOf("# 目标")));
    expect(scrollCalls).toContain(target);
  });

  it("performs the same segment-first exact-heading scroll used by outline navigation", async () => {
    const callbacks = installIntersectionObserver();
    const markdown = longAnchorMarkdown();
    await act(async () => root.render(<MarkdownPreview markdown={markdown} />));
    const preview = host.querySelector<HTMLElement>(".nowen-md-preview")!;
    const targetPos = buildMarkdownPreviewHeadingIndex(markdown)
      .find((heading) => heading.id === "目标")!.pos;

    expect(scrollMarkdownPreviewToPosition(preview, targetPos)).toBe(true);
    const targetSegment = host.querySelectorAll<HTMLElement>("[data-markdown-segment]")[1];
    expect(scrollCalls[0]).toBe(targetSegment);

    await act(async () => {
      callbacks[1]?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
    });
    expect(scrollCalls.at(-1)).toBe(host.querySelector(`h1[data-md-pos="${targetPos}"]`));
  });
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerAttachmentAccessUrls,
  resetAttachmentAccessStateForTests,
} from "@/lib/noteAttachmentAccessBridge";
import { MarkdownPreview } from "../MarkdownPreview";

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

  beforeEach(() => {
    resetAttachmentAccessStateForTests();
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
});

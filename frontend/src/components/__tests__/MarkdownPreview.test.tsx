import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("MarkdownPreview task checkboxes", () => {
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
});

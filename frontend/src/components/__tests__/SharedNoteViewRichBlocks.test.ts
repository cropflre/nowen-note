// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderTiptapJSON } from "../SharedNoteView";
import { sanitizeForShare } from "@/lib/sanitizeHtml";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

function render(content: unknown[]): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = sanitizeForShare(renderTiptapJSON({ type: "doc", content }));
  return host;
}

describe("shared page rich-text blocks", () => {
  it("renders callouts and floating text boxes with their layout", () => {
    const host = render([
      { type: "callout", attrs: { type: "green", icon: "" }, content: [paragraph("Plain callout")] },
      { type: "callout", attrs: { type: "gray", icon: "", float: "right", width: 35 }, content: [paragraph("Boxed caption")] },
      paragraph("Body wraps around the box"),
    ]);
    const [callout, box] = Array.from(host.querySelectorAll<HTMLElement>('div[data-type="callout"]'));
    expect(callout.dataset.calloutType).toBe("green");
    expect(callout.dataset.float).toBeUndefined();
    expect(callout.querySelector(".prosemirror-callout-content > p")?.textContent).toBe("Plain callout");

    expect(box.dataset).toMatchObject({ calloutType: "gray", float: "right", width: "35" });
    expect(box.style.float).toBe("right");
    expect(box.style.width).toBe("35%");
    expect(box.textContent).toBe("Boxed caption");
    expect(host.querySelector('div[data-type="callout"] + p')?.textContent).toBe("Body wraps around the box");
  });

  it("renders columns side by side, keeping resized widths", () => {
    const host = render([{ type: "column_container", content: [
      { type: "column", attrs: { colWidth: 240, resized: true }, content: [paragraph("Left column")] },
      { type: "column", content: [paragraph("Right column")] },
    ] }]);
    const columns = Array.from(host.querySelectorAll<HTMLElement>(".prosemirror-column-container > .prosemirror-column"));
    expect(columns.map((column) => column.textContent)).toEqual(["Left column", "Right column"]);
    expect(columns[0].dataset.resized).toBe("true");
    expect(columns[0].style.width).toBe("240px");
    expect(columns[1].style.width).toBe("");
  });

  it("renders folding blocks as native details, keeping the saved open state", () => {
    const host = render([
      { type: "details", attrs: { open: true }, content: [
        { type: "detailsSummary", content: [{ type: "text", text: "Summary" }] },
        { type: "detailsContent", content: [paragraph("Hidden body")] },
      ] },
      { type: "details", attrs: { open: false }, content: [
        { type: "detailsSummary", content: [{ type: "text", text: "Closed" }] },
        { type: "detailsContent", content: [paragraph("Closed body")] },
      ] },
    ]);
    const [open, closed] = Array.from(host.querySelectorAll("details"));
    expect(open.open).toBe(true);
    expect(open.querySelector("summary")?.textContent).toBe("Summary");
    expect(open.querySelector('[data-type="detailsContent"] > p')?.textContent).toBe("Hidden body");
    expect(closed.open).toBe(false);
  });

  it("never lets block attributes inject markup", () => {
    const html = sanitizeForShare(renderTiptapJSON({ type: "doc", content: [
      { type: "callout", attrs: { type: '"><img src=x onerror=alert(1)>', float: "right; position:fixed", width: "1e9" }, content: [paragraph("Safe")] },
    ] }));
    expect(html).not.toMatch(/onerror|<img|position:fixed/);
    const host = document.createElement("div");
    host.innerHTML = html;
    const callout = host.querySelector<HTMLElement>('div[data-type="callout"]')!;
    expect(callout.dataset.calloutType).toBe("blue");
    expect(callout.dataset.float).toBeUndefined();
    expect(callout.textContent).toBe("Safe");
  });
});

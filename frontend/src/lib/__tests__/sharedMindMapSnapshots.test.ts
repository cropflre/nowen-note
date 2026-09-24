import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  hydrateSharedMindMapPlaceholders,
  preprocessSharedMindMapMarkdown,
  renderSharedMindMapPlaceholder,
  renderSharedMindMapSnapshot,
} from "@/lib/sharedMindMapSnapshots";

const ID = "11111111-1111-4111-8111-111111111111";
const snapshot = {
  id: ID,
  title: "产品规划",
  updatedAt: "2026-09-24 10:00:00",
  data: JSON.stringify({
    root: {
      id: "root",
      text: "产品规划",
      children: [{ id: "child", text: "需求", children: [] }],
    },
  }),
};

describe("shared mind map snapshots", () => {
  it("turns Markdown references into public placeholders without touching fenced examples", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const input = [
      `before ![[mindmap:${ID}]]`,
      fence + "markdown",
      `![[mindmap:${ID}]]`,
      fence,
    ].join("\n");

    const rendered = preprocessSharedMindMapMarkdown(input);
    expect(rendered.match(/shared-mindmap-block/g)?.length).toBe(1);
    expect(rendered).toContain(`data-shared-mindmap-id="${ID}"`);
    expect(rendered).toContain(`![[mindmap:${ID}]]`);
    expect(rendered).not.toContain("/api/mindmaps/");
  });

  it("renders a self-contained SVG snapshot for public sharing", () => {
    const html = renderSharedMindMapSnapshot(snapshot);
    expect(html).toContain("data-nowen-mindmap-snapshot");
    expect(html).toContain("<svg");
    expect(html).toContain("产品规划");
    expect(html).not.toContain("/api/mindmaps/");
  });

  it("hydrates only snapshots supplied by the share response", () => {
    const dom = new JSDOM(
      `<main><div class="shared-mindmap-block" data-shared-mindmap-id="${ID}"></div></main>`,
    );
    const root = dom.window.document.querySelector("main") as unknown as HTMLElement;
    const count = hydrateSharedMindMapPlaceholders(root, { [ID]: snapshot });

    expect(count).toBe(1);
    expect(root.querySelector("svg")).not.toBeNull();
    expect(root.querySelector("[data-rendered]")?.getAttribute("data-rendered")).toBe("1");
  });

  it("fails closed when a snapshot was not authorized by the server", () => {
    const dom = new JSDOM(renderSharedMindMapPlaceholder(`mindmap:${ID}`));
    const root = dom.window.document.body as unknown as HTMLElement;
    hydrateSharedMindMapPlaceholders(root, {});

    expect(root.textContent).toContain("未随当前分享公开");
    expect(root.innerHTML).not.toContain("/api/mindmaps/");
  });
});

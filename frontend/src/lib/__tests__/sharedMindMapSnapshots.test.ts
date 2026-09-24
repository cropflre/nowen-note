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
    const attrs = new Map<string, string>([["data-shared-mindmap-id", ID]]);
    const block = {
      innerHTML: "",
      getAttribute: (name: string) => attrs.get(name) || null,
      setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    } as unknown as HTMLElement;
    const root = {
      querySelectorAll: () => [block],
    } as unknown as HTMLElement;

    const count = hydrateSharedMindMapPlaceholders(root, { [ID]: snapshot });

    expect(count).toBe(1);
    expect(block.innerHTML).toContain("<svg");
    expect(attrs.get("data-rendered")).toBe("1");
  });

  it("fails closed when a snapshot was not authorized by the server", () => {
    const attrs = new Map<string, string>([["data-shared-mindmap-id", ID]]);
    const block = {
      innerHTML: renderSharedMindMapPlaceholder(`mindmap:${ID}`),
      getAttribute: (name: string) => attrs.get(name) || null,
      setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    } as unknown as HTMLElement;
    const root = {
      querySelectorAll: () => [block],
    } as unknown as HTMLElement;

    hydrateSharedMindMapPlaceholders(root, {});

    expect(block.innerHTML).toContain("未随当前分享公开");
    expect(block.innerHTML).not.toContain("/api/mindmaps/");
  });
});

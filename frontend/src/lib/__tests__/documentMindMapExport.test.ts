// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import {
  extractMindMapEmbedIdsFromHtml,
  hydrateMindMapEmbedsForExport,
  renderMindMapExportSnapshot,
} from "@/lib/documentMindMapExport";
import {
  buildPrintableHtml,
  noteContentToExportHtml,
} from "@/lib/exportServiceCore";

const ID = "11111111-1111-4111-8111-111111111111";
const snapshotMap = {
  id: ID,
  title: "产品规划 <Q4>",
  updatedAt: "2026-09-24 12:00:00",
  data: JSON.stringify({
    root: {
      id: "root",
      text: "产品规划",
      children: [
        { id: "child-1", text: "需求", children: [] },
        { id: "child-2", text: "<script>alert(1)</script>", children: [] },
      ],
    },
  }),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("document mind map export snapshots", () => {
  it("extracts unique embedded ids and hydrates every occurrence with one fetch", async () => {
    const html = [
      `<p>before</p><div data-nowen-block-embed="mindmap:${ID}">思维导图</div>`,
      `<div class="x" data-nowen-block-embed='mindmap:${ID}'>思维导图</div><p>after</p>`,
    ].join("");

    expect(extractMindMapEmbedIdsFromHtml(html)).toEqual([ID]);

    const loader = vi.fn(async () => snapshotMap as any);
    const rendered = await hydrateMindMapEmbedsForExport(html, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(rendered.match(/data-nowen-mindmap-export=/g)?.length).toBe(2);
    expect(rendered.match(/<svg/g)?.length).toBe(2);
    expect(rendered).not.toContain("data-nowen-block-embed");
    expect(rendered).not.toContain("/api/mindmaps/");
    expect(rendered).not.toContain("<script>alert(1)</script>");
    expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("fails closed to a readable placeholder when the source cannot be loaded", async () => {
    const html = `<div data-nowen-block-embed="mindmap:${ID}">思维导图</div>`;
    const rendered = await hydrateMindMapEmbedsForExport(html, async () => {
      throw new Error("forbidden");
    });

    expect(rendered).toContain('data-nowen-mindmap-export-unavailable="1"');
    expect(rendered).toContain("导图已删除、无权访问或暂时无法生成静态快照");
    expect(rendered).not.toContain(ID + "/api");
  });

  it("renders a self-contained static SVG card", () => {
    const rendered = renderMindMapExportSnapshot(snapshotMap as any);
    expect(rendered).toContain("思维导图静态快照");
    expect(rendered).toContain("data-nowen-mindmap-snapshot");
    expect(rendered).toContain("<svg");
    expect(rendered).not.toContain("mindmap:" + ID);
  });

  it("keeps Tiptap blockEmbed nodes during export HTML generation", () => {
    const content = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        { type: "blockEmbed", attrs: { href: `mindmap:${ID}` } },
      ],
    });

    const html = noteContentToExportHtml(content, "", "tiptap-json");
    expect(html).toContain(`data-nowen-block-embed="mindmap:${ID}"`);
  });

  it("freezes Markdown mind maps into printable HTML without private API links", async () => {
    vi.spyOn(api, "getMindMap").mockResolvedValue(snapshotMap as any);

    const html = await buildPrintableHtml({
      title: "带脑图文档",
      content: `正文\n\n![[mindmap:${ID}]]\n\n结束`,
      contentText: "正文 思维导图 结束",
      contentFormat: "markdown",
      createdAt: "2026-09-24 10:00:00",
      updatedAt: "2026-09-24 12:00:00",
    });

    expect(api.getMindMap).toHaveBeenCalledTimes(1);
    expect(html).toContain("data-nowen-mindmap-export");
    expect(html).toContain("data-nowen-mindmap-snapshot");
    expect(html).toContain("<svg");
    expect(html).not.toContain(`mindmap:${ID}`);
    expect(html).not.toContain("/api/mindmaps/");
  });
});

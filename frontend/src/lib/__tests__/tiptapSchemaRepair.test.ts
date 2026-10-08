import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import "@/lib/imageNodeTransformBootstrap";
import { tiptapExtensions } from "@/lib/importService";
import { repairTiptapJson } from "@/lib/tiptapSchemaRepair";

describe("repairTiptapJson", () => {
  it("wraps a legacy root image in a paragraph for the inline image schema", () => {
    const repaired = repairTiptapJson({
      type: "doc",
      content: [{
        type: "image",
        attrs: {
          src: "/api/attachments/image-id",
          alt: null,
          title: null,
          width: 791,
          height: null,
          rotation: 90,
          flipX: true,
        },
      }],
    }) as any;

    expect(repaired.content).toHaveLength(1);
    expect(repaired.content[0].type).toBe("paragraph");
    expect(repaired.content[0].content[0]).toMatchObject({
      type: "image",
      attrs: {
        src: "/api/attachments/image-id",
        width: 791,
        rotation: 90,
        flipX: true,
      },
    });

    const editor = new Editor({ extensions: tiptapExtensions, content: repaired });
    expect(() => editor.state.doc.check()).not.toThrow();
    editor.destroy();
  });

  it("does not construct image DOM with unsigned attachment URLs while repairing old documents", () => {
    const firstSrc = "/api/attachments/5bc403c1-2c1f-4541-ba2a-c8e9ab1b5fbd";
    const secondSrc = "http://127.0.0.1:3001/api/attachments/393a1987-c683-4749-9329-e6f6c36f9ecb?w=720";
    const input = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: firstSrc, width: 320, alt: "legacy root image" } },
        { type: "paragraph", content: [
          { type: "image", attrs: { src: secondSrc, width: 480, alt: "signed later" } },
          { type: "image", attrs: { src: firstSrc, width: 160, alt: "repeated attachment" } },
        ] },
      ],
    };
    const writtenImageSources: string[] = [];
    const oldSetAttribute = Element.prototype.setAttribute;
    const originalCreateElement = Document.prototype.createElement;
    const elementSpy = vi.spyOn(Document.prototype, "createElement").mockImplementation(function (
      this: Document, tagName: string, options?: ElementCreationOptions,
    ) {
      return originalCreateElement.call(this, tagName, options);
    });
    const attributeSpy = vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (
      this: Element, name: string, value: string,
    ) {
      if (this.tagName.toLowerCase() === "img" && name.toLowerCase() === "src") {
        writtenImageSources.push(value);
      }
      return oldSetAttribute.call(this, name, value);
    });

    let repaired: any;
    try {
      repaired = repairTiptapJson(input);
    } finally {
      attributeSpy.mockRestore();
      elementSpy.mockRestore();
    }

    const images: any[] = [];
    const walk = (node: any) => {
      if (node?.type === "image") images.push(node);
      node?.content?.forEach(walk);
    };
    walk(repaired);
    expect(images.map((image) => image.attrs.src)).toEqual([firstSrc, secondSrc, firstSrc]);
    expect(images.map((image) => image.attrs.width)).toEqual([320, 480, 160]);
    expect(writtenImageSources.some((src) => src.includes("/api/attachments/"))).toBe(false);
    expect(JSON.stringify(repaired)).not.toContain("nowen-schema-repair-image-");
    expect(input.content[0].attrs.src).toBe(firstSrc);
  });

  it("preserves tableAligns/colgroup and cell align through repair round-trip", () => {
    const input = {
      type: "doc",
      content: [{
        type: "table",
        attrs: {
          blockId: "blk_table0000",
          tableAligns: ["left", "center"],
          colgroup: [{ width: "120px" }, { width: "180px" }],
        },
        content: [{
          type: "tableRow",
          attrs: { height: 48 },
          content: [{
            type: "tableCell",
            attrs: {
              colspan: 1,
              rowspan: 1,
              colwidth: [120],
              align: "center",
            },
            content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
          }, {
            type: "tableCell",
            attrs: {
              colspan: 1,
              rowspan: 1,
              colwidth: [180],
              align: "right",
            },
            content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }],
          }],
        }],
      }],
    } as any;

    const repaired = repairTiptapJson(input) as any;
    const table = repaired.content?.[0];
    expect(table?.type).toBe("table");
    expect(table?.attrs?.blockId).toBe("blk_table0000");
    expect(table?.attrs?.tableAligns).toEqual(["left", "center"]);
    expect(table?.attrs?.colgroup).toEqual([{ width: "120px" }, { width: "180px" }]);
    expect(table?.content?.[0]?.attrs?.height).toBe(48);
    expect(table?.content?.[0]?.content?.[0]?.attrs?.align).toBe("center");
    expect(table?.content?.[0]?.content?.[1]?.attrs?.align).toBe("right");

    const editor = new Editor({ extensions: tiptapExtensions, content: repaired });
    const roundTrip = editor.getJSON() as any;
    expect(roundTrip.content?.[0]?.attrs?.blockId).toBe("blk_table0000");
    expect(roundTrip.content?.[0]?.attrs?.tableAligns).toEqual(["left", "center"]);
    expect(roundTrip.content?.[0]?.attrs?.colgroup).toEqual([{ width: "120px" }, { width: "180px" }]);
    expect(roundTrip.content?.[0]?.content?.[0]?.content?.[0]?.attrs?.align).toBe("center");
    expect(roundTrip.content?.[0]?.content?.[0]?.content?.[1]?.attrs?.align).toBe("right");
    editor.destroy();
  });

  it("preserves H4-H6 heading nodes through repair round-trip", () => {
    const input = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "H4" }] },
        { type: "heading", attrs: { level: 5 }, content: [{ type: "text", text: "H5" }] },
        { type: "heading", attrs: { level: 6 }, content: [{ type: "text", text: "H6" }] },
      ],
    } as any;

    const repaired = repairTiptapJson(input) as any;
    expect(repaired.content?.map((node: any) => node.attrs?.level)).toEqual([4, 5, 6]);

    const editor = new Editor({ extensions: tiptapExtensions, content: repaired });
    const roundTrip = editor.getJSON() as any;
    expect(roundTrip.content?.map((node: any) => node.attrs?.level)).toEqual([4, 5, 6]);
    editor.destroy();
  });
});

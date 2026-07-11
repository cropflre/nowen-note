import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
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

  it("preserves tableAligns/colgroup and cell align through repair round-trip", () => {
    const input = {
      type: "doc",
      content: [{
        type: "table",
        attrs: {
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
    expect(table?.attrs?.tableAligns).toEqual(["left", "center"]);
    expect(table?.attrs?.colgroup).toEqual([{ width: "120px" }, { width: "180px" }]);
    expect(table?.content?.[0]?.attrs?.height).toBe(48);
    expect(table?.content?.[0]?.content?.[0]?.attrs?.align).toBe("center");
    expect(table?.content?.[0]?.content?.[1]?.attrs?.align).toBe("right");

    const editor = new Editor({ extensions: tiptapExtensions, content: repaired });
    const roundTrip = editor.getJSON() as any;
    expect(roundTrip.content?.[0]?.attrs?.tableAligns).toEqual(["left", "center"]);
    expect(roundTrip.content?.[0]?.attrs?.colgroup).toEqual([{ width: "120px" }, { width: "180px" }]);
    expect(roundTrip.content?.[0]?.content?.[0]?.content?.[0]?.attrs?.align).toBe("center");
    expect(roundTrip.content?.[0]?.content?.[0]?.content?.[1]?.attrs?.align).toBe("right");
    editor.destroy();
  });
});

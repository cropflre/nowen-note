import { describe, it, expect } from "vitest";
import { repairTiptapJson } from "@/lib/tiptapSchemaRepair";

describe("repairTiptapJson keeps custom nodes (columns/details/emoji)", () => {
  it("preserves column_container with two columns after round-trip", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "column_container",
          content: [
            {
              type: "column",
              attrs: { colWidth: 280 },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "左栏内容" }] },
              ],
            },
            {
              type: "column",
              attrs: { colWidth: 280 },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "右栏内容" }] },
              ],
            },
          ],
        },
      ],
    };
    const out = repairTiptapJson(doc) as any;
    const types = (out.content || []).map((n: any) => n.type);
    console.log("column_container output types:", JSON.stringify(types, null, 2));
    console.log("output JSON:", JSON.stringify(out).slice(0, 500));
    expect(types).toContain("column_container");
    const container = out.content.find((n: any) => n.type === "column_container");
    expect(container.content.filter((c: any) => c.type === "column").length).toBe(2);
  });

  it("preserves details node after round-trip", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "details",
          content: [
            { type: "detailsSummary", content: [{ type: "text", text: "标题" }] },
            {
              type: "detailsContent",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "正文" }] },
              ],
            },
          ],
        },
      ],
    };
    const out = repairTiptapJson(doc) as any;
    const types = (out.content || []).map((n: any) => n.type);
    console.log("details output types:", JSON.stringify(types));
    expect(types).toContain("details");
  });

  it("preserves emoji node after round-trip", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "emoji", attrs: { name: "smile" } },
            { type: "text", text: "你好" },
          ],
        },
      ],
    };
    const out = repairTiptapJson(doc) as any;
    const para = out.content?.[0];
    const types = (para?.content || []).map((n: any) => n.type);
    console.log("emoji output types:", JSON.stringify(types));
    expect(types).toContain("emoji");
  });
});

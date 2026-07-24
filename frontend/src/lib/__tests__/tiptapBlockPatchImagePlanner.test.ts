import { describe, expect, it } from "vitest";

import { planTiptapBlockPatch } from "@/lib/tiptapBlockPatchPlannerRuntime";

const paragraphId = "blk_image_paragraph";

function paragraph(imageAttrs: Record<string, unknown>) {
  return {
    type: "paragraph",
    attrs: { blockId: paragraphId, textAlign: null, lineHeight: null },
    content: [
      { type: "text", text: "Before " },
      { type: "image", attrs: imageAttrs },
      { type: "text", text: " after" },
    ],
  };
}

function doc(node: unknown): string {
  return JSON.stringify({ type: "doc", content: [node] });
}

describe("Tiptap inline image Block Patch planning", () => {
  it("plans one replace operation for safe image presentation changes", () => {
    const src = "/api/attachments/11111111-1111-4111-8111-111111111111/content";
    const base = paragraph({
      src,
      alt: "Diagram",
      title: null,
      width: 320,
      height: 180,
      rotation: 0,
      flipX: false,
    });
    const next = paragraph({
      src,
      alt: "Diagram",
      title: "Rotated diagram",
      width: 640,
      height: 360,
      rotation: 90,
      flipX: true,
    });

    expect(planTiptapBlockPatch(doc(base), doc(next))).toMatchObject({
      operations: [{ type: "replace", blockId: paragraphId, node: next }],
      affectedBlockIds: [paragraphId],
    });
  });

  it("rejects unsafe image sources and unknown image attrs", () => {
    const base = paragraph({ src: "https://example.com/a.png", width: 320 });
    const unsafe = paragraph({ src: "javascript:alert(1)", width: 320 });
    const unknown = paragraph({ src: "https://example.com/a.png", width: 320, onload: "alert(1)" });

    expect(planTiptapBlockPatch(doc(base), doc(unsafe))).toBeNull();
    expect(planTiptapBlockPatch(doc(base), doc(unknown))).toBeNull();
  });

  it("keeps linked images and SVG data URLs on the whole-save path", () => {
    const base = paragraph({ src: "https://example.com/a.png", width: 320 });
    const linked = paragraph({ src: "https://example.com/a.png", width: 640 });
    (linked.content[1] as Record<string, unknown>).marks = [{
      type: "link",
      attrs: { href: "https://example.com" },
    }];
    const svg = paragraph({
      src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      width: 640,
    });

    expect(planTiptapBlockPatch(doc(base), doc(linked))).toBeNull();
    expect(planTiptapBlockPatch(doc(base), doc(svg))).toBeNull();
  });
});

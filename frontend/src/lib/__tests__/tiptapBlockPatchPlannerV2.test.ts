import { describe, expect, it } from "vitest";

import { planTiptapBlockPatch } from "@/lib/tiptapBlockPatchPlanner";

function doc(content: unknown[]) {
  return JSON.stringify({ type: "doc", content });
}

function paragraph(blockId: string, content: unknown[], attrs: Record<string, unknown> = {}) {
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null, indent: 0, ...attrs },
    content,
  };
}

function table(blockId: string, text: string, paragraphId = "blk_cellpara0") {
  return {
    type: "table",
    attrs: { blockId, tableAligns: ["left"], colgroup: null },
    content: [{
      type: "tableRow",
      attrs: { height: 36 },
      content: [{
        type: "tableCell",
        attrs: { colspan: 1, rowspan: 1, colwidth: null, align: "left" },
        content: [paragraph(paragraphId, [{ type: "text", text }])],
      }],
    }],
  };
}

describe("Tiptap Block Patch V2 planner", () => {
  it("plans an existing top-level table as one atomic replace operation", () => {
    const tableId = "blk_table0000";
    const before = table(tableId, "Before");
    const after = table(tableId, "After");

    expect(planTiptapBlockPatch(doc([before]), doc([after]))).toEqual({
      kind: "top-level-structural",
      operations: [{ type: "replace", blockId: tableId, node: after }],
      affectedBlockIds: [tableId],
    });
  });

  it("plans a table replacement beside unchanged complex siblings", () => {
    const tableId = "blk_table0000";
    const list = {
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: "blk_item0000" },
        content: [paragraph("blk_listpara0", [{ type: "text", text: "List" }])],
      }],
    };
    const imageParagraph = paragraph("blk_imagepara", [{
      type: "image",
      attrs: { src: "/api/attachments/example", alt: null, title: null },
    }]);
    const after = table(tableId, "After");

    expect(planTiptapBlockPatch(
      doc([list, table(tableId, "Before"), imageParagraph]),
      doc([list, after, imageParagraph]),
    )).toEqual({
      kind: "top-level-structural",
      operations: [{ type: "replace", blockId: tableId, node: after }],
      affectedBlockIds: [tableId],
    });
  });

  it("falls back for table creation, table moves and unsupported table content", () => {
    const tableId = "blk_table0000";
    const existing = table(tableId, "Before");
    expect(planTiptapBlockPatch(
      doc([paragraph("blk_intro000", [{ type: "text", text: "Intro" }])]),
      doc([paragraph("blk_intro000", [{ type: "text", text: "Intro" }]), existing]),
    )).toBeNull();

    expect(planTiptapBlockPatch(
      doc([existing, paragraph("blk_tail0000", [{ type: "text", text: "Tail" }])]),
      doc([paragraph("blk_tail0000", [{ type: "text", text: "Tail" }]), existing]),
    )).toBeNull();

    const unsupported = table(tableId, "After");
    (unsupported.content[0].content[0].content as unknown[]).push({
      type: "bulletList",
      content: [],
    });
    expect(planTiptapBlockPatch(doc([existing]), doc([unsupported]))).toBeNull();
    const looseAttrs = table(tableId, "After") as any;
    looseAttrs.content[0].content[0].attrs.colspan = "1";
    expect(planTiptapBlockPatch(doc([existing]), doc([looseAttrs]))).toBeNull();
    const looseParagraph = table(tableId, "After") as any;
    looseParagraph.content[0].content[0].content[0].attrs.textAlign = ["left"];
    expect(planTiptapBlockPatch(doc([existing]), doc([looseParagraph]))).toBeNull();
    expect(planTiptapBlockPatch(doc([existing]), doc([]))).toBeNull();

    const outside = paragraph("blk_conflict0", [{ type: "text", text: "Outside" }]);
    expect(planTiptapBlockPatch(
      doc([existing, outside]),
      doc([table(tableId, "After", "blk_conflict0"), outside]),
    )).toBeNull();
  });

  it("plans mark, hard-break and block-attribute changes as one replace operation", () => {
    const blockId = "blk_rich0000";
    const before = doc([paragraph(blockId, [{ type: "text", text: "Before" }])]);
    const afterNode = paragraph(blockId, [
      { type: "text", text: "Bold", marks: [{ type: "bold" }] },
      { type: "hardBreak" },
      {
        type: "text",
        text: "Nowen",
        marks: [{
          type: "link",
          attrs: {
            href: "https://example.com/docs",
            target: "_blank",
            rel: "noopener noreferrer nofollow",
            class: null,
          },
        }],
      },
      {
        type: "text",
        text: " styled",
        marks: [{ type: "textStyle", attrs: { color: "#ef4444", fontSize: "20px" } }],
      },
    ], { textAlign: "center", lineHeight: "1.6" });

    expect(planTiptapBlockPatch(before, doc([afterNode]))).toEqual({
      kind: "top-level-structural",
      operations: [{ type: "replace", blockId, node: afterNode }],
      affectedBlockIds: [blockId],
    });
  });

  it("plans heading level and code language changes without replacing the full note", () => {
    const headingId = "blk_heading00";
    const codeId = "blk_code0000";
    const before = doc([
      paragraph(headingId, [{ type: "text", text: "Title" }]),
      {
        type: "codeBlock",
        attrs: { blockId: codeId, language: null, indent: 0 },
        content: [{ type: "text", text: "const a = 1" }],
      },
    ]);
    const heading = {
      type: "heading",
      attrs: { blockId: headingId, level: 3, textAlign: "right", lineHeight: "1.8" },
      content: [{ type: "text", text: "Title", marks: [{ type: "italic" }] }],
    };
    const code = {
      type: "codeBlock",
      attrs: { blockId: codeId, language: "typescript", indent: 2 },
      content: [{ type: "text", text: "const answer: number = 42" }],
    };

    expect(planTiptapBlockPatch(before, doc([heading, code]))).toEqual({
      kind: "top-level-structural",
      operations: [
        { type: "replace", blockId: headingId, node: heading },
        { type: "replace", blockId: codeId, node: code },
      ],
      affectedBlockIds: [headingId, codeId],
    });
  });

  it("keeps unsafe, unknown and schema-changing replacements on whole-note save", () => {
    const blockId = "blk_safe0000";
    const before = doc([paragraph(blockId, [{ type: "text", text: "Safe" }])]);

    const unsafeLink = paragraph(blockId, [{
      type: "text",
      text: "Unsafe",
      marks: [{ type: "link", attrs: { href: "java" + "script:alert(1)" } }],
    }]);
    expect(planTiptapBlockPatch(before, doc([unsafeLink]))).toBeNull();

    const unknownMark = paragraph(blockId, [{
      type: "text",
      text: "Mention",
      marks: [{ type: "mention", attrs: { id: "user-1" } }],
    }]);
    expect(planTiptapBlockPatch(before, doc([unknownMark]))).toBeNull();

    const listBefore = doc([{
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: "blk_item0000" },
        content: [paragraph(blockId, [{ type: "text", text: "Nested" }])],
      }],
    }]);
    const listAfter = doc([{
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: "blk_item0000" },
        content: [{
          type: "heading",
          attrs: { blockId, level: 2, textAlign: null, lineHeight: null },
          content: [{ type: "text", text: "Nested" }],
        }],
      }],
    }]);
    expect(planTiptapBlockPatch(listBefore, listAfter)).toBeNull();
  });

  it("plans safe video, embed and math atom replacements", () => {
    const video = {
      type: "video",
      attrs: {
        blockId: "blk_video0000",
        src: "/api/attachments/11111111-1111-4111-8111-111111111111",
        platform: "file",
        kind: "file",
        originalUrl: "/api/attachments/11111111-1111-4111-8111-111111111111",
        attachmentId: "11111111-1111-4111-8111-111111111111",
        filename: "demo.mp4",
        mimeType: "video/mp4",
        size: 1024,
      },
    };
    const embed = {
      type: "blockEmbed",
      attrs: { blockId: "blk_embed0000", href: "note:11111111-1111-4111-8111-111111111111#blk:blk_target00" },
    };
    const math = {
      type: "mathBlock",
      attrs: { blockId: "blk_math00000", latex: "x^2" },
    };
    const nextVideo = { ...video, attrs: { ...video.attrs, filename: "renamed.mp4" } };
    const nextEmbed = { ...embed, attrs: { ...embed.attrs, href: "note:22222222-2222-4222-8222-222222222222" } };
    const nextMath = { ...math, attrs: { ...math.attrs, latex: "x^2 + y^2" } };

    expect(planTiptapBlockPatch(doc([video, embed, math]), doc([nextVideo, nextEmbed, nextMath]))).toEqual({
      kind: "top-level-structural",
      operations: [
        { type: "replace", blockId: "blk_video0000", node: nextVideo },
        { type: "replace", blockId: "blk_embed0000", node: nextEmbed },
        { type: "replace", blockId: "blk_math00000", node: nextMath },
      ],
      affectedBlockIds: ["blk_video0000", "blk_embed0000", "blk_math00000"],
    });
  });

  it("patches image attributes through the owning paragraph and rejects unsafe complex nodes", () => {
    const blockId = "blk_imagepara";
    const before = paragraph(blockId, [{
      type: "image",
      attrs: { src: "/api/attachments/image-id", alt: "before", title: null, width: 320, height: null },
    }]);
    const after = paragraph(blockId, [{
      type: "image",
      attrs: { src: "/api/attachments/image-id", alt: "after", title: "预览", width: 640, height: 480 },
    }]);
    expect(planTiptapBlockPatch(doc([before]), doc([after]))?.operations).toEqual([
      { type: "replace", blockId, node: after },
    ]);

    const unsafeVideo = {
      type: "video",
      attrs: {
        blockId: "blk_video0000",
        src: "javascript:alert(1)",
        platform: "file",
        kind: "file",
        originalUrl: "javascript:alert(1)",
        attachmentId: "",
        filename: "demo.mp4",
        mimeType: "video/mp4",
        size: 1,
      },
    };
    expect(planTiptapBlockPatch(doc([unsafeVideo]), doc([{ ...unsafeVideo, attrs: { ...unsafeVideo.attrs, size: 2 } }]))).toBeNull();

    const oversizedMath = { type: "mathBlock", attrs: { blockId: "blk_math00000", latex: "x".repeat(65_537) } };
    expect(planTiptapBlockPatch(
      doc([{ type: "mathBlock", attrs: { blockId: "blk_math00000", latex: "x" } }]),
      doc([oversizedMath]),
    )).toBeNull();
  });
});

import { readNoteAiProvenance } from "../aiContentProvenance";
import { describe, expect, it } from "vitest";
import { markdownToTiptapJSON, tiptapJsonToMarkdown } from "../contentFormat";
import {
  aiClipboardText,
  aiMarkdownFrontmatter,
  createAiProvenance,
  findAiProvenanceComments,
  markAiMarkdown,
  readAiProvenance,
  stripAiProvenanceComments,
} from "../aiContentProvenance";

const provenance = createAiProvenance("generation-123");

describe("AI content provenance", () => {
  it("adds a visible label to copied output without exposing internal provenance", () => {
    const source = markAiMarkdown("中文内容\n\n**bold**", provenance);
    expect(aiClipboardText(source)).toBe("AI 生成内容\n\n中文内容\n\n**bold**");
    expect(aiClipboardText("用户手写内容", false)).toBe("用户手写内容");
  });

  it("round-trips generation identity in a serialized content snapshot", () => {
    const persisted = JSON.parse(JSON.stringify({ content: markAiMarkdown("正文", provenance) }));
    expect(readAiProvenance(persisted.content)).toEqual(provenance);
    expect(stripAiProvenanceComments(persisted.content)).toContain("AI 生成内容");
    expect(stripAiProvenanceComments(persisted.content)).not.toContain("generation-123");
  });

  it("reads rich-text provenance without treating arbitrary text as metadata", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", attrs: { aiProvenance: provenance },
      content: [{ type: "text", text: "AI 生成内容" }] }] };
    expect(readAiProvenance(JSON.stringify(doc))).toEqual(provenance);
    expect(readAiProvenance("手写笔记提到了 AI 生成内容")).toBeNull();
    expect(readAiProvenance(JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: JSON.stringify(provenance) },
    ] }] }))).toBeNull();
  });

  it("ignores sample markers inside fenced code and rejects malformed metadata", () => {
    const marked = markAiMarkdown("正文", provenance);
    expect(readAiProvenance(`\`\`\`md\n${marked}\n\`\`\``)).toBeNull();
    expect(readAiProvenance(`~~~\n${marked}\n~~~`)).toBeNull();
    expect(readAiProvenance('<!-- nowen-aigc:{"Label":1} -->')).toBeNull();
    expect(readAiProvenance('<!-- nowen-aigc:{broken} -->')).toBeNull();
    expect(readAiProvenance(marked)).toEqual(provenance);
  });

  it("exposes only actual marker ranges, preserving user code and surrounding text", () => {
    const source = `first\n\n${markAiMarkdown("正文", provenance)}\n\nlast`;
    const [range] = findAiProvenanceComments(source);
    expect(source.slice(range.from, range.to)).toMatch(/^<!-- nowen-aigc:/);
    expect(stripAiProvenanceComments(source)).toContain("first");
    expect(stripAiProvenanceComments(source)).toContain("last");
    expect(stripAiProvenanceComments(`\`\`\`\n${source}\n\`\`\``)).toContain("nowen-aigc:");
  });

  it("writes the seven string fields required by the official Markdown metadata format", () => {
    const metadata = aiMarkdownFrontmatter(provenance);
    expect(metadata).toContain('AIGC:\n  Label: "1"');
    expect(metadata).toContain('  ProduceID: "generation-123"');
    expect(Object.values(provenance).every(value => typeof value === "string")).toBe(true);
    expect(Object.keys(provenance)).toEqual([
      "Label", "ContentProducer", "ProduceID", "ReservedCode1",
      "ContentPropagator", "PropagateID", "ReservedCode2",
    ]);
    expect(aiMarkdownFrontmatter(null)).toBe("");
  });

  it("preserves labels and identity through the real Markdown and rich-text converters", () => {
    const markdown = markAiMarkdown("## 标题\n\n正文 **加粗**\n\n- 项目", provenance);
    const rich = markdownToTiptapJSON(markdown);
    expect(readAiProvenance(JSON.stringify(rich))).toEqual(provenance);
    const restored = tiptapJsonToMarkdown(JSON.stringify(rich));
    expect(readAiProvenance(restored)).toEqual(provenance);
    expect(restored).toContain("AI 生成内容");
    expect(restored).toContain("**加粗**");
    expect(restored).toContain("项目");
  });
});

it("records an explicitly generated title without classifying an ordinary manual title", () => {
  const note = { id: "note-id", title: "AI 生成标题：周计划", content: "手写正文" };
  expect(readNoteAiProvenance(note)?.ProduceID).toBe("note-id:title");
  expect(readNoteAiProvenance({ ...note, title: "AI-generated title: Plan" })?.ProduceID).toBe("note-id:title");
  expect(readNoteAiProvenance({ ...note, title: "手写 AI 使用笔记" })).toBeNull();
});


it("reads a generated declaration after server Markdown normalization adds a block ID", () => {
  const markdown = markAiMarkdown("正文", provenance).replace(" -->", " --> ^blk_11111111-1111-4111-8111-111111111111");
  expect(readAiProvenance(markdown)).toEqual(provenance);
  expect(readAiProvenance(JSON.stringify(markdownToTiptapJSON(markdown)))).toEqual(provenance);
});

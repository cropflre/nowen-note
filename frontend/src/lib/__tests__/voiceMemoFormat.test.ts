import { describe, expect, it } from "vitest";
import { generateJSON } from "@tiptap/core";
import { getTiptapExtensions, tiptapJsonToMarkdown, markdownToTiptapJSON } from "../contentFormat";
import { renderTiptapJSON } from "@/components/SharedNoteView";
import { sanitizeForShare } from "../sanitizeHtml";

const attrs = { attachmentId: "11fe46d6-1a50-4a3b-b251-8486a1e7e9ea", src: "/api/attachments/11fe46d6-1a50-4a3b-b251-8486a1e7e9ea", filename: "voice.m4a", mimeType: "audio/mp4", size: 123, durationMs: 32120 };

describe("voice memo content", () => {
  it("preserves audio and metadata through rich text → Markdown → rich text", () => {
    const doc = { type: "doc", content: [{ type: "voiceMemo", attrs }] };
    const markdown = tiptapJsonToMarkdown(doc);
    expect(markdown).toContain("<audio"); expect(markdown).toContain(attrs.src);
    expect(markdownToTiptapJSON(markdown).content).toContainEqual(expect.objectContaining({ type: "voiceMemo", attrs: expect.objectContaining(attrs) }));
  });
  it("imports standard audio with nested source", () => {
    const doc = generateJSON(`<audio controls><source src="${attrs.src}" type="audio/mp4"></audio>`, getTiptapExtensions());
    expect(doc.content?.[0]).toMatchObject({ type: "voiceMemo", attrs: { src: attrs.src, mimeType: "audio/mp4" } });
  });
  it("renders shared audio without autoplay or unsafe attributes", () => {
    const html = sanitizeForShare(renderTiptapJSON({ type: "doc", content: [{ type: "voiceMemo", attrs: { ...attrs, autoplay: true, onclick: "alert(1)" } }] }));
    expect(html).toContain("<audio"); expect(html).toContain("controls"); expect(html).not.toMatch(/autoplay|onclick/);
    const malicious = sanitizeForShare(renderTiptapJSON({ type: "doc", content: [{ type: "voiceMemo", attrs: { src: 'javascript:alert(1)" onerror="alert(2)' } }] }));
    expect(malicious).not.toContain("javascript:"); expect(malicious).not.toContain("onerror=");
  });
});

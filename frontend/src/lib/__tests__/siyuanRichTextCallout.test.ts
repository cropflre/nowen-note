// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  decorateSiyuanRichTextCallouts,
  parseSiyuanRichTextCalloutMarker,
} from "@/lib/siyuanRichTextCallout";

const PRODUCTION_EDITOR_ROOT = 'div.prose[contenteditable="true"]';

describe("SiYuan rich-text Callout compatibility", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("recognizes all five SiYuan Callout variants", () => {
    expect(parseSiyuanRichTextCalloutMarker("[!TIP] Tip")).toMatchObject({ type: "tip", icon: "💡", title: "Tip" });
    expect(parseSiyuanRichTextCalloutMarker("[!NOTE] Note")).toMatchObject({ type: "note", icon: "✏️", title: "Note" });
    expect(parseSiyuanRichTextCalloutMarker("[!IMPORTANT] Important")).toMatchObject({ type: "important", icon: "❗", title: "Important" });
    expect(parseSiyuanRichTextCalloutMarker("[!WARNING] Warning")).toMatchObject({ type: "warning", icon: "⚠️", title: "Warning" });
    expect(parseSiyuanRichTextCalloutMarker("[!CAUTION] Caution")).toMatchObject({ type: "caution", icon: "🚨", title: "Caution" });
  });

  it("normalizes SiYuan default titles that repeat their icon", () => {
    expect(parseSiyuanRichTextCalloutMarker("[!TIP] Tip 💡")).toMatchObject({ title: "Tip", icon: "💡" });
    expect(parseSiyuanRichTextCalloutMarker("[!NOTE] ✏️ Note")).toMatchObject({ title: "Note", icon: "✏️" });
    expect(parseSiyuanRichTextCalloutMarker("[!WARNING] 自定义警告 ⚠️")).toMatchObject({ title: "自定义警告 ⚠️" });
  });

  it("decorates all five blockquotes in the actual Tiptap editor root", () => {
    document.body.innerHTML = `
      <div class="prose prose-sm max-w-none" contenteditable="true" spellcheck="false">
        <blockquote><p>[!TIP] Tip 💡</p><p>这是Tip类型Callout</p></blockquote>
        <blockquote><p>[!NOTE] Note</p><p>这是Note类型Callout</p></blockquote>
        <blockquote><p>[!IMPORTANT] Important</p><p>这是Important类型Callout</p></blockquote>
        <blockquote><p>[!WARNING] Warning</p><p>这是Warning类型Callout</p></blockquote>
        <blockquote><p>[!CAUTION] Caution</p><p>这是Caution类型Callout</p></blockquote>
      </div>
    `;

    expect(decorateSiyuanRichTextCallouts(document)).toBe(5);

    const blocks = Array.from(document.querySelectorAll<HTMLQuoteElement>(`${PRODUCTION_EDITOR_ROOT} blockquote`));
    expect(blocks.map((block) => block.dataset.calloutType)).toEqual([
      "tip",
      "note",
      "important",
      "warning",
      "caution",
    ]);
    expect(blocks[0].classList.contains("nowen-siyuan-callout")).toBe(true);
    expect(blocks[0].firstElementChild?.textContent).toBe("[!TIP] Tip 💡");
    expect((blocks[0].firstElementChild as HTMLElement).dataset.calloutIcon).toBe("💡");
    expect((blocks[0].firstElementChild as HTMLElement).dataset.calloutTitle).toBe("Tip");
  });

  it("keeps the legacy ProseMirror root as a compatibility fallback", () => {
    document.body.innerHTML = '<div class="ProseMirror"><blockquote><p>[!TIP] Tip</p><p>正文</p></blockquote></div>';
    expect(decorateSiyuanRichTextCallouts(document)).toBe(1);
    expect(document.querySelector("blockquote")?.classList.contains("nowen-siyuan-callout")).toBe(true);
  });

  it("leaves Markdown source and ordinary rich-text blockquotes untouched", () => {
    document.body.innerHTML = `
      <pre data-editor="markdown">&gt; [!TIP] Tip\n&gt; Markdown source</pre>
      <div class="prose prose-sm" contenteditable="true">
        <blockquote><p>普通引用</p></blockquote>
      </div>
    `;

    expect(decorateSiyuanRichTextCallouts(document)).toBe(0);
    expect(document.querySelector("pre")?.textContent).toContain("[!TIP] Tip");
    expect(document.querySelector(`${PRODUCTION_EDITOR_ROOT} blockquote`)?.classList.contains("nowen-siyuan-callout")).toBe(false);
  });

  it("removes presentation metadata when the marker is edited into a normal quote", () => {
    document.body.innerHTML = `
      <div class="prose prose-sm" contenteditable="true">
        <blockquote><p>[!WARNING]- 自定义警告</p><p>正文</p></blockquote>
      </div>
    `;

    decorateSiyuanRichTextCallouts(document);
    const blockquote = document.querySelector<HTMLQuoteElement>("blockquote")!;
    const header = blockquote.querySelector<HTMLParagraphElement>("p")!;
    expect(blockquote.dataset.calloutFold).toBe("-");
    expect(header.dataset.calloutTitle).toBe("自定义警告");

    header.textContent = "普通引用";
    decorateSiyuanRichTextCallouts(document);

    expect(blockquote.classList.contains("nowen-siyuan-callout")).toBe(false);
    expect(blockquote.hasAttribute("data-callout-type")).toBe(false);
    expect(header.classList.contains("nowen-siyuan-callout-header")).toBe(false);
  });
});

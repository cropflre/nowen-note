import { describe, expect, it } from "vitest";
import {
  buildEditorComplexityProfile,
  formatEditorByteSize,
  utf8ByteLength,
} from "@/lib/editorComplexityProfile";
import {
  resolveEditorRuntimeDecision,
  withEditorRuntimeMode,
} from "@/lib/editorRuntimePolicy";

function tiptapWithText(length: number): string {
  return `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${"x".repeat(length)}"}]}]}`;
}

describe("editor complexity profile", () => {
  it("reports UTF-8 bytes separately from JavaScript characters", () => {
    expect(utf8ByteLength("A中😀")).toBe(8);
    expect(formatEditorByteSize(18 * 1024)).toBe("18.0 KB");
  });

  it("counts Tiptap structural and heavy nodes without parsing ProseMirror", () => {
    const content = JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "标题" }] },
        { type: "image", attrs: { src: "/api/attachments/a" } },
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1" }] },
        { type: "table", content: [] },
      ],
    });
    const profile = buildEditorComplexityProfile(content, "tiptap-json");

    expect(profile.approximateNodes).toBeGreaterThanOrEqual(8);
    expect(profile.imageCount).toBe(1);
    expect(profile.codeBlockCount).toBe(1);
    expect(profile.tableCount).toBe(1);
  });
});

describe("progressive editor runtime policy", () => {
  it("keeps an ordinary compact 18 KB rich-text note in normal mode", () => {
    const decision = resolveEditorRuntimeDecision({
      content: tiptapWithText(18_000),
      contentFormat: "tiptap-json",
    });
    expect(decision.mode).toBe("normal");
    expect(decision.capabilities.editable).toBe(true);
  });

  it("uses viewport optimization before removing editing features", () => {
    const decision = resolveEditorRuntimeDecision({
      content: tiptapWithText(120_000),
      contentFormat: "tiptap-json",
    });
    expect(decision.mode).toBe("viewport-optimized");
    expect(decision.capabilities.editable).toBe(true);
    expect(decision.capabilities.eagerHeavyNodes).toBe(false);
    expect(decision.capabilities.syntaxHighlight).toBe(true);
  });

  it("keeps medium-large rich text editable in lightweight mode", () => {
    const decision = resolveEditorRuntimeDecision({
      content: tiptapWithText(400_000),
      contentFormat: "tiptap-json",
    });
    expect(decision.mode).toBe("lightweight-edit");
    expect(decision.capabilities.editable).toBe(true);
    expect(decision.capabilities.syntaxHighlight).toBe(false);
    expect(decision.capabilities.collaboration).toBe(true);
  });

  it("reserves emergency readonly for genuinely pathological rich text", () => {
    const decision = resolveEditorRuntimeDecision({
      content: tiptapWithText(1_000_000),
      contentFormat: "tiptap-json",
    });
    expect(decision.mode).toBe("emergency-readonly");
    expect(decision.capabilities.editable).toBe(false);
    expect(decision.capabilities.collaboration).toBe(false);
  });

  it("keeps pathological Markdown editable through the lightweight source editor", () => {
    const decision = resolveEditorRuntimeDecision({
      content: "x".repeat(800_000),
      contentFormat: "markdown",
    });
    expect(decision.mode).toBe("lightweight-edit");
    expect(decision.capabilities.editable).toBe(true);
  });

  it("never de-escalates an existing runtime decision", () => {
    const base = resolveEditorRuntimeDecision({
      content: tiptapWithText(120_000),
      contentFormat: "tiptap-json",
    });
    const escalated = withEditorRuntimeMode(base, "lightweight-edit", "runtime-long-task");
    expect(escalated.mode).toBe("lightweight-edit");
    expect(escalated.reasons).toContain("runtime-long-task");
    expect(withEditorRuntimeMode(escalated, "normal").mode).toBe("lightweight-edit");
  });
});

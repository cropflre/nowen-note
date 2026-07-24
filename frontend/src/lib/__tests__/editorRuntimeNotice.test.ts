// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEditorRuntimeDecision } from "@/lib/editorRuntimePolicy";
import {
  clearActiveEditorRuntimeDecision,
  getActiveEditorRuntimeState,
  requestActiveEditorRuntimeMode,
  setActiveEditorRuntimeDecision,
} from "@/lib/editorRuntimeStore";

function richText(length: number): string {
  return `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${"x".repeat(length)}"}]}]}`;
}

describe("editor runtime notice", () => {
  beforeEach(() => {
    document.documentElement.lang = "zh-CN";
    clearActiveEditorRuntimeDecision();
  });

  afterEach(() => clearActiveEditorRuntimeDecision());

  it("does not show a notice for viewport-optimized mode", () => {
    const decision = resolveEditorRuntimeDecision({
      content: richText(120_000),
      contentFormat: "tiptap-json",
    });
    setActiveEditorRuntimeDecision("viewport-note", decision);

    expect(getActiveEditorRuntimeState().decision.mode).toBe("viewport-optimized");
    expect(document.getElementById("nowen-editor-runtime-notice")).toBeNull();
  });

  it("does not show a notice for lightweight-edit mode", () => {
    const decision = resolveEditorRuntimeDecision({
      content: richText(400_000),
      contentFormat: "tiptap-json",
    });
    setActiveEditorRuntimeDecision("notice-note", decision);

    expect(getActiveEditorRuntimeState().decision.mode).toBe("lightweight-edit");
    expect(document.getElementById("nowen-editor-runtime-notice")).toBeNull();
  });

  it("does not allow the session restore API to bypass emergency readonly", () => {
    const decision = resolveEditorRuntimeDecision({
      content: richText(1_000_000),
      contentFormat: "tiptap-json",
    });
    setActiveEditorRuntimeDecision("emergency-note", decision);

    requestActiveEditorRuntimeMode("normal");

    expect(getActiveEditorRuntimeState().decision.mode).toBe("emergency-readonly");
    expect(document.getElementById("nowen-editor-runtime-notice")).toBeNull();
  });
});

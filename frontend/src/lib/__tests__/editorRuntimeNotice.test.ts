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

  it("explains lightweight mode and lets the user retry full mode for this session", () => {
    const decision = resolveEditorRuntimeDecision({
      content: richText(400_000),
      contentFormat: "tiptap-json",
    });
    setActiveEditorRuntimeDecision("notice-note", decision);

    const notice = document.getElementById("nowen-editor-runtime-notice") as HTMLDivElement | null;
    expect(notice).not.toBeNull();
    expect(notice?.hidden).toBe(false);
    expect(notice?.textContent).toContain("轻量编辑模式");
    expect(notice?.textContent).toContain("正文仍可编辑保存");

    const action = notice?.querySelector("button") as HTMLButtonElement | null;
    action?.click();

    expect(getActiveEditorRuntimeState().decision.mode).toBe("normal");
    expect(notice?.hidden).toBe(true);
  });

  it("does not allow the session restore API to bypass emergency readonly", () => {
    const decision = resolveEditorRuntimeDecision({
      content: richText(1_000_000),
      contentFormat: "tiptap-json",
    });
    setActiveEditorRuntimeDecision("emergency-note", decision);

    requestActiveEditorRuntimeMode("normal");

    expect(getActiveEditorRuntimeState().decision.mode).toBe("emergency-readonly");
    expect(document.getElementById("nowen-editor-runtime-notice")?.hidden).toBe(true);
  });
});

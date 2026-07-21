import { beforeEach, describe, expect, it } from "vitest";
import { resolveEditorRuntimeDecision } from "@/lib/editorRuntimePolicy";
import {
  clearActiveEditorRuntimeDecision,
  escalateActiveEditorRuntimeMode,
  getActiveEditorRuntimeState,
  isActiveEditorCapabilityEnabled,
  setActiveEditorRuntimeDecision,
} from "@/lib/editorRuntimeStore";
import { instrumentPhaseALowlight } from "@/lib/phaseAPerfDiagnostics";

function richText(length: number): string {
  return `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${"x".repeat(length)}"}]}]}`;
}

describe("editor runtime store", () => {
  beforeEach(() => clearActiveEditorRuntimeDecision());

  it("publishes the active mode to the document without exposing note content", () => {
    const decision = resolveEditorRuntimeDecision({
      content: richText(120_000),
      contentFormat: "tiptap-json",
    });
    setActiveEditorRuntimeDecision("note-1", decision);

    expect(getActiveEditorRuntimeState().decision.mode).toBe("viewport-optimized");
    expect(document.documentElement.dataset.nowenEditorRuntimeMode).toBe("viewport-optimized");
    expect(document.documentElement.dataset.nowenEditorRuntimeNote).toBe("note-1");
    expect(document.documentElement.dataset.nowenEditorRuntimeReasons).not.toContain("xxxxx");
  });

  it("escalates only toward safer modes", () => {
    const decision = resolveEditorRuntimeDecision({
      content: richText(10_000),
      contentFormat: "tiptap-json",
    });
    setActiveEditorRuntimeDecision("note-2", decision);

    escalateActiveEditorRuntimeMode("viewport-optimized", "runtime-long-task");
    escalateActiveEditorRuntimeMode("lightweight-edit", "runtime-long-task");
    escalateActiveEditorRuntimeMode("normal", "runtime-long-task");

    expect(getActiveEditorRuntimeState().decision.mode).toBe("lightweight-edit");
    expect(isActiveEditorCapabilityEnabled("syntax-highlight")).toBe(false);
    expect(isActiveEditorCapabilityEnabled("editable")).toBe(true);
  });

  it("bypasses lowlight work in lightweight mode while preserving editable code", () => {
    let explicitCalls = 0;
    let autoCalls = 0;
    const lowlight = instrumentPhaseALowlight({
      highlight: () => {
        explicitCalls += 1;
        return { children: [{ value: "x" }] };
      },
      highlightAuto: () => {
        autoCalls += 1;
        return { children: [{ value: "x" }] };
      },
    });

    const decision = resolveEditorRuntimeDecision({
      content: richText(400_000),
      contentFormat: "tiptap-json",
    });
    setActiveEditorRuntimeDecision("note-3", decision);

    expect(lowlight.highlight("typescript", "const x = 1")).toEqual({ children: [] });
    expect(lowlight.highlightAuto("const x = 1")).toEqual({ children: [] });
    expect(explicitCalls).toBe(0);
    expect(autoCalls).toBe(0);
  });
});

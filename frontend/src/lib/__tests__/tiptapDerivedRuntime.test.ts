import { describe, expect, it } from "vitest";

import {
  createEditorRuntimeDecision,
  resolveEditorRuntimeDecision,
} from "@/lib/editorRuntimePolicy";
import { buildEditorComplexityProfile } from "@/lib/editorComplexityProfile";
import { shouldPublishRealtimeTiptapOutline } from "@/lib/tiptapDerivedRuntime";

describe("Tiptap derived runtime policy", () => {
  it("keeps realtime outline extraction for normal documents", () => {
    const decision = resolveEditorRuntimeDecision({
      content: '{"type":"doc","content":[{"type":"paragraph"}]}',
      contentFormat: "tiptap-json",
    });
    expect(decision.mode).toBe("normal");
    expect(shouldPublishRealtimeTiptapOutline(decision)).toBe(true);
  });

  it.each(["viewport-optimized", "lightweight-edit", "emergency-readonly"] as const)(
    "keeps worker-backed outline publication in %s mode",
    (mode) => {
      const decision = createEditorRuntimeDecision(
        mode,
        ["node-count"],
        buildEditorComplexityProfile("", "tiptap-json"),
      );
      expect(shouldPublishRealtimeTiptapOutline(decision)).toBe(true);
    },
  );
});

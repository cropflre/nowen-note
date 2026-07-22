import type { EditorRuntimeDecision } from "@/lib/editorRuntimePolicy";

/** Whole-document outline extraction is nonessential once an optimized runtime mode is active. */
export function shouldPublishRealtimeTiptapOutline(decision: EditorRuntimeDecision): boolean {
  return decision.capabilities.wholeDocumentAnalysis;
}

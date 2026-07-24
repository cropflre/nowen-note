import type { EditorRuntimeDecision } from "@/lib/editorRuntimePolicy";

/** 大纲由 Worker 异步生成，优化模式不应关闭用户的文档导航能力。 */
export function shouldPublishRealtimeTiptapOutline(decision: EditorRuntimeDecision): boolean {
  void decision;
  return true;
}

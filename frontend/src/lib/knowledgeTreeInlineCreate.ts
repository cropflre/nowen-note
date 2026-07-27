export type KnowledgeTreeInlineCreateKind = "folder" | "note" | "markdown";

export interface KnowledgeTreeInlineDraft {
  parentId: string | null;
  kind: KnowledgeTreeInlineCreateKind;
  title: string;
  saving: boolean;
  error: string | null;
}

export function defaultInlineCreateTitle(kind: KnowledgeTreeInlineCreateKind): string {
  if (kind === "folder") return "未命名文件夹";
  if (kind === "markdown") return "未命名 Markdown";
  return "未命名文档";
}

export function normalizeInlineCreateTitle(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

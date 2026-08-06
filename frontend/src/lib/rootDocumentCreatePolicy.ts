export const ROOT_DOCUMENT_NOTEBOOK_PREFIX = "__nowen_root_documents__:";

export type RootDocumentCreateInput = {
  notebookId?: string | null;
  title?: string | null;
  content?: string | null;
  contentText?: string | null;
  contentFormat?: string | null;
};

export type RootDocumentNodeType = "note" | "markdown";

export function isRootDocumentNotebookId(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ROOT_DOCUMENT_NOTEBOOK_PREFIX);
}

export function resolveRootDocumentNodeType(input: RootDocumentCreateInput): RootDocumentNodeType {
  return input.contentFormat === "markdown" ? "markdown" : "note";
}

export function resolveRootDocumentTitle(input: RootDocumentCreateInput): string {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title) return title;
  return resolveRootDocumentNodeType(input) === "markdown" ? "无标题 Markdown" : "无标题笔记";
}

export function rootDocumentCreateRequestKey(input: RootDocumentCreateInput): string {
  return [
    input.notebookId || "",
    resolveRootDocumentNodeType(input),
    resolveRootDocumentTitle(input),
    input.content || "",
  ].join("\u0000");
}

export function buildRootDocumentFollowupPatch(
  created: { title?: string | null; content?: string | null; contentFormat?: string | null },
  input: RootDocumentCreateInput,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const title = resolveRootDocumentTitle(input);

  if (created.title !== title) patch.title = title;
  if (typeof input.content === "string" && created.content !== input.content) {
    patch.content = input.content;
    if (typeof input.contentText === "string") patch.contentText = input.contentText;
  }
  if (typeof input.contentFormat === "string" && created.contentFormat !== input.contentFormat) {
    patch.contentFormat = input.contentFormat;
  }
  if (input.contentFormat === "markdown" && (patch.content !== undefined || patch.contentFormat !== undefined)) {
    patch.syncToYjs = true;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

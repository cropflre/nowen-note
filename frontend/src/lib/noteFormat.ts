export type NoteContentFormat = "markdown" | "tiptap-json" | "html";

export function getNoteFormatLabel(contentFormat?: string): string {
  if (contentFormat === "markdown") return "MD";
  if (contentFormat === "html") return "HTML";
  return "RT";
}

export function getNoteFormatFullLabel(contentFormat?: string): string {
  if (contentFormat === "markdown") return "Markdown";
  if (contentFormat === "html") return "HTML";
  return "Rich text";
}

export function isMarkdownNote(contentFormat?: string): boolean {
  return contentFormat === "markdown";
}

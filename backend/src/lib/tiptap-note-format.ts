/** Classify legacy note content without ever converting or persisting it. */
export type TiptapContentDiagnosis = "valid" | "html-markup" | "invalid-json" | "invalid-doc";
export function diagnoseTiptapContent(content: string): TiptapContentDiagnosis {
  const text = content.trimStart();
  if (/^<(?:!doctype|html|body|blockquote|article|section|div|p|h[1-6]|ul|ol|table|figure|img|span)\b/i.test(text)) return "html-markup";
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { return "invalid-json"; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid-doc";
  const doc = value as Record<string, unknown>;
  return doc.type === "doc" && Array.isArray(doc.content) ? "valid" : "invalid-doc";
}

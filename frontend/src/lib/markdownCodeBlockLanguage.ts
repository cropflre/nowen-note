import { normalizeCodeBlockLanguageId } from "@/lib/codeBlockLanguageRegistry";

/** Share the effective language between Markdown highlighting and formatting. */
export function resolveMarkdownCodeBlockLanguage(code: string, language: string): string {
  const id = normalizeCodeBlockLanguageId(language);
  const unlabelled = !id || id === "auto" || id === "text";
  // A doctype is an HTML document signature, never a JavaScript/JSX expression.
  // Keep other explicit languages and JSX fragments on their declared parser.
  if ((unlabelled || id === "javascript") && /^\s*<!doctype\s+html(?:\s[^>]*)?>/i.test(code)) {
    return "html";
  }
  if (unlabelled && /^\s*<html(?:\s|>)/i.test(code)) return "html";
  return language;
}

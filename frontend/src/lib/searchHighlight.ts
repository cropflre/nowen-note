import DOMPurify from "dompurify";

export function splitSearchTerms(query: string): string[] {
  return Array.from(new Set((query || "").match(/[\p{Script=Han}]|[^\s\p{Script=Han}]+/gu) || []));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap search terms in <mark> tags. */
export function highlightText(text: string, query: string): string {
  if (!query || !text) return DOMPurify.sanitize(text || "");
  let result = DOMPurify.sanitize(text);
  for (const kw of splitSearchTerms(query).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(${escapeRegExp(kw)})`, "gi");
    result = result.replace(re, '<mark class="search-result-highlight">$1</mark>');
  }
  return result;
}

export function stripSearchMarks(html: string): string {
  return DOMPurify.sanitize(html || "", { ALLOWED_TAGS: [] });
}

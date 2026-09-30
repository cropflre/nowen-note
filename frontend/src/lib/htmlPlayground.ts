import { normalizeCodeBlockLanguageId } from "@/lib/codeBlockLanguageRegistry";

export function isHtmlPlaygroundLanguage(language: string): boolean {
  return normalizeCodeBlockLanguageId(language) === "html";
}

// Applied before any user markup. Sandbox permissions are set separately on the iframe.
export const HTML_PLAYGROUND_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function buildHtmlPlaygroundDocument(source: string): string {
  return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="${HTML_PLAYGROUND_CSP}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body>${source}</body></html>`;
}

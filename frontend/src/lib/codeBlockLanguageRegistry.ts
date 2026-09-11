export const CODE_BLOCK_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  shell: "bash",
  py: "python",
  yml: "yaml",
  md: "markdown",
  plaintext: "text",
  txt: "text",
  cs: "csharp",
  "c#": "csharp",
  ps1: "powershell",
  ms: "maxscript",
  mcr: "maxscript",
};

const CODE_BLOCK_LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  auto: "Auto",
  text: "Text",
  plaintext: "Text",
  bash: "Bash",
  shell: "Shell",
  sh: "Shell",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  xml: "XML",
  javascript: "JavaScript",
  js: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  markdown: "Markdown",
  md: "Markdown",
  maxscript: "MAXScript",
  ms: "MAXScript",
  mcr: "MAXScript",
  python: "Python",
  py: "Python",
  sql: "SQL",
  typescript: "TypeScript",
  ts: "TypeScript",
  tsx: "TSX",
  yaml: "YAML",
  yml: "YAML",
  java: "Java",
  go: "Go",
  rust: "Rust",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  powershell: "PowerShell",
  php: "PHP",
  ruby: "Ruby",
  kotlin: "Kotlin",
  swift: "Swift",
  diff: "Diff",
  dockerfile: "Dockerfile",
  mermaid: "Mermaid",
};

/**
 * One product-level shortlist shared by rich-text selectors and Markdown authoring completion.
 * The actual highlighter can expose a larger registry; this list is intentionally the common UX
 * surface, not a claim that unsupported languages cannot be stored in Markdown.
 */
export const CODE_BLOCK_POPULAR_LANGUAGES = [
  "auto", "plaintext",
  "javascript", "typescript", "tsx", "jsx",
  "html", "css", "scss", "json", "xml",
  "python", "java", "c", "cpp", "csharp",
  "go", "rust", "php", "ruby", "kotlin", "swift",
  "bash", "shell", "powershell",
  "sql", "yaml", "markdown", "diff", "dockerfile",
  "maxscript", "mermaid",
] as const;

export function normalizeCodeBlockLanguageId(raw: string | null | undefined): string {
  const language = String(raw || "").trim().toLowerCase();
  return CODE_BLOCK_LANGUAGE_ALIASES[language] || language;
}

/** Pretty product label. Unknown ids are preserved instead of rejected. */
export function getCodeBlockLanguageDisplayLabel(raw: string | null | undefined): string {
  const language = String(raw || "").trim().toLowerCase();
  if (!language) return "Text";
  const canonical = normalizeCodeBlockLanguageId(language);
  return CODE_BLOCK_LANGUAGE_LABELS[language]
    || CODE_BLOCK_LANGUAGE_LABELS[canonical]
    || String(raw).trim();
}

/** Canonical completion ids derived from the same product shortlist used by the rich-text picker. */
export function getCodeBlockAuthoringLanguages(): string[] {
  const languages = new Set<string>();
  for (const language of CODE_BLOCK_POPULAR_LANGUAGES) {
    const canonical = normalizeCodeBlockLanguageId(language);
    if (!canonical || canonical === "auto") continue;
    languages.add(canonical);
  }
  languages.add("text");
  return Array.from(languages);
}

export function isKnownCodeBlockLanguage(raw: string | null | undefined): boolean {
  const language = String(raw || "").trim().toLowerCase();
  if (!language) return false;
  if (Object.prototype.hasOwnProperty.call(CODE_BLOCK_LANGUAGE_ALIASES, language)) return true;
  return getCodeBlockAuthoringLanguages().includes(language);
}

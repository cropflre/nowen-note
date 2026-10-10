export type ClipboardHtmlKind = "empty" | "text-shell" | "rich" | "ambiguous";

export type ClipboardRoutingReason =
  | "empty-html"
  | "text-shell"
  | "semantic-rich-html"
  | "embedded-content"
  | "rich-inline-style"
  | "nowen-or-prosemirror-content"
  | "text-mismatch"
  | "unknown-html"
  | "rich-rtf"
  | "not-markdown";

export interface ClipboardHtmlAnalysis {
  kind: ClipboardHtmlKind;
  plainTextEquivalent: boolean | null;
  hasRichStructure: boolean;
  hasEmbeddedContent: boolean;
  visibleText: string;
  tags: string[];
  reason: ClipboardRoutingReason;
}

export interface ClipboardPasteRoutingInput {
  text: string;
  html: string;
  rtf?: string;
  markdownLike: boolean;
}

const METADATA_TAGS = new Set([
  "html",
  "head",
  "meta",
  "body",
  "title",
  "base",
  "link",
  "style",
]);

// These elements commonly appear when Chromium/Electron, chat tools and web apps expose a
// text/plain clipboard payload through text/html as well. They do not, by themselves, carry a
// richer semantic structure than the text channel.
const TEXT_SHELL_TAGS = new Set([
  "div",
  "p",
  "span",
  "br",
  "section",
  "article",
  "main",
  "header",
  "footer",
]);

const SEMANTIC_RICH_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "col", "colgroup",
  "blockquote",
  "strong", "b", "em", "i", "u", "del", "s", "strike", "mark",
  "a",
  "pre", "code", "kbd", "samp",
  "sub", "sup",
  "dl", "dt", "dd",
  "figure", "figcaption",
  "hr",
  "font",
  "details", "summary",
]);

const EMBEDDED_CONTENT_TAGS = new Set([
  "img",
  "picture",
  "source",
  "video",
  "audio",
  "iframe",
  "object",
  "embed",
  "svg",
  "canvas",
  "math",
  "input",
]);

const BLOCK_TEXT_TAGS = new Set([
  "div", "p", "section", "article", "main", "header", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "blockquote", "pre", "figure", "figcaption", "dl", "dt", "dd",
]);

function normalizeTagName(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

/**
 * Normalize only for deciding whether HTML and text/plain represent the same clipboard payload.
 * Never use this result as editor content: Markdown-significant indentation/content is kept in the
 * original clipboard string used by the actual paste path.
 */
export function normalizeClipboardComparisonText(value: string): string {
  return (value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendBoundary(buffer: string[]): void {
  if (buffer.length === 0) return;
  const last = buffer[buffer.length - 1] || "";
  if (!last.endsWith("\n")) buffer.push("\n");
}

/** Convert clipboard HTML to visible text while preserving block boundaries for comparison. */
export function extractClipboardVisibleText(html: string): string {
  if (!html.trim() || typeof DOMParser === "undefined") return "";

  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const buffer: string[] = [];

    const walk = (node: ChildNode): void => {
      // TEXT_NODE = 3, ELEMENT_NODE = 1. Numeric checks also keep this helper resilient in jsdom.
      if (node.nodeType === 3) {
        buffer.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== 1) return;

      const element = node as Element;
      const tag = normalizeTagName(element.tagName);
      if (tag === "br") {
        buffer.push("\n");
        return;
      }

      const block = BLOCK_TEXT_TAGS.has(tag);
      if (block) appendBoundary(buffer);
      element.childNodes.forEach(walk);
      if (block) appendBoundary(buffer);
    };

    doc.body.childNodes.forEach(walk);
    return normalizeClipboardComparisonText(buffer.join(""));
  } catch {
    return "";
  }
}

function hasRichInlineStyle(style: string): boolean {
  if (!style) return false;
  return (
    /font-weight\s*:\s*(?:bold|bolder|[6-9]00)\b/i.test(style)
    || /font-style\s*:\s*(?:italic|oblique)\b/i.test(style)
    || /text-decoration(?:-line)?\s*:[^;]*(?:underline|line-through)/i.test(style)
    || /background(?:-color)?\s*:\s*(?!transparent\b|rgba?\([^)]*,\s*0(?:\.0+)?\s*\))/i.test(style)
    || /font-size\s*:\s*(?!inherit\b|initial\b|unset\b)/i.test(style)
  );
}

function hasNowenOrProseMirrorAttribute(element: Element): boolean {
  return Array.from(element.attributes).some((attribute) => {
    const name = attribute.name.toLowerCase();
    return name === "data-pm-slice" || name.startsWith("data-nowen-");
  });
}

function fallbackTagNames(html: string): string[] {
  const result = new Set<string>();
  const pattern = /<\/?\s*([a-z][a-z0-9:-]*)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) result.add(match[1].toLowerCase());
  return [...result].sort();
}

/**
 * Classify the semantic value of text/html, instead of treating any div/span/p wrapper as rich
 * text. If text/plain is supplied, a shell whose visible text differs from it fails closed as
 * ambiguous so we never discard richer clipboard data by guesswork.
 */
export function classifyClipboardHtml(input: { html: string; text?: string }): ClipboardHtmlAnalysis {
  const html = input.html || "";
  if (!html.trim()) {
    return {
      kind: "empty",
      plainTextEquivalent: input.text == null ? null : normalizeClipboardComparisonText(input.text) === "",
      hasRichStructure: false,
      hasEmbeddedContent: false,
      visibleText: "",
      tags: [],
      reason: "empty-html",
    };
  }

  if (typeof DOMParser === "undefined") {
    const tags = fallbackTagNames(html).filter((tag) => !METADATA_TAGS.has(tag));
    const hasEmbeddedContent = tags.some((tag) => EMBEDDED_CONTENT_TAGS.has(tag));
    const hasRichStructure = tags.some((tag) => SEMANTIC_RICH_TAGS.has(tag));
    const hasUnknown = tags.some((tag) => !TEXT_SHELL_TAGS.has(tag)
      && !SEMANTIC_RICH_TAGS.has(tag)
      && !EMBEDDED_CONTENT_TAGS.has(tag));
    return {
      kind: hasEmbeddedContent || hasRichStructure ? "rich" : hasUnknown ? "ambiguous" : "text-shell",
      plainTextEquivalent: null,
      hasRichStructure,
      hasEmbeddedContent,
      visibleText: "",
      tags,
      reason: hasEmbeddedContent
        ? "embedded-content"
        : hasRichStructure
          ? "semantic-rich-html"
          : hasUnknown
            ? "unknown-html"
            : "text-shell",
    };
  }

  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const elements = Array.from(doc.body.querySelectorAll("*"));
    const tags = [...new Set(elements.map((element) => normalizeTagName(element.tagName)))].sort();
    const visibleText = extractClipboardVisibleText(html);
    const plainTextEquivalent = input.text == null
      ? null
      : normalizeClipboardComparisonText(input.text) === visibleText;

    const embedded = elements.find((element) => EMBEDDED_CONTENT_TAGS.has(normalizeTagName(element.tagName)));
    if (embedded) {
      return {
        kind: "rich",
        plainTextEquivalent,
        hasRichStructure: true,
        hasEmbeddedContent: true,
        visibleText,
        tags,
        reason: "embedded-content",
      };
    }

    const internal = elements.find(hasNowenOrProseMirrorAttribute);
    if (internal) {
      return {
        kind: "rich",
        plainTextEquivalent,
        hasRichStructure: true,
        hasEmbeddedContent: false,
        visibleText,
        tags,
        reason: "nowen-or-prosemirror-content",
      };
    }

    const semantic = elements.find((element) => SEMANTIC_RICH_TAGS.has(normalizeTagName(element.tagName)));
    if (semantic) {
      return {
        kind: "rich",
        plainTextEquivalent,
        hasRichStructure: true,
        hasEmbeddedContent: false,
        visibleText,
        tags,
        reason: "semantic-rich-html",
      };
    }

    const styled = elements.find((element) => hasRichInlineStyle(element.getAttribute("style") || ""));
    if (styled) {
      return {
        kind: "rich",
        plainTextEquivalent,
        hasRichStructure: true,
        hasEmbeddedContent: false,
        visibleText,
        tags,
        reason: "rich-inline-style",
      };
    }

    const unknown = elements.find((element) => {
      const tag = normalizeTagName(element.tagName);
      return !TEXT_SHELL_TAGS.has(tag) && !METADATA_TAGS.has(tag);
    });
    if (unknown) {
      return {
        kind: "ambiguous",
        plainTextEquivalent,
        hasRichStructure: false,
        hasEmbeddedContent: false,
        visibleText,
        tags,
        reason: "unknown-html",
      };
    }

    // HTML with only metadata and no visible/body content is the same as no HTML channel.
    if (elements.length === 0 && visibleText === "") {
      return {
        kind: "empty",
        plainTextEquivalent: input.text == null ? null : normalizeClipboardComparisonText(input.text) === "",
        hasRichStructure: false,
        hasEmbeddedContent: false,
        visibleText,
        tags,
        reason: "empty-html",
      };
    }

    if (plainTextEquivalent === false) {
      return {
        kind: "ambiguous",
        plainTextEquivalent,
        hasRichStructure: false,
        hasEmbeddedContent: false,
        visibleText,
        tags,
        reason: "text-mismatch",
      };
    }

    return {
      kind: "text-shell",
      plainTextEquivalent,
      hasRichStructure: false,
      hasEmbeddedContent: false,
      visibleText,
      tags,
      reason: "text-shell",
    };
  } catch {
    return {
      kind: "ambiguous",
      plainTextEquivalent: null,
      hasRichStructure: false,
      hasEmbeddedContent: false,
      visibleText: "",
      tags: fallbackTagNames(html),
      reason: "unknown-html",
    };
  }
}

/** Embedded RTF media must stay on the rich clipboard route so image data is not discarded. */
export function hasRichRtfContent(rtf: string | null | undefined): boolean {
  if (!rtf) return false;
  return /\\(?:pict|pngblip|jpegblip|emfblip|wmetafile)\b/i.test(rtf);
}

// Legacy TiptapEditor currently supplies only `html + markdownLike`. For a text-shell HTML payload
// we therefore require independent Markdown structure evidence in the HTML-visible text before
// allowing Markdown to win. This is deliberately conservative and keeps ambiguous HTML fail-closed.
function hasMarkdownStructureEvidence(text: string): boolean {
  const normalized = normalizeClipboardComparisonText(text);
  if (!normalized) return false;

  if (/!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)/.test(normalized)) return true;
  if (/(?<!!)\[[^\]]+\]\([^)\s]+(?:\s+"[^"]*")?\)/.test(normalized)) return true;

  let score = 0;
  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+.+/.test(trimmed)) score += 2;
    else if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) score += 2;
    else if (/^\|?.+\|.+\|?$/.test(trimmed) && trimmed.includes("|")) score += 1;
    else if (/^\|?\s*:?-{3,}:?\s*\|/.test(trimmed)) score += 3;
    else if (/^[-*+]\s+\[[ xX]\]\s+/.test(trimmed)) score += 2;
    else if (/^[-*+]\s+\S/.test(trimmed)) score += 1;
    else if (/^\d+[.)]\s+\S/.test(trimmed)) score += 1;
    else if (/^>\s+\S/.test(trimmed)) score += 1;
    else if (/^(---|\*\*\*|___)$/.test(trimmed)) score += 1;

    if (/\*\*[^*]+\*\*/.test(trimmed) || /__[^_]+__/.test(trimmed)) score += 1;
    if (/(^|[^`])`[^`]+`($|[^`])/.test(trimmed)) score += 0.5;
  }
  return score >= 3;
}

/**
 * Backward-compatible helper kept for callers/tests that only need to know whether HTML should
 * block Markdown routing. Wrapper-only HTML is no longer considered meaningful rich text.
 */
export function hasMeaningfulClipboardHtml(html: string): boolean {
  const analysis = classifyClipboardHtml({ html });
  return analysis.kind === "rich" || analysis.kind === "ambiguous";
}

export function shouldHandleAsMarkdownPaste(input: ClipboardPasteRoutingInput): boolean;
export function shouldHandleAsMarkdownPaste(html: string, markdownLike: boolean): boolean;
/**
 * Markdown wins only when rich clipboard semantics are absent. The object form is the canonical
 * contract for new callers because it can verify text/plain equivalence and protect rich RTF.
 * The two-argument form remains intentionally supported by TiptapEditor and uses a conservative
 * text-shell fallback, fixing div/span/p-wrapped Markdown without changing the Markdown score.
 */
export function shouldHandleAsMarkdownPaste(
  inputOrHtml: ClipboardPasteRoutingInput | string,
  legacyMarkdownLike?: boolean,
): boolean {
  const input: ClipboardPasteRoutingInput = typeof inputOrHtml === "string"
    ? {
        text: "",
        html: inputOrHtml,
        markdownLike: legacyMarkdownLike === true,
      }
    : inputOrHtml;

  if (!input.markdownLike) return false;
  if (hasRichRtfContent(input.rtf)) return false;

  const hasPlainText = typeof inputOrHtml !== "string";
  const analysis = classifyClipboardHtml({
    html: input.html,
    ...(hasPlainText ? { text: input.text } : {}),
  });

  if (analysis.kind === "empty") return true;
  if (analysis.kind !== "text-shell") return false;
  if (analysis.plainTextEquivalent === false) return false;

  // Canonical object callers already proved text/html equivalence. Legacy callers do not expose
  // text/plain here, so demand strong Markdown evidence from the shell's visible text as a guard.
  return hasPlainText ? true : hasMarkdownStructureEvidence(analysis.visibleText);
}

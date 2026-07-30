export type SiyuanRichTextCalloutType = "tip" | "note" | "important" | "warning" | "caution";

export interface SiyuanRichTextCalloutMarker {
  type: SiyuanRichTextCalloutType;
  title: string;
  icon: string;
  fold: "" | "+" | "-";
}

const CALLOUT_PRESENTATION: Record<SiyuanRichTextCalloutType, { title: string; icon: string }> = {
  tip: { title: "Tip", icon: "💡" },
  note: { title: "Note", icon: "✏️" },
  important: { title: "Important", icon: "❗" },
  warning: { title: "Warning", icon: "⚠️" },
  caution: { title: "Caution", icon: "🚨" },
};

const CALLOUT_MARKER_RE = /^\s*\[!(TIP|NOTE|IMPORTANT|WARNING|CAUTION)\]([+-])?(?:[ \t]+([^\r\n]+?))?\s*$/i;
// Tiptap's editorProps replaces the default root class with `prose ...`, so the
// production editor does not necessarily expose `.ProseMirror`. Keep the latter
// as a compatibility fallback for older shells and tests.
const CALLOUT_SELECTOR = ':is(.prose[contenteditable="true"], .ProseMirror) blockquote';
const CALLOUT_CLASS = "nowen-siyuan-callout";
const HEADER_CLASS = "nowen-siyuan-callout-header";

function normalizeDefaultTitleWithIcon(
  value: string,
  presentation: { title: string; icon: string },
): string {
  const title = value.trim();
  if (
    title === `${presentation.title} ${presentation.icon}`
    || title === `${presentation.icon} ${presentation.title}`
  ) {
    return presentation.title;
  }
  return title;
}

export function parseSiyuanRichTextCalloutMarker(value: string): SiyuanRichTextCalloutMarker | null {
  const match = CALLOUT_MARKER_RE.exec(String(value || ""));
  if (!match) return null;

  const type = match[1].toLowerCase() as SiyuanRichTextCalloutType;
  const presentation = CALLOUT_PRESENTATION[type];
  const customTitle = normalizeDefaultTitleWithIcon(match[3] || "", presentation);

  return {
    type,
    title: customTitle || presentation.title,
    icon: presentation.icon,
    fold: (match[2] || "") as "" | "+" | "-",
  };
}

function firstDirectParagraph(blockquote: HTMLQuoteElement): HTMLParagraphElement | null {
  const first = blockquote.firstElementChild;
  return first instanceof HTMLParagraphElement ? first : null;
}

function removeDecoration(blockquote: HTMLQuoteElement): void {
  if (!blockquote.classList.contains(CALLOUT_CLASS)) return;

  blockquote.classList.remove(CALLOUT_CLASS);
  blockquote.removeAttribute("data-nowen-siyuan-callout");
  blockquote.removeAttribute("data-callout-type");
  blockquote.removeAttribute("data-callout-title");
  blockquote.removeAttribute("data-callout-icon");
  blockquote.removeAttribute("data-callout-fold");

  const header = blockquote.querySelector<HTMLParagraphElement>(`:scope > p.${HEADER_CLASS}`);
  if (!header) return;
  header.classList.remove(HEADER_CLASS);
  header.removeAttribute("data-callout-type");
  header.removeAttribute("data-callout-title");
  header.removeAttribute("data-callout-icon");
  header.removeAttribute("data-callout-fold");
  header.removeAttribute("aria-label");
}

function collectBlockquotes(root: ParentNode): HTMLQuoteElement[] {
  const result: HTMLQuoteElement[] = [];
  if (root instanceof HTMLQuoteElement && root.matches(CALLOUT_SELECTOR)) result.push(root);
  result.push(...Array.from(root.querySelectorAll<HTMLQuoteElement>(CALLOUT_SELECTOR)));
  return result;
}

/**
 * Add presentation-only metadata to imported SiYuan Callouts in Tiptap.
 *
 * The ProseMirror document remains a standard blockquote whose first paragraph is
 * `[!TYPE] Title`. We never rewrite that text, so Markdown export and round-trip
 * conversion keep the native alert syntax. Only the rich-text DOM is decorated.
 */
export function decorateSiyuanRichTextCallouts(root: ParentNode = document): number {
  let decorated = 0;

  for (const blockquote of collectBlockquotes(root)) {
    const header = firstDirectParagraph(blockquote);
    const marker = header ? parseSiyuanRichTextCalloutMarker(header.textContent || "") : null;

    if (!header || !marker) {
      removeDecoration(blockquote);
      continue;
    }

    blockquote.classList.add(CALLOUT_CLASS);
    blockquote.setAttribute("data-nowen-siyuan-callout", "true");
    blockquote.setAttribute("data-callout-type", marker.type);
    blockquote.setAttribute("data-callout-title", marker.title);
    blockquote.setAttribute("data-callout-icon", marker.icon);
    blockquote.setAttribute("data-callout-fold", marker.fold);

    header.classList.add(HEADER_CLASS);
    header.setAttribute("data-callout-type", marker.type);
    header.setAttribute("data-callout-title", marker.title);
    header.setAttribute("data-callout-icon", marker.icon);
    header.setAttribute("data-callout-fold", marker.fold);
    header.setAttribute("aria-label", `${marker.icon} ${marker.title}`);
    decorated += 1;
  }

  return decorated;
}

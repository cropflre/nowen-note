import type { NoteEditorHeading } from "@/components/editors/types";
import { ensureUniqueHeadingIds } from "@/lib/shareOutline";

const HTML_PREVIEW_HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

function getHeadingElements(root: ParentNode | null | undefined): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(HTML_PREVIEW_HEADING_SELECTOR))
    .filter((heading) => (heading.textContent || "").trim().length > 0);
}

export function syncHtmlPreviewOutline(root: ParentNode | null | undefined): NoteEditorHeading[] {
  const headingElements = getHeadingElements(root);
  const outline = ensureUniqueHeadingIds(
    headingElements.map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: (heading.textContent || "").trim().replace(/\s+/g, " "),
    })),
  );

  outline.forEach((item, index) => {
    const heading = headingElements[index];
    if (!heading) return;
    heading.id = item.id;
    heading.classList.add("scroll-mt-24");
  });

  return outline.map((item, index) => ({ ...item, pos: index }));
}

export function scrollToHtmlPreviewHeading(
  root: ParentNode | null | undefined,
  pos: number,
): boolean {
  const heading = getHeadingElements(root)[pos];
  if (!heading) return false;
  heading.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

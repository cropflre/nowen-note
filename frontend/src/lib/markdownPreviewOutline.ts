export function getNodeStartOffset(node: any): number | undefined {
  const offset = node?.position?.start?.offset;
  return typeof offset === "number" && Number.isFinite(offset) ? offset : undefined;
}

export interface MarkdownPreviewHeading {
  id: string;
  level: number;
  pos: number;
}

function headingSlug(text: string): string {
  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\\([\\`*{}\[\]()#+\-.!_>~|])/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{Letter}\p{Number}\p{Mark}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-");
  return normalized || "section";
}

export function buildMarkdownPreviewHeadingIndex(markdown: string): MarkdownPreviewHeading[] {
  const headings: MarkdownPreviewHeading[] = [];
  const slugCounts = new Map<string, number>();
  const usedIds = new Set<string>();
  let lineStart = 0;
  let previousLine: { text: string; start: number } | null = null;
  let fence: { marker: "`" | "~"; length: number } | null = null;

  const appendHeading = (text: string, level: number, pos: number) => {
    const base = headingSlug(text);
    let duplicateIndex = slugCounts.get(base) || 0;
    let id = duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`;
    while (usedIds.has(id)) {
      duplicateIndex += 1;
      id = `${base}-${duplicateIndex}`;
    }
    slugCounts.set(base, duplicateIndex + 1);
    usedIds.add(id);
    headings.push({
      id,
      level,
      pos,
    });
  };

  for (let index = 0; index <= markdown.length; index += 1) {
    if (index < markdown.length && markdown.charCodeAt(index) !== 10) continue;
    const line = markdown.slice(lineStart, index).replace(/\r$/, "");
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);

    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length };
      } else if (fence.marker === marker && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      previousLine = null;
      lineStart = index + 1;
      continue;
    }

    if (!fence) {
      const atx = /^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/.exec(line);
      if (atx) {
        const text = atx[2].replace(/[\t ]+#+[\t ]*$/, "").trim();
        appendHeading(text, atx[1].length, lineStart);
        previousLine = null;
      } else {
        const setext = /^ {0,3}(=+|-+)[\t ]*$/.exec(line);
        if (setext && previousLine && previousLine.text.trim()) {
          appendHeading(previousLine.text.trim(), setext[1][0] === "=" ? 1 : 2, previousLine.start);
        }
        previousLine = line.trim() ? { text: line, start: lineStart } : null;
      }
    }

    lineStart = index + 1;
  }

  return headings;
}

export function headingDataAttrs(
  node: any,
  baseOffset = 0,
  headingIds?: ReadonlyMap<number, string>,
  headingPositions?: ReadonlyMap<number, number>,
): Record<string, string> {
  const offset = getNodeStartOffset(node);
  if (offset == null) return {};
  const globalOffset = baseOffset + offset;
  const id = headingIds?.get(globalOffset);
  const sourceOffset = headingPositions?.get(globalOffset) ?? globalOffset;
  return id
    ? { id, "data-md-pos": String(sourceOffset) }
    : { "data-md-pos": String(sourceOffset) };
}

export function findMarkdownPreviewHeadingTarget(
  headings: Iterable<HTMLElement>,
  pos: number,
): HTMLElement | null {
  const candidates = Array.from(headings)
    .map((el) => ({ el, pos: Number(el.dataset.mdPos) }))
    .filter((item) => Number.isFinite(item.pos))
    .sort((a, b) => a.pos - b.pos);

  if (!candidates.length) return null;

  const exact = candidates.find((item) => item.pos === pos);
  if (exact) return exact.el;

  const previous = [...candidates].reverse().find((item) => item.pos <= pos);
  return (previous || candidates[0]).el;
}

const pendingScrolls = new WeakMap<HTMLElement, () => void>();

function previewHeadings(root: HTMLElement): NodeListOf<HTMLElement> {
  return root.querySelectorAll<HTMLElement>(
    "h1[data-md-pos], h2[data-md-pos], h3[data-md-pos], h4[data-md-pos], h5[data-md-pos], h6[data-md-pos]",
  );
}

/** 先定位未挂载的分段，再在标题渲染后精确定位。 */
export function scrollMarkdownPreviewToPosition(root: HTMLElement, pos: number): boolean {
  pendingScrolls.get(root)?.();
  pendingScrolls.delete(root);

  const headings = previewHeadings(root);
  const exact = Array.from(headings).find((heading) => Number(heading.dataset.mdPos) === pos);
  if (exact) {
    exact.scrollIntoView({ block: "start", behavior: "smooth" });
    return true;
  }

  const segments = Array.from(root.querySelectorAll<HTMLElement>("[data-markdown-segment]"));
  const segment = segments.find((candidate) => {
    const start = Number(candidate.dataset.mdSegmentStart);
    const end = Number(candidate.dataset.mdSegmentEnd);
    return Number.isFinite(start) && Number.isFinite(end) && pos >= start && pos < end;
  });

  if (!segment) {
    const target = findMarkdownPreviewHeadingTarget(headings, pos);
    if (!target) return false;
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    return true;
  }

  segment.scrollIntoView({ block: "start", behavior: "smooth" });
  if (typeof MutationObserver === "undefined") return true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    const mountedTarget = Array.from(previewHeadings(root))
      .find((heading) => Number(heading.dataset.mdPos) === pos);
    if (!mountedTarget) return;
    cleanup();
    mountedTarget.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  const cleanup = () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
    if (pendingScrolls.get(root) === cleanup) pendingScrolls.delete(root);
  };
  observer.observe(segment, { childList: true, subtree: true });
  timer = setTimeout(cleanup, 2_000);
  pendingScrolls.set(root, cleanup);
  return true;
}

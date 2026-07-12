export interface ShareOutlineItem {
  id: string;
  level: number;
  text: string;
}

const MAX_HEADING_LEVEL = 6;

export function createHeadingId(text: string): string {
  const normalized = text
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "heading";
}

export function ensureUniqueHeadingIds(
  headings: Array<Omit<ShareOutlineItem, "id"> & { id?: string }>
): ShareOutlineItem[] {
  const counts = new Map<string, number>();

  return headings
    .map((heading) => ({
      level: heading.level,
      text: heading.text.trim().replace(/\s+/g, " "),
      id: heading.id?.trim() || createHeadingId(heading.text),
    }))
    .filter((heading) => heading.text.length > 0)
    .map((heading) => {
      const baseId = heading.id || createHeadingId(heading.text);
      const count = (counts.get(baseId) || 0) + 1;
      counts.set(baseId, count);
      return {
        ...heading,
        id: count === 1 ? baseId : `${baseId}-${count}`,
      };
    });
}

export function extractOutlineFromTiptap(input: unknown): ShareOutlineItem[] {
  const doc = parseTiptapInput(input);
  if (!doc) return [];

  const headings: Array<Omit<ShareOutlineItem, "id">> = [];

  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "heading") {
      const level = Number(node.attrs?.level || 1);
      const text = extractTiptapText(node).trim().replace(/\s+/g, " ");
      if (level >= 1 && level <= MAX_HEADING_LEVEL && text) {
        headings.push({ level, text });
      }
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };

  walk(doc);
  return ensureUniqueHeadingIds(headings);
}

export function extractOutlineFromMarkdown(markdown: string | null | undefined): ShareOutlineItem[] {
  if (!markdown) return [];

  const headings: Array<Omit<ShareOutlineItem, "id">> = [];
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }

    if (inFence) continue;

    const match = line.match(/^(#{1,6})(?!#)\s+(.+?)\s*#*\s*$/);
    if (!match) continue;

    const text = stripMarkdownInline(match[2]).trim().replace(/\s+/g, " ");
    if (text) headings.push({ level: match[1].length, text });
  }

  return ensureUniqueHeadingIds(headings);
}

export function extractOutlineFromHtml(html: string | null | undefined): ShareOutlineItem[] {
  if (!html || typeof DOMParser === "undefined") return [];

  const doc = new DOMParser().parseFromString(html, "text/html");
  const headings = Array.from(doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .map((el) => ({
      level: Number(el.tagName.slice(1)),
      text: (el.textContent || "").trim().replace(/\s+/g, " "),
    }))
    .filter((heading) => heading.text.length > 0);

  return ensureUniqueHeadingIds(headings);
}

export function addHeadingIdsToHtml(html: string | null | undefined): string {
  if (!html || typeof DOMParser === "undefined") return html || "";

  const doc = new DOMParser().parseFromString(html, "text/html");
  const outline = extractOutlineFromHtml(html);
  const headings = Array.from(doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .filter((el) => (el.textContent || "").trim().length > 0);

  headings.forEach((heading, index) => {
    const item = outline[index];
    if (!item) return;
    heading.setAttribute("id", item.id);
    heading.classList.add("scroll-mt-24");
  });

  return doc.body.innerHTML;
}

function parseTiptapInput(input: unknown): any | null {
  if (!input) return null;
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (typeof input === "object") return input;
  return null;
}

function extractTiptapText(node: any): string {
  if (!node || typeof node !== "object") return "";
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";
  return node.content.map(extractTiptapText).join("");
}

function stripMarkdownInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]+>/g, "");
}

const HTML_CONTENT_ROOT_SELECTORS = [
  "#js_content",
  ".rich_media_content",
  "article",
  "main",
  "[role=main]",
  "body",
];

const REMOTE_IMAGE_SOURCE_ATTRIBUTES = [
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-actualsrc",
];

const REMOVABLE_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "frame",
  "form",
  "button",
  "input",
  "textarea",
  "select",
  "option",
  "canvas",
  "template",
  "meta",
  "link",
].join(",");

const ALLOWED_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "title", "width", "height", "loading"]),
  video: new Set(["src", "poster", "controls", "width", "height"]),
  audio: new Set(["src", "controls"]),
  source: new Set(["src", "type"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
  ol: new Set(["start"]),
  li: new Set(["data-type", "data-checked", "data-block-id"]),
  p: new Set(["data-block-id"]),
  h1: new Set(["data-block-id"]),
  h2: new Set(["data-block-id"]),
  h3: new Set(["data-block-id"]),
  h4: new Set(["data-block-id"]),
  h5: new Set(["data-block-id"]),
  h6: new Set(["data-block-id"]),
  blockquote: new Set(["data-block-id"]),
  pre: new Set(["data-language", "data-block-id"]),
  code: new Set(["data-language"]),
};

function normalizeRemoteUrl(value: string | null): string | null {
  const candidate = String(value || "").trim();
  if (/^https?:\/\//i.test(candidate)) return candidate;
  if (candidate.startsWith("//")) return `https:${candidate}`;
  return null;
}

function preferRemoteSingleFileImages(root: ParentNode): void {
  root.querySelectorAll("img").forEach((image) => {
    const currentSrc = String(image.getAttribute("src") || "").trim();
    if (!/^data:image\//i.test(currentSrc)) return;

    for (const attribute of REMOTE_IMAGE_SOURCE_ATTRIBUTES) {
      const remoteUrl = normalizeRemoteUrl(image.getAttribute(attribute));
      if (!remoteUrl) continue;
      image.setAttribute("src", remoteUrl);
      image.setAttribute("loading", "lazy");
      break;
    }
  });
}

function stripUnsafeAndLayoutAttributes(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("*").forEach((element) => {
    const allowed = ALLOWED_ATTRIBUTES[element.tagName.toLowerCase()] || new Set<string>();
    for (const attribute of Array.from(element.attributes)) {
      if (!allowed.has(attribute.name.toLowerCase())) {
        element.removeAttribute(attribute.name);
      }
    }

    if (element.tagName === "A") {
      const href = String(element.getAttribute("href") || "").trim();
      if (/^javascript:/i.test(href)) element.removeAttribute("href");
    }
  });
}

function hasMeaningfulContent(root: ParentNode): boolean {
  const text = String(root.textContent || "").replace(/\s+/g, "").trim();
  return text.length > 0 || Boolean(root.querySelector("img,video,audio,table,pre,blockquote"));
}

/**
 * Normalize browser-saved HTML before the existing import pipeline converts it to Tiptap JSON.
 *
 * SingleFile pages often omit an explicit <body>, wrap the article in a site-specific root, and
 * duplicate every remote image as a multi-megabyte data URI while retaining the original URL in
 * data-src. Feeding that whole document into the generic importer inflates the JSON request and can
 * hit the normal write timeout. DOMParser gives us a standards-compliant body even when the source
 * omitted one, and the content-root preference keeps navigation/toolbar/sidebar markup out.
 */
export function normalizeImportedHtmlContent(html: string): string {
  if (!html || typeof DOMParser === "undefined") return html;

  try {
    const document = new DOMParser().parseFromString(html, "text/html");
    const sourceRoot = HTML_CONTENT_ROOT_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find((candidate): candidate is Element => Boolean(candidate));
    if (!sourceRoot) return html;

    const container = document.createElement("div");
    container.append(...Array.from(sourceRoot.childNodes).map((node) => node.cloneNode(true)));
    container.querySelectorAll(REMOVABLE_ELEMENTS).forEach((element) => element.remove());
    preferRemoteSingleFileImages(container);
    stripUnsafeAndLayoutAttributes(container);

    return hasMeaningfulContent(container) ? container.innerHTML.trim() : html;
  } catch (error) {
    console.warn("[import] failed to normalize saved HTML; using original source", error);
    return html;
  }
}

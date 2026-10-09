type AssetUrlResolver = (src: string) => string;

type HtmlPreviewAssetOptions = {
  fullDocument?: boolean;
  deferUnsignedAttachments?: boolean;
  /** Sanitizes the markup only after external image URLs have been neutralized. */
  sanitizeHtml?: (html: string) => string;
};

const ATTACHMENT_PATH = /^\/(?:api|publicapi)\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_TAG_RE = /<(?:img|source|video|audio)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const NETWORK_ATTR_RE = /\s(src|srcset|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
type HiddenAsset = { attribute: "src" | "srcset" | "poster"; raw: string };

function needsAttachmentSignature(src: string): boolean {
  try {
    const url = new URL(src, "http://localhost/");
    if (!/^https?:$/.test(url.protocol) || !ATTACHMENT_PATH.test(url.pathname)) return false;
    if (url.searchParams.has("share")) return false;
    return !(url.searchParams.has("exp") && url.searchParams.has("sig") && url.searchParams.has("scope"));
  } catch {
    return false;
  }
}

/**
 * DOMParser and DOMPurify may start fetching an <img> even while its document is
 * detached. Neutralize image URLs in the *string* before either parser sees it.
 * Token attributes are inert, temporary, and removed from the returned markup.
 * Keep video/audio <source src> unchanged; they are not picture srcset images.
 */
function maskPreparseImageSources(html: string): {
  markup: string;
  assets: Map<string, HiddenAsset>;
} {
  const assets = new Map<string, HiddenAsset>();
  const markup = html.replace(ASSET_TAG_RE, (tag) => {
    const isImage = /^<img\b/i.test(tag);
    return tag.replace(NETWORK_ATTR_RE, (original, rawAttr: string, double: string, single: string, bare: string) => {
      const attribute = rawAttr.toLowerCase() as "src" | "srcset" | "poster";
      const raw = double ?? single ?? bare ?? "";
      // Mask network-capable HTML media before DOMParser touches them.
      // <source srcset> in a picture is covered as well.
      if (attribute === "srcset" && !isImage && !/\/(?:api|publicapi)\/attachments\//i.test(raw)) return original;
      if (attribute === "poster" && !/^<video\b/i.test(tag)) return original;
      const token = String(assets.size);
      assets.set(token, { attribute, raw });
      return ` data-nowen-preview-${attribute}-token="${token}"`;
    });
  });
  return { markup, assets };
}

function resolveImageSrcset(
  raw: string,
  resolveSafeUrl: (raw: string) => string | null,
): string | null {
  if (!/\/(?:api|publicapi)\/attachments\//i.test(raw)) return raw;
  const candidates = raw.split(",").map((entry) => {
    const match = entry.trim().match(/^(\S+)(\s+.*)?$/);
    if (!match) return "";
    const result = resolveSafeUrl(match[1]);
    return result === null ? "" : result + (match[2] || "");
  }).filter(Boolean);
  return candidates.length ? candidates.join(", ") : null;
}

export function resolveHtmlPreviewAssetUrls(
  html: string | null | undefined,
  resolveUrl: AssetUrlResolver,
  options: HtmlPreviewAssetOptions = {},
): string {
  if (!html || typeof DOMParser === "undefined") return html || "";

  const { markup, assets } = maskPreparseImageSources(html);
  const safeMarkup = options.sanitizeHtml ? options.sanitizeHtml(markup) : markup;
  const doc = new DOMParser().parseFromString(safeMarkup, "text/html");

  const resolveSafeImageUrl = (raw: string): string | null => {
    const resolved = resolveUrl(raw);
    return options.deferUnsignedAttachments && needsAttachmentSignature(resolved) ? null : resolved;
  };

  doc.querySelectorAll<HTMLImageElement | HTMLSourceElement | HTMLVideoElement | HTMLAudioElement>("img,source,video,audio").forEach((element) => {
    const isImage = element.tagName.toLowerCase() === "img";
    for (const attribute of ["src", "srcset", "poster"] as const) {
      if (attribute === "poster" && element.tagName.toLowerCase() !== "video") continue;
      if (attribute === "srcset" && !isImage && element.tagName.toLowerCase() !== "source") continue;
      const tokenName = `data-nowen-preview-${attribute}-token`;
      const token = element.getAttribute(tokenName);
      const asset = token !== null ? assets.get(token) : undefined;
      element.removeAttribute(tokenName);
      const raw = asset?.attribute === attribute ? asset.raw : element.getAttribute(attribute);
      if (!raw) continue;
      const resolved = attribute === "srcset"
        ? resolveImageSrcset(raw, resolveSafeImageUrl)
        : resolveSafeImageUrl(raw);
      if (resolved === null) {
        element.removeAttribute(attribute);
        if (isImage) element.setAttribute("data-nowen-attachment-pending", "true");
      } else {
        element.setAttribute(attribute, resolved);
        if (isImage) element.removeAttribute("data-nowen-attachment-pending");
      }
    }
  });

  if (options.fullDocument) {
    const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : "";
    return `${doctype}${doc.documentElement.outerHTML}`;
  }
  return doc.body.innerHTML;
}

type AssetUrlResolver = (src: string) => string;

type HtmlPreviewAssetOptions = {
  fullDocument?: boolean;
  /**
   * Do not issue unsigned /api/attachments/:id image requests before the
   * note-scoped signed URL map is ready. Never rewrite the stored HTML.
   */
  deferUnsignedAttachments?: boolean;
};

const ATTACHMENT_PATH = /^\/(?:api|publicapi)\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function needsAttachmentSignature(src: string): boolean {
  try {
    const url = new URL(src, "http://localhost/");
    if (!/^https?:$/.test(url.protocol) || !ATTACHMENT_PATH.test(url.pathname)) return false;
    if (url.searchParams.has("share")) return false;
    return !(
      url.searchParams.has("exp")
      && url.searchParams.has("sig")
      && url.searchParams.has("scope")
    );
  } catch {
    return false;
  }
}

export function resolveHtmlPreviewAssetUrls(
  html: string | null | undefined,
  resolveUrl: AssetUrlResolver,
  options: HtmlPreviewAssetOptions = {},
): string {
  if (!html || typeof DOMParser === "undefined") return html || "";

  const doc = new DOMParser().parseFromString(html, "text/html");
  const resolveSafeImageUrl = (raw: string): string | null => {
    const resolved = resolveUrl(raw);
    return options.deferUnsignedAttachments && needsAttachmentSignature(resolved) ? null : resolved;
  };

  doc.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
    const src = img.getAttribute("src");
    if (!src) return;
    const resolved = resolveSafeImageUrl(src);
    if (resolved === null) {
      // An <img> without src remains in the layout but cannot generate a 404.
      img.removeAttribute("src");
      img.setAttribute("data-nowen-attachment-pending", "true");
    } else {
      img.setAttribute("src", resolved);
      img.removeAttribute("data-nowen-attachment-pending");
    }
  });

  // srcset is also a network source. In particular a <picture><source> can
  // bypass an img's deferred src unless all attachment candidates are gated.
  doc.querySelectorAll<HTMLImageElement | HTMLSourceElement>("img[srcset],picture source[srcset]").forEach((element) => {
    const srcset = element.getAttribute("srcset");
    if (!srcset || !/\/(?:api|publicapi)\/attachments\//i.test(srcset)) return;
    const candidates = srcset.split(",").map((candidate) => {
      const match = candidate.trim().match(/^(\S+)(\s+.*)?$/);
      if (!match) return "";
      const resolved = resolveSafeImageUrl(match[1]);
      return resolved === null ? "" : resolved + (match[2] || "");
    }).filter(Boolean);
    if (candidates.length) element.setAttribute("srcset", candidates.join(", "));
    else element.removeAttribute("srcset");
  });

  if (options.fullDocument) {
    const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : "";
    return `${doctype}${doc.documentElement.outerHTML}`;
  }

  return doc.body.innerHTML;
}

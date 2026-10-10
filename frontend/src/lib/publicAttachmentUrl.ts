import {
  normalizePublicWebOrigin,
  resolvePublicWebOrigin,
} from "@/lib/publicWebOrigin";

export interface PublicAttachmentUrlOptions {
  filePublicOrigin?: string | null;
  publicWebOrigin?: string | null;
}

export interface PublicAttachmentOriginResolution {
  origin: string;
  source: "file" | "public-web" | "current";
}

export function resolvePublicAttachmentOrigin(
  options: PublicAttachmentUrlOptions = {},
): PublicAttachmentOriginResolution {
  const fileOrigin = normalizePublicWebOrigin(options.filePublicOrigin);
  if (fileOrigin) return { origin: fileOrigin, source: "file" };

  const publicWeb = resolvePublicWebOrigin({
    runtimeOrigin: options.publicWebOrigin,
  });
  // Explicit/runtime/build public origins are valid delivery origins. A "current" fallback is
  // deliberately not used here: the already-resolved attachment URL knows the actual API/LAN
  // server, while window.location may be a dev server or native WebView shell.
  if (publicWeb.origin && publicWeb.source !== "current" && publicWeb.source !== "relative") {
    return { origin: publicWeb.origin, source: "public-web" };
  }

  return { origin: "", source: "current" };
}

function joinPublicBasePath(basePathname: string, resourcePathname: string): string {
  const prefix = basePathname === "/" ? "" : basePathname.replace(/\/+$/, "");
  const resource = resourcePathname.startsWith("/") ? resourcePathname : `/${resourcePathname}`;
  if (!prefix) return resource;
  if (resource === prefix || resource.startsWith(`${prefix}/`)) return resource;
  return `${prefix}${resource}`;
}

/**
 * Rebase an already-resolved attachment URL onto the public file origin.
 *
 * The attachment signature intentionally excludes host/origin, so exp/sig/scope and all
 * thumbnail/download query parameters remain valid after this delivery-layer rebase.
 * When neither file nor public-web origin is configured the original URL is returned unchanged,
 * preserving LAN/native-server behavior.
 */
export function buildPublicAttachmentUrl(
  resolvedAttachmentUrl: string,
  options: PublicAttachmentUrlOptions = {},
): string {
  if (!resolvedAttachmentUrl) return "";

  const resolution = resolvePublicAttachmentOrigin(options);
  if (!resolution.origin) return resolvedAttachmentUrl;

  try {
    const source = new URL(
      resolvedAttachmentUrl,
      typeof window !== "undefined" ? window.location.origin : "https://nowen.invalid",
    );
    const publicBase = new URL(resolution.origin);
    const pathname = joinPublicBasePath(publicBase.pathname, source.pathname);
    return `${publicBase.origin}${pathname}${source.search}${source.hash}`;
  } catch {
    return resolvedAttachmentUrl;
  }
}

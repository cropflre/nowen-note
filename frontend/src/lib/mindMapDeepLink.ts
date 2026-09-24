import {
  buildAppPathUrl,
  pushAppPathState,
  replaceAppPathState,
  resolveCurrentAppPathname,
} from "@/lib/appPathNavigation";

const MINDMAP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MindMapAppRoute {
  matched: boolean;
  mindMapId: string | null;
}

export function isMindMapId(value: string | null | undefined): value is string {
  return typeof value === "string" && MINDMAP_ID_RE.test(value);
}

export function parseMindMapAppPath(pathname: string): MindMapAppRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/mindmaps") {
    return { matched: true, mindMapId: null };
  }

  const match = normalized.match(/^\/mindmaps\/([^/]+)$/i);
  if (!match) return { matched: false, mindMapId: null };

  let candidate = match[1];
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    return { matched: false, mindMapId: null };
  }

  if (!isMindMapId(candidate)) {
    return { matched: false, mindMapId: null };
  }
  return { matched: true, mindMapId: candidate };
}

export function getCurrentMindMapAppRoute(): MindMapAppRoute {
  return parseMindMapAppPath(resolveCurrentAppPathname());
}

export function buildMindMapAppPath(mindMapId?: string | null): string {
  return mindMapId && isMindMapId(mindMapId)
    ? `/mindmaps/${encodeURIComponent(mindMapId)}`
    : "/mindmaps";
}

export function pushMindMapAppPath(mindMapId?: string | null): void {
  pushAppPathState(buildMindMapAppPath(mindMapId));
}

export function replaceMindMapAppPath(mindMapId?: string | null): void {
  replaceAppPathState(buildMindMapAppPath(mindMapId));
}


export function buildMindMapDeepLinkUrl(
  mindMapId: string,
  currentHref: string = window.location.href,
): string {
  const appPath = buildMindMapAppPath(mindMapId);
  const routed = buildAppPathUrl(appPath, currentHref);
  return new URL(routed, currentHref).toString();
}

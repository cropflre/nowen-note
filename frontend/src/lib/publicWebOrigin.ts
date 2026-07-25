export type PublicWebOriginSource = "settings" | "environment" | "build" | "current" | "relative";
export type PublicWebOriginRisk = "none" | "verify" | "private-network" | "localhost" | "protected-gateway";

export interface PublicWebOriginOptions {
  runtimeOrigin?: string | null;
  runtimeSource?: string | null;
  currentOrigin?: string | null;
  buildOrigin?: string | null;
}

export interface PublicWebOriginResolution {
  origin: string;
  source: PublicWebOriginSource;
  usesCurrentOrigin: boolean;
  isLikelyProtectedGateway: boolean;
  requiresAnonymousCheck: boolean;
  risk: PublicWebOriginRisk;
}

let runtimePublicWebOrigin = "";
let runtimePublicWebOriginSource: string | null = null;

export function normalizePublicWebOrigin(value: string | null | undefined): string {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password || url.search || url.hash) return "";
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname === "/" ? "" : pathname}`;
  } catch {
    return "";
  }
}

/**
 * Keep the public settings response available to every link builder, including components that do
 * not consume SiteSettingsContext directly (for example notebook invitations/publications).
 */
export function setRuntimePublicWebOrigin(
  origin: string | null | undefined,
  source?: string | null,
): void {
  runtimePublicWebOrigin = normalizePublicWebOrigin(origin);
  runtimePublicWebOriginSource = source || null;
}

function getOriginHostname(value: string): string {
  const normalized = normalizePublicWebOrigin(value);
  if (!normalized) return "";
  try {
    return new URL(normalized).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

export function isLikelyProtectedGatewayOrigin(value: string): boolean {
  const hostname = getOriginHostname(value);
  return hostname === "fnos.net" || hostname.endsWith(".fnos.net") || hostname.includes("fnconnect");
}

export function isLoopbackOrigin(value: string): boolean {
  const hostname = getOriginHostname(value);
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1") return true;
  const parts = hostname.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 127;
}

export function isPrivateNetworkOrigin(value: string): boolean {
  const hostname = getOriginHostname(value);
  if (!hostname || isLoopbackOrigin(value)) return false;

  const isIpv6 = hostname.includes(":");
  if (
    hostname.endsWith(".local") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".internal") ||
    (isIpv6 && (hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")))
  ) {
    return true;
  }

  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return false;
  }

  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254);
}

function classifyPublicWebOriginRisk(origin: string, verifyFallback: boolean): PublicWebOriginRisk {
  if (isLikelyProtectedGatewayOrigin(origin)) return "protected-gateway";
  if (isLoopbackOrigin(origin)) return "localhost";
  if (isPrivateNetworkOrigin(origin)) return "private-network";
  return verifyFallback ? "verify" : "none";
}

function normalizeRuntimeSource(value: string | null | undefined): PublicWebOriginSource {
  if (value === "environment") return "environment";
  if (value === "settings") return "settings";
  return "settings";
}

function buildResolution(
  origin: string,
  source: PublicWebOriginSource,
  usesCurrentOrigin: boolean,
  verifyFallback: boolean,
): PublicWebOriginResolution {
  const risk = classifyPublicWebOriginRisk(origin, verifyFallback);
  return {
    origin,
    source,
    usesCurrentOrigin,
    isLikelyProtectedGateway: risk === "protected-gateway",
    requiresAnonymousCheck: risk !== "none",
    risk,
  };
}

/**
 * Public SPA origin is independent from the API server origin.
 *
 * Priority:
 *   runtime administrator/environment setting -> Vite build variable -> current browser origin.
 */
export function resolvePublicWebOrigin(options: PublicWebOriginOptions = {}): PublicWebOriginResolution {
  const runtimeInput = options.runtimeOrigin !== undefined
    ? options.runtimeOrigin
    : runtimePublicWebOrigin;
  const runtimeSourceInput = options.runtimeSource !== undefined
    ? options.runtimeSource
    : runtimePublicWebOriginSource;
  const runtime = normalizePublicWebOrigin(runtimeInput);
  if (runtime) {
    return buildResolution(runtime, normalizeRuntimeSource(runtimeSourceInput), false, false);
  }

  const build = normalizePublicWebOrigin(
    options.buildOrigin ??
      import.meta.env.VITE_PUBLIC_WEB_ORIGIN ??
      import.meta.env.VITE_APP_PUBLIC_URL,
  );
  if (build) {
    return buildResolution(build, "build", false, false);
  }

  const current = normalizePublicWebOrigin(
    options.currentOrigin ??
      (typeof window !== "undefined" ? window.location.origin : ""),
  );
  if (current) {
    // A current-origin fallback may be an intranet, VPN or authenticated gateway even when the
    // hostname is not recognizable. The creator's logged-in browser cannot prove anonymity.
    return buildResolution(current, "current", true, true);
  }

  return buildResolution("", "relative", false, true);
}

export function getPublicWebOrigin(options: PublicWebOriginOptions = {}): string {
  return resolvePublicWebOrigin(options).origin;
}

export function buildPublicWebUrl(
  pathname: string,
  options: PublicWebOriginOptions = {},
): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const origin = getPublicWebOrigin(options);
  return origin ? `${origin}${path}` : path;
}

export function getPublicWebOriginSourceLabel(source: PublicWebOriginSource): string {
  switch (source) {
    case "settings":
      return "管理员设置";
    case "environment":
      return "容器环境变量";
    case "build":
      return "前端构建配置";
    case "current":
      return "当前访问域名";
    default:
      return "相对地址";
  }
}

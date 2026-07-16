export type PublicWebOriginSource = "settings" | "environment" | "build" | "current" | "relative";

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

export function isLikelyProtectedGatewayOrigin(value: string): boolean {
  const normalized = normalizePublicWebOrigin(value);
  if (!normalized) return false;
  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    return hostname === "fnos.net" || hostname.endsWith(".fnos.net") || hostname.includes("fnconnect");
  } catch {
    return false;
  }
}

function normalizeRuntimeSource(value: string | null | undefined): PublicWebOriginSource {
  if (value === "environment") return "environment";
  if (value === "settings") return "settings";
  return "settings";
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
    const source = normalizeRuntimeSource(runtimeSourceInput);
    const protectedGateway = isLikelyProtectedGatewayOrigin(runtime);
    return {
      origin: runtime,
      source,
      usesCurrentOrigin: false,
      isLikelyProtectedGateway: protectedGateway,
      requiresAnonymousCheck: protectedGateway,
    };
  }

  const build = normalizePublicWebOrigin(
    options.buildOrigin ??
      import.meta.env.VITE_PUBLIC_WEB_ORIGIN ??
      import.meta.env.VITE_APP_PUBLIC_URL,
  );
  if (build) {
    const protectedGateway = isLikelyProtectedGatewayOrigin(build);
    return {
      origin: build,
      source: "build",
      usesCurrentOrigin: false,
      isLikelyProtectedGateway: protectedGateway,
      requiresAnonymousCheck: protectedGateway,
    };
  }

  const current = normalizePublicWebOrigin(
    options.currentOrigin ??
      (typeof window !== "undefined" ? window.location.origin : ""),
  );
  if (current) {
    return {
      origin: current,
      source: "current",
      usesCurrentOrigin: true,
      isLikelyProtectedGateway: isLikelyProtectedGatewayOrigin(current),
      // A current-origin fallback may be an intranet, VPN or authenticated gateway even when the
      // hostname is not recognizable. The creator's logged-in browser cannot prove anonymity.
      requiresAnonymousCheck: true,
    };
  }

  return {
    origin: "",
    source: "relative",
    usesCurrentOrigin: false,
    isLikelyProtectedGateway: false,
    requiresAnonymousCheck: true,
  };
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

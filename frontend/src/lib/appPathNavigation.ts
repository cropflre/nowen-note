import { inferBrowserServerBaseUrl, stripServerBasePath } from "./serverUrl";

const FILE_ROUTE_QUERY_KEY = "nowenAppPath";

export const APP_PATH_CHANGED_EVENT = "nowen:app-path-changed";

function normalizeAppPath(rawPath: string): string {
  const value = String(rawPath || "/").trim();
  if (!value || value === "/") return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

function isNativeCapacitorRuntime(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Boolean((window as any).Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

export function buildAppPathUrl(
  appPath: string,
  currentHref: string = window.location.href,
  nativeCapacitor: boolean = isNativeCapacitorRuntime(),
): string {
  const normalizedPath = normalizeAppPath(appPath);
  const currentUrl = new URL(currentHref);

  if (currentUrl.protocol !== "file:" && !nativeCapacitor) {
    const currentIssuePath = /\/issues(?:\/[A-Za-z0-9-]+)?\/?$/.test(currentUrl.pathname);
    if (/^\/issues(?:\/[A-Za-z0-9-]+)?\/?$/.test(normalizedPath) || (currentIssuePath && normalizedPath === "/")) {
      // 议题导航保留部署前缀，已有模块路径不能被误认为反向代理目录。
      const pathname = currentUrl.pathname.replace(/\/(?:mindmaps|sheets)(?:\/[A-Za-z0-9-]+)?\/?$/, "");
      const serverBase = inferBrowserServerBaseUrl({ protocol: currentUrl.protocol, origin: currentUrl.origin, pathname });
      const prefix = serverBase ? new URL(serverBase).pathname.replace(/\/+$/, "") : "";
      return `${prefix}${normalizedPath}`;
    }
    return normalizedPath;
  }

  if (normalizedPath === "/") {
    currentUrl.searchParams.delete(FILE_ROUTE_QUERY_KEY);
  } else {
    currentUrl.searchParams.set(FILE_ROUTE_QUERY_KEY, normalizedPath);
  }
  currentUrl.hash = "";
  return currentUrl.toString();
}

export function navigateToAppPath(appPath: string): void {
  window.location.assign(buildAppPathUrl(appPath));
}

export function resolveCurrentAppPathname(
  currentHref: string = window.location.href,
  nativeCapacitor: boolean = isNativeCapacitorRuntime(),
): string {
  const currentUrl = new URL(currentHref);
  if (currentUrl.protocol !== "file:" && !nativeCapacitor) {
    if (/\/issues(?:\/[A-Za-z0-9-]+)?\/?$/.test(currentUrl.pathname)) {
      return stripServerBasePath(currentUrl.pathname, inferBrowserServerBaseUrl(currentUrl));
    }
    return currentUrl.pathname;
  }

  const appPath = currentUrl.searchParams.get(FILE_ROUTE_QUERY_KEY);
  if (!appPath) {
    return currentUrl.protocol === "file:" ? "/" : currentUrl.pathname;
  }

  try {
    return new URL(normalizeAppPath(appPath), "https://nowen.local").pathname;
  } catch {
    return "/";
  }
}


export interface AppPathChangedDetail {
  appPath: string;
  replace: boolean;
}

/**
 * SPA 内部导航：不刷新页面，同时兼容 Web、Electron file:// 和 Capacitor。
 * Public route 仍可继续使用 navigateToAppPath() 做完整重载；应用内部模块路由
 * 使用本方法，避免丢失正在运行的本地状态。
 */
function commitAppPathState(appPath: string, replace: boolean): void {
  const normalizedPath = normalizeAppPath(appPath);
  const nextUrl = buildAppPathUrl(normalizedPath);
  const currentPath = resolveCurrentAppPathname();

  if (currentPath === normalizedPath) return;

  if (replace) {
    window.history.replaceState(window.history.state, "", nextUrl);
  } else {
    window.history.pushState(window.history.state, "", nextUrl);
  }

  window.dispatchEvent(new CustomEvent<AppPathChangedDetail>(APP_PATH_CHANGED_EVENT, {
    detail: { appPath: normalizedPath, replace },
  }));
}

export function pushAppPathState(appPath: string): void {
  commitAppPathState(appPath, false);
}

export function replaceAppPathState(appPath: string): void {
  commitAppPathState(appPath, true);
}

const FILE_ROUTE_QUERY_KEY = "nowenAppPath";

function normalizeAppPath(rawPath: string): string {
  const value = String(rawPath || "/").trim();
  if (!value || value === "/") return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

export function buildAppPathUrl(
  appPath: string,
  currentHref: string = window.location.href,
): string {
  const normalizedPath = normalizeAppPath(appPath);
  const currentUrl = new URL(currentHref);

  if (currentUrl.protocol !== "file:") {
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
): string {
  const currentUrl = new URL(currentHref);
  if (currentUrl.protocol !== "file:") {
    return currentUrl.pathname;
  }

  const appPath = currentUrl.searchParams.get(FILE_ROUTE_QUERY_KEY);
  if (!appPath) return "/";

  try {
    return new URL(normalizeAppPath(appPath), "https://nowen.local").pathname;
  } catch {
    return "/";
  }
}

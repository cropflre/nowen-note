import type { MiddlewareHandler } from "hono";

export type HttpRequestLogMode = "errors" | "all" | "off";

export function resolveHttpRequestLogMode(value: string | undefined): HttpRequestLogMode {
  return value === "all" || value === "off" ? value : "errors";
}

/**
 * Route templates provide useful diagnostics without logging query strings,
 * signed attachment URLs, shared tokens, or untrusted path segments.
 */
export function safeRequestRoute(routePath: string): string {
  const pathname = routePath.split("?")[0]
    .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?=\/|$)/gi, "/:id")
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, "/:id");
  return pathname.length > 0 && pathname.length <= 200 && /^\/[A-Za-z0-9_/:.*-]*$/.test(pathname)
    ? pathname
    : "/[redacted]";
}

/**
 * By default, suppress 2xx and 3xx access logs. Keep 4xx/5xx with requestId
 * and duration. Uncaught exceptions already emit a redacted record in
 * handleUnhandledRequestError; never duplicate those records.
 */
export const requestLogMiddleware: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();

  const mode = resolveHttpRequestLogMode(process.env.HTTP_REQUEST_LOG);
  if (mode === "off" || c.get("requestExceptionLogged")) return;
  const status = c.res.status;
  if (mode !== "all" && status < 400) return;

  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO",
    event: status >= 400 ? "http.request.failed" : "http.request.completed",
    module: "http",
    requestId: c.get("requestId"),
    method: c.req.method,
    route: safeRequestRoute(c.req.routePath),
    httpStatus: status,
    durationMs: Math.round(performance.now() - start),
  });
  if (status >= 500) console.error(record);
  else if (status >= 400) console.warn(record);
  else console.info(record);
};

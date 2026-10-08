import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { safeErrorLog, toPublicApiError } from "../lib/app-error";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Accept well-formed upstream correlation IDs (e.g. reverse proxies and
 * internal app.fetch rewrites). Never treat these IDs as authentication.
 */
export const requestErrorTracing: MiddlewareHandler = async (c, next) => {
  const incomingId = c.req.header("X-Request-Id");
  const requestId = incomingId && REQUEST_ID_PATTERN.test(incomingId)
    ? incomingId
    : randomUUID();
  c.set("requestId", requestId);
  // Set before downstream execution so all normal and error responses have it.
  c.header("X-Request-Id", requestId);
  await next();
  c.header("X-Request-Id", requestId);
};

export function handleUnhandledRequestError(error: Error, c: Context): Response {
  const requestId = c.get("requestId") || randomUUID();
  const { payload, status } = toPublicApiError(error, requestId);
  console.error(safeErrorLog(error, requestId, status, payload.code));
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
}

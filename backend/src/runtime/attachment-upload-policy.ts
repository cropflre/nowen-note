import { Hono } from "hono";
import type { Context } from "hono";

const ROUTE_PATCH_FLAG = Symbol.for("nowen.attachmentUploadPolicy.routePatch");
const APP_INSTALLED_FLAG = Symbol.for("nowen.attachmentUploadPolicy.appInstalled");
const globals = globalThis as typeof globalThis & Record<symbol, boolean>;

export const DEFAULT_MAX_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_CONFIGURABLE_ATTACHMENT_SIZE_BYTES = 10_240 * 1024 * 1024;

/**
 * Keep this parser aligned with the legacy attachments-core guard. The runtime policy endpoint
 * exposes the effective server value so clients no longer guess a separate 1 GB limit.
 */
export function getConfiguredMaxAttachmentSizeBytes(envValue = process.env.MAX_ATTACHMENT_SIZE_MB): number {
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10_240) {
      return parsed * 1024 * 1024;
    }
  }
  return DEFAULT_MAX_ATTACHMENT_SIZE_BYTES;
}

function safeUploadSizeHint(c: Context): number | null {
  const raw = c.req.query("__uploadSize");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function attachmentTooLargePayload(maxSizeBytes: number, actualSizeBytes?: number | null) {
  const maxMiB = Math.round(maxSizeBytes / 1024 / 1024);
  return {
    code: "ATTACHMENT_TOO_LARGE",
    maxSizeBytes,
    ...(typeof actualSizeBytes === "number" ? { actualSizeBytes } : {}),
    error: `文件大小超过服务器允许的 ${maxMiB} MiB`,
  };
}

/**
 * Install one product-level attachment upload contract around the legacy attachment router:
 * - GET /api/attachment-upload-policy exposes the effective max size;
 * - legacy 413 responses are normalized to ATTACHMENT_TOO_LARGE without changing core storage;
 * - __uploadSize is only an informational client hint for error metadata. The core route remains
 *   authoritative and still enforces File.size server-side.
 */
export function installAttachmentUploadPolicy(app: Hono<any>): void {
  const tagged = app as Hono<any> & Record<symbol, boolean>;
  if (tagged[APP_INSTALLED_FLAG]) return;
  tagged[APP_INSTALLED_FLAG] = true;

  app.get("/api/attachment-upload-policy", (c) => {
    const maxAttachmentSizeBytes = getConfiguredMaxAttachmentSizeBytes();
    c.header("Cache-Control", "private, no-store");
    return c.json({
      maxAttachmentSizeBytes,
      maxAttachmentSizeMiB: maxAttachmentSizeBytes / 1024 / 1024,
    });
  });

  // Registered immediately before /api/attachments is mounted, so this wrapper observes every
  // upload response while leaving downloads and all successful attachment responses untouched.
  app.use("/api/attachments", async (c, next) => {
    await next();
    if (c.req.method !== "POST" || c.res.status !== 413) return;

    const maxAttachmentSizeBytes = getConfiguredMaxAttachmentSizeBytes();
    const payload = attachmentTooLargePayload(maxAttachmentSizeBytes, safeUploadSizeHint(c));
    const headers = new Headers(c.res.headers);
    headers.set("Content-Type", "application/json; charset=UTF-8");
    headers.set("Cache-Control", "private, no-store");
    c.res = new Response(JSON.stringify(payload), {
      status: 413,
      statusText: c.res.statusText,
      headers,
    });
  });
}

if (!globals[ROUTE_PATCH_FLAG]) {
  globals[ROUTE_PATCH_FLAG] = true;
  const prototype = Hono.prototype as any;
  const nativeRoute = prototype.route as (this: Hono<any>, path: string, subApp: Hono<any>) => Hono<any>;
  prototype.route = function patchedRoute(this: Hono<any>, path: string, subApp: Hono<any>) {
    if (path === "/api/attachments") installAttachmentUploadPolicy(this);
    return nativeRoute.call(this, path, subApp);
  };
}

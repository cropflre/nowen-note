import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";

import {
  createStaticAssetHeaders,
  isStaticAssetNotModified,
  mergeVaryHeader,
  selectStaticContentEncoding,
} from "../lib/static-asset-response.js";

const INSTALL_KEY = "__nowenStaticPrecompressedAssetsInstalled__" as const;
const APP_MIDDLEWARE_KEY = Symbol.for("nowen.staticPrecompressedAssets.appMiddleware");

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".json": "application/json",
  ".mjs": "application/javascript",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
};

function frontendRoot(): string {
  return path.resolve(
    process.env.FRONTEND_DIST || path.resolve(process.cwd(), "frontend/dist"),
  );
}

/**
 * Keep the legacy static path compatibility: desktop and reverse-proxy deployments may prepend
 * one or more path segments before /assets. Only explicit files are handled here; document routes
 * continue through the original SPA handler so web_ui_enabled and CSP behavior stay unchanged.
 */
export function resolvePrecompressedSourcePath(requestPath: string): string | null {
  if (path.extname(requestPath) === "") return null;

  const root = frontendRoot();
  const normalizedPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  const candidates = [normalizedPath];
  const parts = normalizedPath.split("/").filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) {
    candidates.push(`/${parts.slice(index).join("/")}`);
  }

  for (const candidate of candidates) {
    const filePath = path.resolve(root, `.${candidate}`);
    if (filePath === root || !filePath.startsWith(root + path.sep)) continue;
    if (!MIME_TYPES[path.extname(filePath).toLowerCase()]) continue;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
  }
  return null;
}

async function tryServePrecompressedAsset(c: any): Promise<Response | null> {
  const sourcePath = resolvePrecompressedSourcePath(c.req.path);
  if (!sourcePath) return null;

  const brPath = `${sourcePath}.br`;
  const gzipPath = `${sourcePath}.gz`;
  const encoding = selectStaticContentEncoding(c.req.header("accept-encoding"), {
    br: fs.existsSync(brPath),
    gzip: fs.existsSync(gzipPath),
  });
  if (!encoding) return null;

  const representationPath = encoding === "br" ? brPath : gzipPath;
  const stat = await fs.promises.stat(representationPath);
  const headers = createStaticAssetHeaders(c.req.path, sourcePath, stat);
  // ETags identify the selected representation, not only the source filename.
  headers.ETag = headers.ETag.replace(/"$/, `-${encoding}"`);

  for (const [name, value] of Object.entries(headers)) c.header(name, value);
  c.header("Content-Encoding", encoding);
  c.header("Vary", mergeVaryHeader(c.res?.headers?.get?.("Vary"), "Accept-Encoding"));

  if (isStaticAssetNotModified(c.req.raw.headers, headers)) {
    return c.body(null, 304);
  }

  const contentType = MIME_TYPES[path.extname(sourcePath).toLowerCase()];
  const content = await fs.promises.readFile(representationPath);
  return c.body(content, 200, { "Content-Type": contentType });
}

async function precompressedAssetMiddleware(c: any, next: () => Promise<void>) {
  if (
    process.env.NODE_ENV === "production"
    && !c.req.path.startsWith("/api")
    && (c.req.method === "GET" || c.req.method === "HEAD")
  ) {
    const response = await tryServePrecompressedAsset(c);
    if (response) return response;
  }
  await next();
}

/**
 * Register after Hono's generic compression middleware but before the final SPA wildcard route.
 * The generic middleware wraps downstream responses and skips transformation when this handler
 * has already supplied Content-Encoding, so a .br representation cannot be gzip-compressed again.
 */
export function installPrecompressedAssetMiddleware(app: Hono<any>): void {
  const runtimeApp = app as any;
  if (runtimeApp[APP_MIDDLEWARE_KEY]) return;
  runtimeApp[APP_MIDDLEWARE_KEY] = true;
  runtimeApp.use("*", precompressedAssetMiddleware);
}

export function installStaticPrecompressedAssetRuntime(): void {
  const globalState = globalThis as typeof globalThis & {
    __nowenStaticPrecompressedAssetsInstalled__?: boolean;
  };
  if (globalState[INSTALL_KEY]) return;
  globalState[INSTALL_KEY] = true;

  // `get` and `use` are created per Hono instance, but `route` is a prototype method. The main app
  // mounts its first API router immediately after compression setup, which gives us a stable point
  // to insert this middleware without changing the large legacy index module.
  const prototype = Hono.prototype as any;
  const originalRoute = prototype.route;
  prototype.route = function patchedRoute(...args: any[]) {
    installPrecompressedAssetMiddleware(this);
    return originalRoute.apply(this, args);
  };
}

installStaticPrecompressedAssetRuntime();

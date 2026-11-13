import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getDb } from "./db/schema";
import { looksLikeApiToken, resolveApiToken } from "./lib/api-tokens";
import { isSystemAdmin } from "./middleware/acl";
import { systemSettingsRepository } from "./repositories";

const entry = path.resolve(__dirname, "../../packages/nowen-mcp/dist/embedded-http.js");
const settingKey = "mcp_server_config";
interface McpSettings { enabled: boolean; allowWrite: boolean; publicUrl: string }
const defaults: McpSettings = { enabled: false, allowWrite: false, publicUrl: "" };

function readSettings(): McpSettings {
  const raw = systemSettingsRepository.get(settingKey)?.value;
  if (!raw) return { ...defaults };
  const value = JSON.parse(raw) as McpSettings;
  return { enabled: value.enabled === true, allowWrite: value.allowWrite === true, publicUrl: value.publicUrl || "" };
}

function validPublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname.endsWith("/mcp");
  } catch { return false; }
}

export function createMcpSettingsRouter(): Hono {
  const router = new Hono();
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!c.req.header("X-User-Id") || c.req.header("X-Auth-Mode") === "api-token") {
      return c.json({ error: "MCP 服务设置需要登录会话", code: "FORBIDDEN" }, 403);
    }
    await next();
  });
  const status = (userId: string) => ({ ...readSettings(), available: existsSync(entry), canManage: isSystemAdmin(userId) });
  router.get("/", c => c.json(status(c.req.header("X-User-Id") || "")));
  router.put("/", bodyLimit({ maxSize: 4096 }), async c => {
    const userId = c.req.header("X-User-Id") || "";
    if (!isSystemAdmin(userId)) return c.json({ error: "仅管理员可启停 MCP 服务", code: "FORBIDDEN" }, 403);
    let body;
    try { body = await c.req.json(); }
    catch (error) {
      if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "MCP_REQUEST_TOO_LARGE" }, 413);
      return c.json({ error: "INVALID_JSON" }, 400);
    }
    if (!body || typeof body.enabled !== "boolean" || typeof body.allowWrite !== "boolean"
        || typeof body.publicUrl !== "string" || body.publicUrl.length > 2048
        || (body.enabled || body.publicUrl) && !validPublicUrl(body.publicUrl)) {
      return c.json({ error: "请提供有效的 MCP 开关、写入开关与 HTTP(S) /mcp 地址", code: "INVALID_MCP_SETTINGS" }, 400);
    }
    if (body.enabled && !existsSync(entry)) {
      return c.json({ error: "当前安装未包含内置 MCP，请使用支持此功能的官方 Docker 镜像", code: "MCP_UNAVAILABLE" }, 409);
    }
    systemSettingsRepository.set(settingKey, JSON.stringify({
      enabled: body.enabled, allowWrite: body.allowWrite, publicUrl: body.publicUrl,
    }));
    return c.json(status(userId));
  });
  return router;
}

type Dispatch = (request: Request) => Response | Promise<Response>;
type EmbeddedHandler = (request: Request, options: {
  apiToken: string; fetch: typeof globalThis.fetch; allowWrite: boolean; restricted: boolean; parsedBody: unknown;
}) => Promise<Response>;
// Preserve native ESM import when the backend is compiled/bundled to CommonJS.
const importEsm = new Function("url", "return import(url)") as (url: string) => Promise<{ handleEmbeddedMcp: EmbeddedHandler }>;
let modulePromise: ReturnType<typeof importEsm> | undefined;

/** Mounted outside /api: PAT authentication is mandatory even for initialize. */
export function createEmbeddedMcpRouter(dispatch: Dispatch): Hono {
  const router = new Hono();
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    const settings = readSettings();
    if (!settings.enabled) return c.json({ error: "MCP_DISABLED" }, 404);
    if (!existsSync(entry)) return c.json({ error: "MCP_UNAVAILABLE" }, 503);
    const url = new URL(c.req.url);
    const publicUrl = new URL(settings.publicUrl);
    const actualHost = (c.req.header("Host") || url.host).toLowerCase();
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && actualHost === url.host;
    if (!localHost && actualHost !== publicUrl.host) return c.json({ error: "INVALID_HOST" }, 403);
    const origin = c.req.header("Origin");
    if (origin && origin !== publicUrl.origin && !(localHost && origin === url.origin)) {
      return c.json({ error: "INVALID_ORIGIN" }, 403);
    }
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    }
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
      return c.body(null, 204);
    }
    const bearer = c.req.header("Authorization")?.match(/^Bearer (nkn_\S+)$/)?.[1] || "";
    const db = getDb();
    const identity = looksLikeApiToken(bearer) ? resolveApiToken(db, bearer) : null;
    const user = identity && db.prepare("SELECT isDisabled FROM users WHERE id = ?").get(identity.userId) as { isDisabled: number } | undefined;
    if (!identity || !user || user.isDisabled) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ error: "API_TOKEN_INVALID" }, 401);
    }
    // Request-local context; never put credentials into process.env or logs.
    c.set("mcpIdentity" as never, { bearer, restricted: identity.resourceMode === "restricted", allowWrite: settings.allowWrite } as never);
    await next();
  });
  router.use("*", bodyLimit({ maxSize: 1_048_576, onError: c => c.json({ error: "MCP_REQUEST_TOO_LARGE" }, 413) }));
  router.all("/", async c => {
    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return c.json({ error: "METHOD_NOT_ALLOWED" }, 405);
    }
    if (!(c.req.header("Content-Type") || "").toLowerCase().startsWith("application/json")) {
      return c.json({ error: "CONTENT_TYPE_REQUIRED" }, 415);
    }
    let parsedBody: unknown;
    try { parsedBody = await c.req.json(); }
    catch (error) {
      const tooLarge = error instanceof Error && error.name === "BodyLimitError";
      return c.json({ error: tooLarge ? "MCP_REQUEST_TOO_LARGE" : "INVALID_JSON" }, tooLarge ? 413 : 400);
    }
    const identity = c.get("mcpIdentity" as never) as { bearer: string; restricted: boolean; allowWrite: boolean };
    const scopedFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const current = readSettings();
      if (!current.enabled) return Response.json({ error: "MCP_DISABLED" }, { status: 403 });
      if (url.origin !== "http://localhost" || !url.pathname.startsWith("/api/")) {
        return Response.json({ error: "MCP_API_TARGET_DENIED" }, { status: 403 });
      }
      if ((!identity.allowWrite || !current.allowWrite) && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        return Response.json({ error: "MCP_READ_ONLY" }, { status: 403 });
      }
      // Build fresh headers; the REST middleware revalidates this PAT and its
      // current scopes/grants on EVERY call, including calls within one tool.
      const headers = new Headers({ Authorization: `Bearer ${identity.bearer}` });
      if (request.headers.has("Content-Type")) headers.set("Content-Type", request.headers.get("Content-Type")!);
      return dispatch(new Request(request, { headers }));
    };
    try {
      modulePromise ??= importEsm(pathToFileURL(entry).href).catch(error => { modulePromise = undefined; throw error; });
      const { handleEmbeddedMcp } = await modulePromise;
      return await handleEmbeddedMcp(c.req.raw, { apiToken: identity.bearer, fetch: scopedFetch,
        allowWrite: identity.allowWrite, restricted: identity.restricted, parsedBody });
    } catch {
      // Never include request bodies, credentials or raw upstream errors.
      return c.json({ error: "MCP_REQUEST_FAILED" }, 500);
    }
  });
  return router;
}

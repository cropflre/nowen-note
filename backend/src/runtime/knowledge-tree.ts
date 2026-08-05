import { Hono, type Context } from "hono";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { ensureMindmapSchema } from "../lib/mindmap-schema.js";
import {
  enforceKnowledgeNoteCapabilities,
  enforceKnowledgeNotebookCapabilities,
} from "../middleware/knowledgeCapabilityGuard.js";
import { enforceKnowledgeSearchVisibility } from "../middleware/knowledgeSearchCapabilityGuard.js";
import { enforceKnowledgeOfflineSyncVisibility } from "../middleware/knowledgeOfflineSyncCapabilityGuard.js";
import { enforceKnowledgeFilesVisibility } from "../middleware/knowledgeFilesCapabilityGuard.js";
import {
  enforceKnowledgeExportCapabilities,
  enforceKnowledgeTagCapabilities,
} from "../middleware/knowledgeExportTagCapabilityGuard.js";
import { enforceKnowledgePermissionPolicies } from "../middleware/knowledgePermissionPolicyGuard.js";
import knowledgeTreeRouter from "../routes/knowledge-tree.js";
import notebooksRouter from "../routes/notebooks.js";
import notesRouter from "../routes/notes.js";
import offlineSyncRouter from "../routes/offline-sync.js";
import tagsRouter from "../routes/tags.js";
import searchRouter from "../routes/search.js";
import exportRouter from "../routes/export.js";
import filesRouter from "../routes/files.js";

const INSTALL_KEY = Symbol.for("nowen.knowledgeTree.runtimeInstalled");
const GUARDED_PATHS_KEY = Symbol.for("nowen.knowledgeTree.guardedPaths");
const globals = globalThis as typeof globalThis & Record<symbol, boolean>;
const MAX_OFFLINE_COMPACTION_PAGES = 200;

type RouterLike = Hono<any> & Record<PropertyKey, any>;
type KnowledgeMiddleware = (c: any, next: any) => any;

const db = getDb();
ensureKnowledgeTreeTables(db);
ensureMindmapSchema(db);
const filesObject = db.prepare("SELECT type FROM sqlite_master WHERE name = 'files'").get() as { type: string } | undefined;
if (!filesObject) {
  db.exec("CREATE VIEW files AS SELECT id, filename FROM attachments");
}

function normalizedRoutePath(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  return normalized || "/";
}

function guardedPaths(router: RouterLike): Set<string> {
  if (!router[GUARDED_PATHS_KEY]) {
    Object.defineProperty(router, GUARDED_PATHS_KEY, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: new Set<string>(),
    });
  }
  return router[GUARDED_PATHS_KEY] as Set<string>;
}

function middlewareForPath(path: string): KnowledgeMiddleware | null {
  switch (normalizedRoutePath(path)) {
    case "/api/knowledge-tree":
      return enforceKnowledgePermissionPolicies;
    case "/api/notes":
      return enforceKnowledgeNoteCapabilities;
    case "/api/notebooks":
      return enforceKnowledgeNotebookCapabilities;
    case "/api/search":
      return enforceKnowledgeSearchVisibility;
    case "/api/files":
      return enforceKnowledgeFilesVisibility;
    case "/api/export":
      return enforceKnowledgeExportCapabilities;
    case "/api/tags":
      return enforceKnowledgeTagCapabilities;
    default:
      return null;
  }
}

function cloneHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.set("cache-control", "private, no-store");
  return headers;
}

function requestedLimit(c: Context): number {
  const value = Number(c.req.query("limit") || 50);
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

function internalOfflinePath(path: string): "/snapshot" | "/changes" | null {
  if (path.endsWith("/snapshot")) return "/snapshot";
  if (path.endsWith("/changes")) return "/changes";
  return null;
}

function createOfflineSyncWrapper(subApp: Hono<any>): Hono<any> {
  const guarded = new Hono<any>();
  guarded.use("*", enforceKnowledgeOfflineSyncVisibility);
  guarded.route("/", subApp);

  const wrapper = new Hono<any>();
  wrapper.use("*", async (c, next) => {
    const path = internalOfflinePath(c.req.path);
    const workspaceId = (c.req.query("workspaceId") || "").trim();
    if (
      c.req.method.toUpperCase() !== "GET"
      || !path
      || !workspaceId
      || workspaceId === "personal"
    ) {
      await next();
      return;
    }

    const limit = requestedLimit(c);
    const items: any[] = [];
    let position = path === "/snapshot"
      ? (c.req.query("cursor") || "")
      : String(Math.max(0, Number(c.req.query("after") || 0) || 0));
    let lastPayload: any = null;
    let lastResponse: Response | null = null;

    for (let page = 0; page < MAX_OFFLINE_COMPACTION_PAGES && items.length < limit; page += 1) {
      const url = new URL(c.req.url);
      url.pathname = path;
      url.searchParams.set("limit", String(limit - items.length));
      if (path === "/snapshot") url.searchParams.set("cursor", position);
      else url.searchParams.set("after", position);

      const response = await guarded.request(new Request(url.toString(), {
        method: "GET",
        headers: new Headers(c.req.raw.headers),
      }));
      lastResponse = response;
      if (!response.ok) return response;

      const payload = await response.json() as any;
      lastPayload = payload;
      if (Array.isArray(payload.items)) items.push(...payload.items);

      const nextPosition = path === "/snapshot"
        ? payload.nextCursor
        : payload.nextSequence;
      if (!payload.hasMore || nextPosition === null || nextPosition === undefined) break;
      const normalizedNext = String(nextPosition);
      if (normalizedNext === position) break;
      position = normalizedNext;
    }

    if (!lastPayload || !lastResponse) {
      await next();
      return;
    }

    return new Response(JSON.stringify({ ...lastPayload, items }), {
      status: lastResponse.status,
      statusText: lastResponse.statusText,
      headers: cloneHeaders(lastResponse),
    });
  });
  wrapper.route("/", guarded);
  guardedPaths(wrapper as RouterLike).add("/api/offline-sync");
  return wrapper;
}

export function wrapKnowledgeRoute(path: string, subApp: Hono<any>): Hono<any> {
  const normalized = normalizedRoutePath(path);
  const target = subApp as RouterLike;
  if (guardedPaths(target).has(normalized)) return subApp;

  if (normalized === "/api/offline-sync") {
    return createOfflineSyncWrapper(subApp);
  }

  const middleware = middlewareForPath(normalized);
  if (!middleware) return subApp;

  const wrapper = new Hono<any>();
  wrapper.use("*", middleware);
  wrapper.route("/", subApp);
  guardedPaths(wrapper as RouterLike).add(normalized);
  return wrapper;
}

function installCanonicalGuard(path: string, router: Hono<any>): void {
  const normalized = normalizedRoutePath(path);
  const target = router as RouterLike;
  if (guardedPaths(target).has(normalized)) return;
  const wrapped = wrapKnowledgeRoute(normalized, router) as RouterLike;
  if (wrapped === target) return;

  const targetRoutes = target.routes as any[];
  const wrappedRoutes = wrapped.routes as any[];
  targetRoutes.splice(0, targetRoutes.length, ...wrappedRoutes);
  guardedPaths(target).add(normalized);
}

if (!globals[INSTALL_KEY]) {
  globals[INSTALL_KEY] = true;
  installCanonicalGuard("/api/knowledge-tree", knowledgeTreeRouter);
  installCanonicalGuard("/api/notebooks", notebooksRouter);
  installCanonicalGuard("/api/notes", notesRouter);
  installCanonicalGuard("/api/offline-sync", offlineSyncRouter);
  installCanonicalGuard("/api/tags", tagsRouter);
  installCanonicalGuard("/api/search", searchRouter);
  installCanonicalGuard("/api/export", exportRouter);
  installCanonicalGuard("/api/files", filesRouter);
}

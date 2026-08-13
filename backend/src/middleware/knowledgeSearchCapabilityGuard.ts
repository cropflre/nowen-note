import type { Context, Next } from "hono";

import { getDb } from "../db/schema.js";
import {
  canViewNoteThroughFolderPasswords,
  resolveUnlockedFolderNodeIds,
} from "../lib/knowledgeTreePasswordAccess.js";
import {
  hasKnowledgeCapability,
  resolveResourceKnowledgeAccess,
} from "../services/knowledgeCapabilities.js";

/** Prevent the standalone full-text search route from leaking restricted notes. */
export async function enforceKnowledgeSearchVisibility(c: Context, next: Next): Promise<void> {
  if (c.req.method.toUpperCase() !== "GET") {
    await next();
    return;
  }

  await next();
  if (!c.res.ok) return;
  const contentType = c.res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return;

  let payload: unknown;
  try {
    payload = await c.res.clone().json();
  } catch {
    return;
  }
  if (!Array.isArray(payload)) return;

  const userId = c.req.header("X-User-Id") || "";
  const db = getDb();
  const unlockedFolderNodeIds = resolveUnlockedFolderNodeIds(
    db,
    userId,
    c.req.header("X-Folder-Unlock-Tokens"),
  );
  const filtered = payload.filter((row) => {
    const noteId = row && typeof row === "object" && typeof (row as any).id === "string"
      ? (row as any).id
      : "";
    if (!noteId) return false;
    const access = resolveResourceKnowledgeAccess("note", noteId, userId);
    return hasKnowledgeCapability(access, "canView")
      && canViewNoteThroughFolderPasswords(db, noteId, unlockedFolderNodeIds);
  });

  if (filtered.length === payload.length) return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  // The original candidate count is calculated before access filtering and could
  // reveal that hidden matches exist. Expose only the number delivered to the user.
  headers.set("X-Search-Candidate-Count", String(filtered.length));
  headers.set("content-type", "application/json; charset=UTF-8");
  c.res = new Response(JSON.stringify(filtered), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
}

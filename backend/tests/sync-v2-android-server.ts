// Explicit test helper, not a *.test.ts suite or production route. Loopback only.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";

async function main() {
  const directory = process.env.SYNC_ACCEPTANCE_DIRECTORY;
  if (!directory) throw new Error("SYNC_ACCEPTANCE_DIRECTORY required");
  fs.mkdirSync(directory, { recursive: true });
  process.env.DB_PATH = path.join(directory, "server.db");
  process.env.ELECTRON_USER_DATA = directory;
  process.env.JWT_SECRET = "isolated-sync-acceptance-secret-2026";
  const { getDb } = await import("../src/db/schema");
  const { signLoginToken, verifyLoginToken } = await import("../src/lib/auth-security");
  const { attachRealtimeServer, broadcastToUser } = await import("../src/services/realtime");
  const { setSyncBroadcaster } = await import("../src/sync/notify");
  const { default: routes } = await import("../src/routes/sync-v2");
  const { default: treeRoutes } = await import("../src/routes/knowledge-tree");
  const {default:trashRoutes}=await import("../src/routes/trash");
  const userId = "isolated-android-sync-user", db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id,username,passwordHash,createdAt,updatedAt) VALUES (?,?,'test-only','now','now')").run(userId, userId);
  const fixtureToken = () => signLoginToken({ userId, username: userId, tokenVersion: 0 });
  const app = new Hono();
  app.use("*", cors({ origin: "https://localhost" }));
  app.get("/acceptance/config", (c) => c.json({ userId, token: fixtureToken(), serverUrl: "http://127.0.0.1:47831" }));
  app.use("/api/*", async (c, next) => {
    const identity = verifyLoginToken(c.req.header("Authorization")?.replace(/^Bearer /, "") || "");
    if (!identity) return c.json({ error: "UNAUTHORIZED" }, 401);
    c.req.raw.headers.set("X-User-Id", identity.userId);
    await next();
  });
  app.route("/api/sync/v2", routes);
  // Match index.ts's trailing-slash mount for the list entry point.
  app.route("/api/knowledge-tree/", treeRoutes);
  app.route("/api/trash",trashRoutes);
  app.get("/acceptance/note/:id", (c) => c.json(db.prepare("SELECT * FROM notes WHERE id=? AND userId=?").get(c.req.param("id"), userId) || null));
  app.get("/acceptance/tree/:id", (c) => c.json(db.prepare("SELECT id,parentId,sortOrder,isDeleted FROM knowledge_tree_nodes WHERE id=? AND userId=?").get(c.req.param("id"),userId) || null));
  app.post("/acceptance/tree-folder", async (c) => {
    const {parentId} = await c.req.json<{parentId:string}>();
    return app.request("http://localhost/api/knowledge-tree/nodes?workspaceId=personal", {method:"POST",
      headers:{Authorization:`Bearer ${fixtureToken()}`,"Content-Type":"application/json"},
      body:JSON.stringify({parentId,nodeType:"folder",title:"Acceptance structure"})});
  });
  app.put("/acceptance/tree-move/:id", async (c) => app.request(
    `http://localhost/api/knowledge-tree/nodes/${encodeURIComponent(c.req.param("id"))}/move`, {method:"PUT",
      headers:{Authorization:`Bearer ${fixtureToken()}`,"Content-Type":"application/json"},body:JSON.stringify(await c.req.json())}));
  app.post("/acceptance/edit/:id", async (c) => {
    const note = db.prepare("SELECT * FROM notes WHERE id=? AND userId=?").get(c.req.param("id"), userId) as Record<string, unknown> | undefined;
    if (!note) return c.json({ error: "NOT_FOUND" }, 404);
    const { text } = await c.req.json<{text:string}>();
    const content = note.contentFormat === "markdown" ? text : JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    return app.request("http://localhost/api/sync/v2/push", { method: "POST", headers: { Authorization: `Bearer ${fixtureToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scopeKey: "personal", deviceId: "http-client", mutations: [{ mutationId: crypto.randomUUID(), entityType: "note", entityId: note.id, operation: "upsert", baseVersion: note.version,
        payload: { ...note, content, contentText: text } }] }) });
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 47831 });
  attachRealtimeServer(server);
  setSyncBroadcaster((recipient, notice) => broadcastToUser(recipient, notice as never));
  fs.writeFileSync(path.join(directory, "ready"), "ready");
}
void main();

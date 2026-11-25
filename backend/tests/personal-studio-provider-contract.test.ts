import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { Hono } from "hono";
import { getDb } from "../src/db/schema.js";
import { setUserAISettings } from "../src/services/user-ai-settings.js";
import pluginsRouter from "../src/routes/plugins.js";

const secret = "private-user-record-must-not-go-to-AI";
const fakeApiKey = "contract-only-fake-key-never-use-in-production";
const initial = {
  schemaVersion: 1, name: "Private tracker", description: "Status list", layout: "list",
  fields: [{ id: "title", label: "Title", type: "text" }, { id: "done", label: "Done", type: "checkbox" }],
  items: [{ id: "item1", values: { title: secret, done: false } }],
};
const blueprint = {
  schemaVersion: 1, name: "AI tracker", description: "Board", layout: "board",
  fields: [...initial.fields, { id: "owner", label: "Owner", type: "text" }],
};

test("real HTTP model adapter preserves records, isolates settings and redacts provider errors", async () => {
  const db = getDb();
  db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,?)").run("studio-provider-alice", "studio-provider-alice", "hash", "user");
  db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,?)").run("studio-provider-bob", "studio-provider-bob", "hash", "user");
  const received: Array<{ path: string; authorization: string | undefined; body: string }> = [];
  let mode: "success" | "provider-error" | "malformed" = "success";
  const server = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      received.push({ path: req.url || "", authorization: req.headers.authorization, body });
      res.setHeader("Content-Type", "application/json");
      if (mode === "provider-error") {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "never echo provider secret " + fakeApiKey }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: mode === "malformed" ? JSON.stringify({ ...blueprint, javascript: "alert(1)" }) : JSON.stringify(blueprint) } }] }));
      }
    } catch { res.statusCode = 500; res.end("{}"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as { port: number }).port;
    setUserAISettings("studio-provider-alice", [
      { key: "ai_provider", value: "openai" },
      { key: "ai_api_url", value: "http://127.0.0.1:" + port + "/v1" },
      { key: "ai_api_key", value: fakeApiKey },
      { key: "ai_model", value: "studio-contract-test" },
    ]);
    const app = new Hono();
    app.route("/api/plugins", pluginsRouter);
    const auth = (user = "studio-provider-alice", authMode?: string) => ({
      "X-User-Id": user, ...(authMode ? { "X-Auth-Mode": authMode } : {}), "Content-Type": "application/json"
    });
    const preview = (data: unknown, user?: string, authMode?: string) => app.request("/api/plugins/personal-apps/ai-preview", {
      method: "POST", headers: auth(user, authMode), body: JSON.stringify(data),
    });
    const ok = await preview({ instruction: "Add an owner column", spec: initial });
    assert.equal(ok.status, 200, await ok.clone().text());
    const proposed = (await ok.json() as any).spec;
    assert.equal(proposed.name, "AI tracker");
    assert.equal(proposed.items[0].values.title, secret);
    assert.equal(proposed.fields[2].id, "owner");
    assert.equal(received.length, 1);
    assert.equal(received[0].path, "/v1/chat/completions");
    assert.equal(received[0].authorization, "Bearer " + fakeApiKey);
    const sent = JSON.parse(received[0].body);
    assert.equal(sent.model, "studio-contract-test");
    assert.equal(sent.stream, false);
    assert.equal(sent.messages[0].role, "system");
    assert.equal(sent.messages[1].role, "user");
    assert.ok(!received[0].body.includes(secret));
    assert.ok(!received[0].body.includes(fakeApiKey));
    assert.ok(!received[0].body.includes('"items"'));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM personal_studio_apps WHERE userId=?").get("studio-provider-alice") as any).n, 0);

    assert.equal((await preview({ instruction: "Make my app" }, "studio-provider-bob")).status, 409);
    assert.equal((await preview({ instruction: "Make my app" }, "studio-provider-alice", "api-token")).status, 403);
    assert.equal((await preview({ instruction: 7 })).status, 400);
    assert.equal((await preview({ instruction: "Okay", admin: true })).status, 400);
    assert.equal(received.length, 1);

    mode = "provider-error";
    const upstream = await preview({ instruction: "Do not leak errors" });
    assert.equal(upstream.status, 502);
    const upstreamText = await upstream.text();
    assert.ok(!upstreamText.includes(fakeApiKey), "must not reveal provider auth or response body");
    assert.ok(!upstreamText.includes("127.0.0.1"), "must not reveal provider URL");

    mode = "malformed";
    const invalid = await preview({ instruction: "Return malformed code" });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json() as any).code, "STUDIO_AI_INVALID_OUTPUT");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM personal_studio_apps WHERE userId=?").get("studio-provider-alice") as any).n, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

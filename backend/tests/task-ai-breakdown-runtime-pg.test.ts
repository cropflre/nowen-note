import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createTaskAIBreakdownRuntimeRouter } from "../src/routes/task-ai-breakdown-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-task-ai-owner";
const VIEWER = "pg-task-ai-viewer";
const OUTSIDER = "pg-task-ai-outsider";
const WORKSPACE = "pg-task-ai-workspace";
const PERSONAL_TASK = "pg-task-ai-personal";
const WORKSPACE_TASK = "pg-task-ai-workspace-task";
const CHILD_TASK = "pg-task-ai-existing-child";

function headers(userId: string) {
  return { "X-User-Id": userId, "content-type": "application/json" };
}

async function putAISettings(pool: import("pg").Pool, userId: string, url: string, model: string, key: string) {
  for (const [settingKey, value] of [
    ["ai_provider", "openai"],
    ["ai_api_url", url],
    ["ai_api_key", key],
    ["ai_model", model],
  ]) {
    await pool.query(
      `INSERT INTO user_ai_settings ("userId", key, value, "updatedAt")
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT ("userId", key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = CURRENT_TIMESTAMP`,
      [userId, settingKey, value],
    );
  }
}

async function resetFixture(pool: import("pg").Pool, baseUrl: string) {
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, VIEWER, OUTSIDER]]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion") VALUES
       ($1, 'pg_task_ai_owner', 'hash', 0),
       ($2, 'pg_task_ai_viewer', 'hash', 0),
       ($3, 'pg_task_ai_outsider', 'hash', 0)`,
    [OWNER, VIEWER, OUTSIDER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId", "enabledFeatures") VALUES ($1, 'Task AI', $2, '')`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES
       ($1, $2, 'owner'), ($1, $3, 'viewer')`,
    [WORKSPACE, OWNER, VIEWER],
  );
  await pool.query(
    `INSERT INTO tasks (id, "userId", "workspaceId", title, "dueDate", "isCompleted", status, "sortOrder") VALUES
       ($1, $2, NULL, 'Ship PostgreSQL cutover', '2030-05-20', false, 'todo', 0),
       ($3, $4, $5, 'Workspace launch', '2030-06-10', false, 'todo', 0),
       ($6, $2, NULL, 'Existing child', '2030-05-18', false, 'todo', 0)`,
    [PERSONAL_TASK, OWNER, WORKSPACE_TASK, VIEWER, WORKSPACE, CHILD_TASK],
  );
  await pool.query(`UPDATE tasks SET "parentId" = $1 WHERE id = $2`, [PERSONAL_TASK, CHILD_TASK]);
  await putAISettings(pool, OWNER, baseUrl, "pg-owner-model", "pg-owner-key");
  await putAISettings(pool, VIEWER, baseUrl, "pg-viewer-model", "pg-viewer-key");
}

test("PostgreSQL task AI breakdown uses PG settings and preserves ACL/suggestion semantics", { skip: !hasPg }, async () => {
  const requests: Array<{ authorization: string; body: any }> = [];
  let responseContent = JSON.stringify({
    subtasks: [
      { title: "Prepare rollout", priority: 3, dueDate: "2030-05-21", reason: "Plan the release" },
      { title: "Verify backups", priority: 9, dueDate: "2030-05-19", reason: "Keep rollback safe" },
    ],
  });
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({ authorization: String(req.headers.authorization || ""), body: JSON.parse(raw || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: responseContent } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool, baseUrl);
    const app = createTaskAIBreakdownRuntimeRouter(new PostgresAdapter(pool));

    const personal = await app.request(`http://runtime/${PERSONAL_TASK}/ai-breakdown`, {
      method: "POST", headers: headers(OWNER), body: JSON.stringify({ lang: "en" }),
    });
    assert.equal(personal.status, 200);
    const body = await personal.json() as any;
    assert.equal(body.subtasks.length, 2);
    assert.equal(body.subtasks[0].dueDate, "2030-05-20");
    assert.equal(body.subtasks[1].priority, 2);
    assert.equal(requests[0]?.body.model, "pg-owner-model");
    assert.equal(requests[0]?.authorization, "Bearer pg-owner-key");
    assert.match(requests[0]?.body.messages[1].content, /Existing subtasks: Existing child/);

    const outsiderPersonal = await app.request(`http://runtime/${PERSONAL_TASK}/ai-breakdown`, {
      method: "POST", headers: headers(OUTSIDER), body: "{}",
    });
    assert.equal(outsiderPersonal.status, 403);

    const viewerOwn = await app.request(`http://runtime/${WORKSPACE_TASK}/ai-breakdown`, {
      method: "POST", headers: headers(VIEWER), body: JSON.stringify({ lang: "zh-CN" }),
    });
    assert.equal(viewerOwn.status, 200);
    assert.equal(requests.at(-1)?.body.model, "pg-viewer-model");

    const ownerManage = await app.request(`http://runtime/${WORKSPACE_TASK}/ai-breakdown`, {
      method: "POST", headers: headers(OWNER), body: JSON.stringify({ lang: "en" }),
    });
    assert.equal(ownerManage.status, 200);
    assert.equal(requests.at(-1)?.body.model, "pg-owner-model");

    const outsiderWorkspace = await app.request(`http://runtime/${WORKSPACE_TASK}/ai-breakdown`, {
      method: "POST", headers: headers(OUTSIDER), body: "{}",
    });
    assert.equal(outsiderWorkspace.status, 403);

    responseContent = "not-json";
    const invalidJson = await app.request(`http://runtime/${PERSONAL_TASK}/ai-breakdown`, {
      method: "POST", headers: headers(OWNER), body: JSON.stringify({ lang: "en" }),
    });
    assert.equal(invalidJson.status, 500);
    assert.equal((await invalidJson.json() as any).code, "AI_INVALID_JSON");

    await pool.query(`UPDATE user_ai_settings SET value = '' WHERE "userId" = $1 AND key = 'ai_api_url'`, [OWNER]);
    const before = requests.length;
    const notConfigured = await app.request(`http://runtime/${PERSONAL_TASK}/ai-breakdown`, {
      method: "POST", headers: headers(OWNER), body: "{}",
    });
    assert.equal(notConfigured.status, 400);
    assert.equal((await notConfigured.json() as any).code, "AI_NOT_CONFIGURED");
    assert.equal(requests.length, before);

    const missing = await app.request("http://runtime/missing-task/ai-breakdown", {
      method: "POST", headers: headers(OWNER), body: "{}",
    });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    await closePgPool(pool);
  }
});

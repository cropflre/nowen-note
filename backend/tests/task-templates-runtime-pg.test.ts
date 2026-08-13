import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createTaskTemplatesRuntimeRouter } from "../src/routes/task-templates-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-task-template-owner";
const VIEWER = "pg-task-template-viewer";
const OUTSIDER = "pg-task-template-outsider";
const WORKSPACE = "pg-task-template-workspace";
const PROJECT = "pg-task-template-project";
const PERSONAL_PROJECT = "pg-task-template-personal-project";
const EXTERNAL_PARENT = "pg-task-template-external-parent";

function headers(userId: string, json = false) {
  return {
    "X-User-Id": userId,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function body<T = any>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, VIEWER, OUTSIDER]]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion") VALUES
       ($1, 'pg_task_template_owner', 'hash', 0),
       ($2, 'pg_task_template_viewer', 'hash', 0),
       ($3, 'pg_task_template_outsider', 'hash', 0)`,
    [OWNER, VIEWER, OUTSIDER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId", "enabledFeatures")
     VALUES ($1, 'Task Template Runtime', $2, '')`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES
       ($1, $2, 'owner'),
       ($1, $3, 'viewer')`,
    [WORKSPACE, OWNER, VIEWER],
  );
  await pool.query(
    `INSERT INTO task_projects (id, "userId", "workspaceId", name)
     VALUES ($1, $2, $3, 'Workspace project')`,
    [PROJECT, OWNER, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO task_projects (id, "userId", "workspaceId", name)
     VALUES ($1, $2, NULL, 'Personal project')`,
    [PERSONAL_PROJECT, VIEWER],
  );
  await pool.query(
    `INSERT INTO tasks (id, "userId", "workspaceId", title)
     VALUES ($1, $2, $3, 'External parent')`,
    [EXTERNAL_PARENT, OWNER, WORKSPACE],
  );
}

test("PostgreSQL task templates preserve CRUD, scope, hierarchy and apply semantics", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool);
    const adapter = new PostgresAdapter(pool);
    const app = new Hono();
    app.route("/task-templates", createTaskTemplatesRuntimeRouter(adapter));

    const createWorkspaceTemplate = await app.request(
      `http://runtime/task-templates?workspaceId=${WORKSPACE}`,
      {
        method: "POST",
        headers: headers(VIEWER, true),
        body: JSON.stringify({
          name: " Release checklist ",
          description: "Workspace template",
          items: [
            { title: "Build", description: "Compile", priority: 3, relativeDueDays: 0, parentIndex: null, sortOrder: 0 },
            { title: "Ship", description: "Deploy", priority: 2, relativeDueDays: 2, parentIndex: 0, sortOrder: 1 },
            { title: "   ", priority: 2, relativeDueDays: 3, parentIndex: null, sortOrder: 2 },
          ],
        }),
      },
    );
    assert.equal(createWorkspaceTemplate.status, 201, "workspace viewers retain existing ability to create their own templates");
    const workspaceTemplate = await body<any>(createWorkspaceTemplate);
    assert.equal(workspaceTemplate.name, "Release checklist");
    assert.equal(workspaceTemplate.userId, VIEWER);
    assert.equal(workspaceTemplate.workspaceId, WORKSPACE);
    assert.equal(workspaceTemplate.items.length, 2, "blank template items must be dropped");

    const outsiderList = await app.request(`http://runtime/task-templates?workspaceId=${WORKSPACE}`, {
      headers: headers(OUTSIDER),
    });
    assert.equal(outsiderList.status, 403);

    const ownerList = await app.request(`http://runtime/task-templates?workspaceId=${WORKSPACE}`, {
      headers: headers(OWNER),
    });
    assert.equal(ownerList.status, 200);
    assert.equal((await body<any[]>(ownerList)).some((item) => item.id === workspaceTemplate.id), true);

    const outsiderUpdate = await app.request(`http://runtime/task-templates/${workspaceTemplate.id}`, {
      method: "PUT",
      headers: headers(OUTSIDER, true),
      body: JSON.stringify({ name: "Forbidden" }),
    });
    assert.equal(outsiderUpdate.status, 403);

    const ownerUpdate = await app.request(`http://runtime/task-templates/${workspaceTemplate.id}`, {
      method: "PUT",
      headers: headers(OWNER, true),
      body: JSON.stringify({ name: "Owner managed template", color: "#123456" }),
    });
    assert.equal(ownerUpdate.status, 200, "workspace owner may manage another member's shared template");
    assert.equal((await body<any>(ownerUpdate)).name, "Owner managed template");

    const invalidBaseDate = await app.request(`http://runtime/task-templates/${workspaceTemplate.id}/apply`, {
      method: "POST",
      headers: headers(VIEWER, true),
      body: JSON.stringify({ projectId: PROJECT, baseDate: "2026-02-30" }),
    });
    assert.equal(invalidBaseDate.status, 400);
    assert.equal((await body<any>(invalidBaseDate)).code, "INVALID_BASE_DATE");

    const applyWorkspaceTemplate = await app.request(`http://runtime/task-templates/${workspaceTemplate.id}/apply`, {
      method: "POST",
      headers: headers(VIEWER, true),
      body: JSON.stringify({ projectId: PROJECT, baseDate: "2026-08-20" }),
    });
    assert.equal(applyWorkspaceTemplate.status, 200, "workspace members may apply templates just like they may create their own tasks");
    const applied = await body<any>(applyWorkspaceTemplate);
    assert.equal(applied.count, 2);
    assert.equal(applied.createdTasks[0].dueDate, "2026-08-20");
    assert.equal(applied.createdTasks[1].dueDate, "2026-08-22");
    assert.equal(applied.createdTasks[1].parentId, applied.createdTasks[0].id);

    const storedApplied = await pool.query(
      `SELECT id, "userId", "workspaceId", "projectId", "parentId", "dueDate", "isCompleted", status
         FROM tasks
        WHERE id = ANY($1::text[])
        ORDER BY "dueDate" ASC, id ASC`,
      [applied.createdTasks.map((task: any) => task.id)],
    );
    assert.equal(storedApplied.rowCount, 2);
    assert.equal(storedApplied.rows.every((row) => row.userId === VIEWER), true);
    assert.equal(storedApplied.rows.every((row) => row.workspaceId === WORKSPACE), true);
    assert.equal(storedApplied.rows.every((row) => row.projectId === PROJECT), true);
    assert.equal(storedApplied.rows.every((row) => row.isCompleted === false && row.status === "todo"), true);

    const crossScopeProject = await app.request(`http://runtime/task-templates/${workspaceTemplate.id}/apply`, {
      method: "POST",
      headers: headers(VIEWER, true),
      body: JSON.stringify({ projectId: PERSONAL_PROJECT, baseDate: "2026-08-20" }),
    });
    assert.equal(crossScopeProject.status, 403);
    assert.equal((await body<any>(crossScopeProject)).code, "SCOPE_MISMATCH");

    const applyUnderExistingParent = await app.request(`http://runtime/task-templates/${workspaceTemplate.id}/apply`, {
      method: "POST",
      headers: headers(VIEWER, true),
      body: JSON.stringify({ parentId: EXTERNAL_PARENT, baseDate: "2026-08-25" }),
    });
    assert.equal(applyUnderExistingParent.status, 200);
    const nested = await body<any>(applyUnderExistingParent);
    assert.equal(nested.createdTasks[0].parentId, EXTERNAL_PARENT);
    assert.equal(nested.createdTasks[1].parentId, nested.createdTasks[0].id);

    const createPersonalTemplate = await app.request("http://runtime/task-templates", {
      method: "POST",
      headers: headers(VIEWER, true),
      body: JSON.stringify({
        name: "Personal template",
        items: [{ title: "Personal task", priority: 1, relativeDueDays: 1, parentIndex: null, sortOrder: 0 }],
      }),
    });
    assert.equal(createPersonalTemplate.status, 201);
    const personalTemplate = await body<any>(createPersonalTemplate);
    assert.equal(personalTemplate.workspaceId, null);

    const ownerCannotManagePersonal = await app.request(`http://runtime/task-templates/${personalTemplate.id}`, {
      method: "PUT",
      headers: headers(OWNER, true),
      body: JSON.stringify({ name: "Nope" }),
    });
    assert.equal(ownerCannotManagePersonal.status, 403);

    const personalCrossScope = await app.request(`http://runtime/task-templates/${personalTemplate.id}/apply`, {
      method: "POST",
      headers: headers(VIEWER, true),
      body: JSON.stringify({ projectId: PROJECT, baseDate: "2026-08-20" }),
    });
    assert.equal(personalCrossScope.status, 403);

    const personalApply = await app.request(`http://runtime/task-templates/${personalTemplate.id}/apply`, {
      method: "POST",
      headers: headers(VIEWER, true),
      body: JSON.stringify({ projectId: PERSONAL_PROJECT, baseDate: "2026-08-20" }),
    });
    assert.equal(personalApply.status, 200);
    assert.equal((await body<any>(personalApply)).createdTasks[0].dueDate, "2026-08-21");

    await pool.query(`UPDATE workspaces SET "enabledFeatures" = '{"tasks":false}' WHERE id = $1`, [WORKSPACE]);
    const featureDisabledList = await app.request(`http://runtime/task-templates?workspaceId=${WORKSPACE}`, {
      headers: headers(VIEWER),
    });
    assert.equal(featureDisabledList.status, 403);
    assert.equal((await body<any>(featureDisabledList)).code, "FEATURE_DISABLED");

    const featureDisabledApply = await app.request(`http://runtime/task-templates/${workspaceTemplate.id}/apply`, {
      method: "POST",
      headers: headers(VIEWER, true),
      body: JSON.stringify({ baseDate: "2026-08-20" }),
    });
    assert.equal(featureDisabledApply.status, 403);
    assert.equal((await body<any>(featureDisabledApply)).code, "FEATURE_DISABLED");
    await pool.query(`UPDATE workspaces SET "enabledFeatures" = '' WHERE id = $1`, [WORKSPACE]);

    const ownerDelete = await app.request(`http://runtime/task-templates/${workspaceTemplate.id}`, {
      method: "DELETE",
      headers: headers(OWNER),
    });
    assert.equal(ownerDelete.status, 200);
    assert.equal((await pool.query(`SELECT id FROM task_templates WHERE id = $1`, [workspaceTemplate.id])).rowCount, 0);

    const personalDelete = await app.request(`http://runtime/task-templates/${personalTemplate.id}`, {
      method: "DELETE",
      headers: headers(VIEWER),
    });
    assert.equal(personalDelete.status, 200);
  } finally {
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, VIEWER, OUTSIDER]]).catch(() => {});
    await closePgPool(pool);
  }
});

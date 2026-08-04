import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-workspace-journal-routes-"));
process.env.DB_PATH = path.join(tempDir, "workspace-journal-routes.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

function request(
  pathname: string,
  input: { method?: string; body?: unknown; userId?: string } = {},
): Request {
  return new Request(`http://localhost${pathname}`, {
    method: input.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": input.userId === undefined ? "editor" : input.userId,
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

test("workspace journal routes separate shared and personal daily pages", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { default: journals } = await import("../src/routes/journals.js");
  closeDatabase = closeDb;
  const db = getDb();

  const insertUser = db.prepare(
    "INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')",
  );
  for (const id of ["owner", "editor", "viewer", "outsider"]) insertUser.run(id, id);
  db.prepare(`
    INSERT INTO workspaces (id, name, description, icon, ownerId, enabledFeatures)
    VALUES ('workspace-one', '项目一', '', '🏢', 'owner', '')
  `).run();
  const member = db.prepare(`
    INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)
  `);
  member.run("workspace-one", "owner", "owner");
  member.run("workspace-one", "editor", "editor");
  member.run("workspace-one", "viewer", "viewer");

  const missing = await journals.request(request(
    "/workspace/workspace-one/check?date=2026-08-03",
  ));
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), {
    exists: false,
    noteId: null,
    title: null,
    canWrite: true,
    role: "editor",
    scope: "workspace",
    workspaceId: "workspace-one",
  });

  const createdResponse = await journals.request(request(
    "/workspace/workspace-one/resolve",
    { method: "POST", body: { localDate: "2026-08-03" } },
  ));
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as any;
  assert.equal(created.existed, false);
  assert.equal(created.canWrite, true);
  assert.equal(created.workspaceId, "workspace-one");
  assert.equal(created.scope, "workspace");
  assert.equal(created.title, "2026-08-03");

  const viewerCheck = await journals.request(request(
    "/workspace/workspace-one/check?date=2026-08-03",
    { userId: "viewer" },
  ));
  assert.equal(viewerCheck.status, 200);
  const viewerCheckBody = await viewerCheck.json() as any;
  assert.equal(viewerCheckBody.exists, true);
  assert.equal(viewerCheckBody.noteId, created.id);
  assert.equal(viewerCheckBody.canWrite, false);

  const viewerOpen = await journals.request(request(
    "/workspace/workspace-one/resolve",
    { method: "POST", userId: "viewer", body: { localDate: "2026-08-03" } },
  ));
  assert.equal(viewerOpen.status, 200);
  const viewerOpenBody = await viewerOpen.json() as any;
  assert.equal(viewerOpenBody.id, created.id);
  assert.equal(viewerOpenBody.existed, true);
  assert.equal(viewerOpenBody.canWrite, false);

  const viewerCreate = await journals.request(request(
    "/workspace/workspace-one/resolve",
    { method: "POST", userId: "viewer", body: { localDate: "2026-08-04" } },
  ));
  assert.equal(viewerCreate.status, 403);
  assert.equal((await viewerCreate.json() as any).code, "WORKSPACE_JOURNAL_READ_ONLY");

  const outsider = await journals.request(request(
    "/workspace/workspace-one/check?date=2026-08-03",
    { userId: "outsider" },
  ));
  assert.equal(outsider.status, 403);
  assert.equal((await outsider.json() as any).code, "WORKSPACE_FORBIDDEN");

  const invalid = await journals.request(request(
    "/workspace/workspace-one/resolve",
    { method: "POST", body: { localDate: "2026-02-30" } },
  ));
  assert.equal(invalid.status, 400);

  const personal = await journals.request(request(
    "/today",
    { method: "POST", userId: "owner", body: { localDate: "2026-08-03" } },
  ));
  assert.equal(personal.status, 201);
  const personalBody = await personal.json() as any;
  assert.notEqual(personalBody.id, created.id);
  assert.equal(personalBody.workspaceId, null);
  assert.equal(personalBody.note_type, "journal");

  db.prepare(`
    UPDATE workspaces SET enabledFeatures = '{"diaries":false}'
    WHERE id = 'workspace-one'
  `).run();
  const disabled = await journals.request(request(
    "/workspace/workspace-one/check?date=2026-08-03",
    { userId: "owner" },
  ));
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json() as any).code, "WORKSPACE_DIARIES_DISABLED");
});

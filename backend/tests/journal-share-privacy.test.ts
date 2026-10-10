import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-journal-share-privacy-"));
process.env.DB_PATH = path.join(tempDir, "journal-share-privacy.db");
process.env.JWT_SECRET = "journal-share-privacy-test";
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.JWT_SECRET;
});

function request(pathname: string, options: {
  method?: string;
  body?: unknown;
  unlockToken?: string;
} = {}) {
  return new Request(`http://localhost${pathname}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": "journal-share-user",
      ...(options.unlockToken ? { "X-Folder-Unlock-Tokens": options.unlockToken } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

test("locked personal journals cannot create or enumerate shares until the real folder is unlocked", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const [{ getDb, closeDb }, { default: journals }, { default: knowledgeTree }, { sharesRouter: shares }] = await Promise.all([
    import("../src/db/schema.js"),
    import("../src/routes/journals.js"),
    import("../src/routes/knowledge-tree.js"),
    import("../src/routes/shares.js"),
  ]);
  closeDatabase = closeDb;
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("journal-share-user", "journal-share-user", "hash");

  // Seed a historical root with a non-deterministic id. The privacy resolver must
  // adopt and protect this actual resource instead of looking only for the stable id.
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, sortOrder)
    VALUES ('legacy-personal-journal', 'journal-share-user', NULL, NULL, '个人日记', -1)
  `).run();

  const createdResponse = await journals.request(request("/today", {
    method: "POST",
    body: { localDate: "2026-09-29" },
  }));
  assert.equal(createdResponse.status, 201);
  const journal = await createdResponse.json() as any;

  const privacy = await (await journals.request(request("/privacy"))).json() as any;
  assert.equal(privacy.rootNotebookId, "legacy-personal-journal");
  assert.equal(privacy.rootNodeId, "notebook:legacy-personal-journal");

  const passwordResponse = await knowledgeTree.request(request(
    `/nodes/${encodeURIComponent(privacy.rootNodeId)}/password`,
    { method: "PUT", body: { newPassword: "journal-secret" } },
  ));
  assert.equal(passwordResponse.status, 200);

  const deniedCreate = await shares.request(request("/", {
    method: "POST",
    body: { noteId: journal.id, permission: "view" },
  }));
  assert.equal(deniedCreate.status, 403);
  assert.equal((await deniedCreate.json() as any).code, "FOLDER_UNLOCK_REQUIRED");

  const deniedList = await shares.request(request(`/note/${journal.id}`));
  assert.equal(deniedList.status, 403);
  assert.equal((await deniedList.json() as any).code, "FOLDER_UNLOCK_REQUIRED");

  const unlockResponse = await knowledgeTree.request(request(
    `/nodes/${encodeURIComponent(privacy.rootNodeId)}/unlock`,
    { method: "POST", body: { password: "journal-secret" } },
  ));
  const unlocked = await unlockResponse.json() as any;
  assert.ok(unlocked.unlockToken);

  const allowedCreate = await shares.request(request("/", {
    method: "POST",
    unlockToken: unlocked.unlockToken,
    body: { noteId: journal.id, permission: "view" },
  }));
  assert.equal(allowedCreate.status, 201);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-journal-cleanup-routes-"));
process.env.DB_PATH = path.join(tempDir, "journal-cleanup-routes.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

function jsonRequest(pathname: string, input?: { method?: string; body?: unknown; userId?: string }) {
  return new Request(`http://localhost${pathname}`, {
    method: input?.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": input?.userId === undefined ? "cleanup-route-user" : input.userId,
    },
    body: input?.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

test("journal cleanup routes require a fresh preview and can restore the cleanup", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { default: journals } = await import("../src/routes/journals.js");
  closeDatabase = closeDb;

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("cleanup-route-user", "cleanup-route-user", "hash");
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, sortOrder)
    VALUES ('cleanup-route-legacy', 'cleanup-route-user', NULL, NULL, '旧日记目录', 0)
  `).run();
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText,
      note_type, journal_date, sortOrder
    ) VALUES (
      'cleanup-route-journal', 'cleanup-route-user', 'cleanup-route-legacy', NULL,
      '2026-07-01', '{}', '', 'journal', '2026-07-01', 0
    )
  `).run();

  const organize = await journals.request(jsonRequest("/organize", { method: "POST" }));
  assert.equal(organize.status, 200);

  const previewResponse = await journals.request(jsonRequest("/cleanup-preview"));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json() as any;
  assert.equal(preview.candidateCount, 1);
  assert.equal(preview.candidates[0].id, "cleanup-route-legacy");

  const staleResponse = await journals.request(jsonRequest("/cleanup", {
    method: "POST",
    body: {
      previewToken: "0".repeat(64),
      candidateIds: ["cleanup-route-legacy"],
    },
  }));
  assert.equal(staleResponse.status, 409);

  const cleanupResponse = await journals.request(jsonRequest("/cleanup", {
    method: "POST",
    body: {
      previewToken: preview.previewToken,
      candidateIds: ["cleanup-route-legacy"],
    },
  }));
  assert.equal(cleanupResponse.status, 200);
  const cleanup = await cleanupResponse.json() as any;
  assert.equal(cleanup.cleaned, 1);
  assert.match(cleanup.cleanupId, /^[0-9a-f-]{36}$/i);
  assert.equal(
    (db.prepare("SELECT isDeleted FROM notebooks WHERE id = 'cleanup-route-legacy'").get() as { isDeleted: number }).isDeleted,
    1,
  );

  const restoreResponse = await journals.request(jsonRequest("/cleanup/restore", {
    method: "POST",
    body: { cleanupId: cleanup.cleanupId },
  }));
  assert.equal(restoreResponse.status, 200);
  const restored = await restoreResponse.json() as any;
  assert.equal(restored.restored, 1);
  assert.equal(
    (db.prepare("SELECT isDeleted FROM notebooks WHERE id = 'cleanup-route-legacy'").get() as { isDeleted: number }).isDeleted,
    0,
  );

  const unauthorized = await journals.request(jsonRequest("/cleanup-preview", { userId: "" }));
  assert.equal(unauthorized.status, 401);
});

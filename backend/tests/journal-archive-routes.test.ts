import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-journal-routes-"));
process.env.DB_PATH = path.join(tempDir, "journal-routes.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

function jsonRequest(pathname: string, input?: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  return new Request(`http://localhost${pathname}`, {
    method: input?.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": "route-user",
      ...(input?.headers || {}),
    },
    body: input?.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

test("journal routes create, repair and organize real archive entities", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { default: journals } = await import("../src/routes/journals.js");
  closeDatabase = closeDb;

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("route-user", "route-user", "hash");

  const invalidCreate = await journals.request(jsonRequest("/today", {
    method: "POST",
    body: { localDate: "2026-02-30" },
  }));
  assert.equal(invalidCreate.status, 400);

  const invalidCheck = await journals.request(jsonRequest("/check?date=2026-13-01"));
  assert.equal(invalidCheck.status, 400);

  // No regular notebook exists. The route must create the journal archive itself.
  const createdResponse = await journals.request(jsonRequest("/today", {
    method: "POST",
    body: { localDate: "2026-08-03" },
  }));
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as any;
  assert.equal(created.existed, false);
  assert.equal(created.journal_date, "2026-08-03");
  assert.equal(created.notebookId, created.archive.monthNotebookId);

  const pathRow = db.prepare(`
    SELECT month.name AS monthName, year.name AS yearName, root.name AS rootName
    FROM notes note
    JOIN notebooks month ON month.id = note.notebookId
    JOIN notebooks year ON year.id = month.parentId
    JOIN notebooks root ON root.id = year.parentId
    WHERE note.id = ?
  `).get(created.id) as { monthName: string; yearName: string; rootName: string };
  assert.deepEqual(pathRow, {
    monthName: "2026年08月",
    yearName: "2026年",
    rootName: "个人日记",
  });

  // Simulate an old or manually moved journal. Reopening must repair it and return fresh state.
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, sortOrder)
    VALUES ('route-legacy', 'route-user', NULL, NULL, '旧日记位置', 99)
  `).run();
  db.prepare("UPDATE notes SET notebookId = ?, sortOrder = 0 WHERE id = ?")
    .run("route-legacy", created.id);

  const repairedResponse = await journals.request(jsonRequest("/today", {
    method: "POST",
    body: { localDate: "2026-08-03" },
  }));
  assert.equal(repairedResponse.status, 200);
  const repaired = await repairedResponse.json() as any;
  assert.equal(repaired.existed, true);
  assert.equal(repaired.id, created.id);
  assert.equal(repaired.notebookId, repaired.archive.monthNotebookId);
  assert.equal(repaired.sortOrder, -20260803);

  // Seed a second historical journal in a legacy notebook and migrate through the route.
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText,
      note_type, journal_date, sortOrder
    ) VALUES (
      'route-old-journal', 'route-user', 'route-legacy', NULL, '保留标题', '{}', '',
      'journal', '2025-12-31', 0
    )
  `).run();

  const organizeResponse = await journals.request(jsonRequest("/organize", { method: "POST" }));
  assert.equal(organizeResponse.status, 200);
  const organized = await organizeResponse.json() as any;
  assert.equal(organized.success, true);
  assert.equal(organized.organized, 2);
  assert.equal(organized.moved, 1);

  const organizedAgainResponse = await journals.request(jsonRequest("/organize", { method: "POST" }));
  assert.equal(organizedAgainResponse.status, 200);
  const organizedAgain = await organizedAgainResponse.json() as any;
  assert.equal(organizedAgain.moved, 0);
  assert.equal(organizedAgain.alreadyOrganized, 2);

  const oldJournal = db.prepare(`
    SELECT note.title, month.name AS monthName, year.name AS yearName
    FROM notes note
    JOIN notebooks month ON month.id = note.notebookId
    JOIN notebooks year ON year.id = month.parentId
    WHERE note.id = 'route-old-journal'
  `).get() as { title: string; monthName: string; yearName: string };
  assert.deepEqual(oldJournal, {
    title: "保留标题",
    monthName: "2025年12月",
    yearName: "2025年",
  });

  db.prepare("UPDATE notes SET title = ?, contentText = ? WHERE id = ?")
    .run("修复路由的一天", "今天终于把这个 Bug 修好了", created.id);
  db.prepare(`
    INSERT INTO diaries (id, userId, workspaceId, contentText, mood, images, media, createdAt)
    VALUES ('route-moment', 'route-user', NULL, '今天很开心', 'happy', '[]', '[]', '2026-08-03 10:00:00')
  `).run();

  const filteredResponse = await journals.request(jsonRequest(
    "/list?year=2026&month=08&mood=happy&q=%E4%BF%AE%E5%A4%8D&sort=date_desc&tzOffsetMinutes=0&limit=20",
  ));
  assert.equal(filteredResponse.status, 200);
  const filtered = await filteredResponse.json() as any;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].journalDate, "2026-08-03");
  assert.equal(filtered.items[0].subtitle, "修复路由的一天");
  assert.deepEqual(filtered.items[0].moods, ["happy"]);
  assert.equal(filtered.items[0].preview, "今天终于把这个 Bug 修好了");

  const privacyBefore = await journals.request(jsonRequest("/privacy"));
  assert.equal(privacyBefore.status, 200);
  const privacyState = await privacyBefore.json() as any;
  assert.equal(privacyState.exists, true);
  assert.equal(privacyState.isPasswordProtected, false);

  const { default: knowledgeTree } = await import("../src/routes/knowledge-tree.js");
  const passwordResponse = await knowledgeTree.request(jsonRequest(
    `/nodes/${encodeURIComponent(privacyState.rootNodeId)}/password`,
    { method: "PUT", body: { newPassword: "journal-secret" } },
  ));
  assert.equal(passwordResponse.status, 200);

  const lockedList = await journals.request(jsonRequest("/list"));
  assert.equal(lockedList.status, 403);
  assert.equal((await lockedList.json() as any).code, "FOLDER_UNLOCK_REQUIRED");

  const privacyLocked = await journals.request(jsonRequest("/privacy"));
  const privacyLockedBody = await privacyLocked.json() as any;
  assert.equal(privacyLockedBody.isPasswordProtected, true);
  assert.equal(privacyLockedBody.unlocked, false);

  const unlockResponse = await knowledgeTree.request(jsonRequest(
    `/nodes/${encodeURIComponent(privacyState.rootNodeId)}/unlock`,
    { method: "POST", body: { password: "journal-secret" } },
  ));
  assert.equal(unlockResponse.status, 200);
  const unlockBody = await unlockResponse.json() as any;
  assert.ok(unlockBody.unlockToken);

  const unlockedList = await journals.request(jsonRequest("/list?limit=20", {
    headers: { "X-Folder-Unlock-Tokens": unlockBody.unlockToken },
  }));
  assert.equal(unlockedList.status, 200);
  assert.equal((await unlockedList.json() as any).total, 2);
});

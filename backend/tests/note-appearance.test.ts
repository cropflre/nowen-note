import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-appearance-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let normalizeNoteThemeId: (value: unknown) => string | null;
let defaultThemeId: string;

const USER_ID = "appearance-user";
const NOTEBOOK_ID = "appearance-notebook";
const NOTE_ID = "appearance-note";

function db() {
  return getDb();
}

function resetDb() {
  db().exec(`
    DELETE FROM favorites;
    DELETE FROM notes;
    DELETE FROM notebook_members;
    DELETE FROM notebooks;
    DELETE FROM users;
  `);
  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db().prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, icon)
    VALUES (?, ?, NULL, 'Appearance', '📒')
  `).run(NOTEBOOK_ID, USER_ID);
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, 'Theme note', ?, 'Theme note body', 'markdown', 7)
  `).run(NOTE_ID, USER_ID, NOTEBOOK_ID, "# Theme note\n\nbody");
}

const headers = () => ({
  "X-User-Id": USER_ID,
  "Content-Type": "application/json",
});

test.before(async () => {
  const [appearanceModule, notesModule, schemaModule] = await Promise.all([
    import("../src/runtime/note-appearance"),
    import("../src/routes/notes"),
    import("../src/db/schema"),
  ]);
  normalizeNoteThemeId = appearanceModule.normalizeNoteThemeId;
  defaultThemeId = appearanceModule.DEFAULT_NOTE_THEME_ID;
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  app = new Hono();
  app.route("/api/notes", notesModule.default);
});

test.beforeEach(resetDb);

test.after(async () => {
  closeDb();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (error?.code !== "EBUSY" || attempt === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("inheritance is NULL while explicit Nowen Default remains a valid appearance id", () => {
  assert.equal(normalizeNoteThemeId(null), null);
  assert.equal(normalizeNoteThemeId(""), null);
  assert.equal(normalizeNoteThemeId(defaultThemeId), "default");
  assert.equal(normalizeNoteThemeId(" Acme.Theme-Pack/Paper-V2 "), "acme.theme-pack/paper-v2");
  assert.equal(normalizeNoteThemeId("publisher.paper-v2"), null);
  assert.equal(normalizeNoteThemeId("unknown-built-in"), null);
  assert.equal(normalizeNoteThemeId("https://evil.example/theme.css"), null);
  assert.equal(normalizeNoteThemeId("theme id with spaces"), null);
  assert.equal(normalizeNoteThemeId("@import"), null);
  assert.equal(normalizeNoteThemeId("a".repeat(97)), null);
});

test("namespaced plugin theme ids persist even when the plugin is currently unavailable", async () => {
  const themeId = "acme.theme-pack/paper-v2";
  const response = await app.request(`/api/note-appearance/${NOTE_ID}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ themeId }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json() as { themeId: string }).themeId, themeId);
  assert.equal(
    (db().prepare("SELECT themeId FROM notes WHERE id = ?").get(NOTE_ID) as { themeId: string }).themeId,
    themeId,
  );
});

test("appearance starts in inherit mode and persists independently from note content version", async () => {
  const initial = await app.request(`/api/note-appearance/${NOTE_ID}`, { headers: headers() });
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { noteId: NOTE_ID, themeId: null });

  const before = db().prepare("SELECT content, version FROM notes WHERE id = ?").get(NOTE_ID) as {
    content: string;
    version: number;
  };

  const response = await app.request(`/api/note-appearance/${NOTE_ID}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ themeId: "paper" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json() as { noteId: string; themeId: string; updated: boolean };
  assert.equal(payload.themeId, "paper");
  assert.equal(payload.updated, true);

  const after = db().prepare("SELECT themeId, content, version FROM notes WHERE id = ?").get(NOTE_ID) as {
    themeId: string | null;
    content: string;
    version: number;
  };
  assert.equal(after.themeId, "paper");
  assert.equal(after.content, before.content);
  assert.equal(after.version, before.version);
});

test("explicit Nowen Default is distinct from following the account appearance setting", async () => {
  const explicitDefault = await app.request(`/api/note-appearance/${NOTE_ID}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ themeId: defaultThemeId }),
  });
  assert.equal(explicitDefault.status, 200);
  assert.equal(
    (db().prepare("SELECT themeId FROM notes WHERE id = ?").get(NOTE_ID) as { themeId: string | null }).themeId,
    "default",
  );

  const inherit = await app.request(`/api/note-appearance/${NOTE_ID}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ themeId: null }),
  });
  assert.equal(inherit.status, 200);
  assert.equal(
    (db().prepare("SELECT themeId FROM notes WHERE id = ?").get(NOTE_ID) as { themeId: string | null }).themeId,
    null,
  );
});

test("invalid appearance ids fail closed without changing note content or version", async () => {
  const before = db().prepare("SELECT content, version FROM notes WHERE id = ?").get(NOTE_ID) as {
    content: string;
    version: number;
  };
  const invalid = await app.request(`/api/note-appearance/${NOTE_ID}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ themeId: "https://evil.example/theme.css" }),
  });
  assert.equal(invalid.status, 400);
  const invalidPayload = await invalid.json() as { code: string };
  assert.equal(invalidPayload.code, "INVALID_THEME_ID");

  const after = db().prepare("SELECT content, version, themeId FROM notes WHERE id = ?").get(NOTE_ID) as {
    content: string;
    version: number;
    themeId: string | null;
  };
  assert.equal(after.content, before.content);
  assert.equal(after.version, before.version);
  assert.equal(after.themeId, null);
});

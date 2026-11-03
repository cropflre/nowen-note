import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  newUserOnboardingMigration,
  onboardingWelcomeNoteId,
} from "../src/db/newUserOnboardingMigration.js";
import { newUserOnboardingFirstLoginMigration } from "../src/db/newUserOnboardingFirstLoginMigration.js";
import { onboardingWelcomePresentationMigration } from "../src/db/onboardingWelcomePresentationMigration.js";
import { claimOnboardingWelcome } from "../src/lib/onboarding.js";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      displayName TEXT,
      lastLoginAt TEXT
    );

    CREATE TABLE notebooks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      parentId TEXT,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT DEFAULT '📒',
      sortOrder INTEGER DEFAULT 0,
      isExpanded INTEGER DEFAULT 1,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parentId) REFERENCES notebooks(id) ON DELETE CASCADE
    );

    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      notebookId TEXT NOT NULL,
      workspaceId TEXT,
      isTrashed INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      content TEXT DEFAULT '{}',
      contentText TEXT DEFAULT '',
      contentFormat TEXT DEFAULT 'tiptap-json',
      isPinned INTEGER DEFAULT 0,
      sortOrder INTEGER DEFAULT 0,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE
    );
  `);
  return db;
}

function installOnboarding(db: Database.Database): void {
  newUserOnboardingMigration.up(db);
  newUserOnboardingFirstLoginMigration.up(db);
}

function confirmLogin(db: Database.Database, userId: string): void {
  db.prepare("UPDATE users SET lastLoginAt = datetime('now') WHERE id = ?").run(userId);
}

test("seeds Chinese and English guides only on a new account's first confirmed login", () => {
  const db = createDb();
  try {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run("legacy-user", "legacy", "hash");

    installOnboarding(db);
    confirmLogin(db, "legacy-user");

    const legacyNotebookCount = db.prepare(
      "SELECT COUNT(*) AS count FROM notebooks WHERE userId = ?",
    ).get("legacy-user") as { count: number };
    assert.equal(legacyNotebookCount.count, 0, "existing users must not be backfilled");

    const userId = "new-user";
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run(userId, "new-user", "hash");

    const beforeLogin = db.prepare(
      "SELECT COUNT(*) AS count FROM notebooks WHERE userId = ?",
    ).get(userId) as { count: number };
    assert.equal(beforeLogin.count, 0, "raw user inserts must not pollute fixtures or maintenance flows");

    confirmLogin(db, userId);

    const onboardingState = db.prepare(`
      SELECT status FROM user_onboarding_state
      WHERE userId = ? AND version = 1
    `).get(userId) as { status: string } | undefined;
    assert.equal(onboardingState?.status, "seeded");

    const notebooks = db.prepare(`
      SELECT id, parentId, name, icon, sortOrder
      FROM notebooks
      WHERE userId = ?
      ORDER BY sortOrder ASC, name ASC
    `).all(userId) as Array<{
      id: string;
      parentId: string | null;
      name: string;
      icon: string;
      sortOrder: number;
    }>;
    assert.equal(notebooks.length, 3);

    const root = notebooks.find((notebook) => notebook.parentId === null);
    assert.ok(root);
    assert.equal(root.name, "Nowen Note 使用指南 / Guide");
    assert.equal(root.icon, "📘");

    const chinese = notebooks.find((notebook) => notebook.name === "中文指南");
    const english = notebooks.find((notebook) => notebook.name === "English Guide");
    assert.ok(chinese);
    assert.ok(english);
    assert.equal(chinese.parentId, root.id);
    assert.equal(english.parentId, root.id);

    const notes = db.prepare(`
      SELECT id, notebookId, title, content, contentText, contentFormat, isPinned, sortOrder
      FROM notes
      WHERE userId = ?
      ORDER BY notebookId ASC, sortOrder ASC
    `).all(userId) as Array<{
      id: string;
      notebookId: string;
      title: string;
      content: string;
      contentText: string;
      contentFormat: string;
      isPinned: number;
      sortOrder: number;
    }>;

    assert.equal(notes.length, 16);
    assert.equal(notes.filter((note) => note.notebookId === chinese.id).length, 8);
    assert.equal(notes.filter((note) => note.notebookId === english.id).length, 8);
    assert.ok(notes.every((note) => note.contentFormat === "markdown"));
    assert.ok(notes.every((note) => note.content.length > 100));
    assert.ok(notes.every((note) => note.contentText.length > 20));

    const chineseWelcome = notes.find((note) => note.id === onboardingWelcomeNoteId(userId));
    assert.ok(chineseWelcome);
    assert.equal(chineseWelcome.title, "欢迎使用 Nowen Note");
    assert.equal(chineseWelcome.isPinned, 1);
    assert.match(chineseWelcome.content, /删除后系统不会重新创建/);

    const englishWelcome = notes.find((note) => note.title === "Welcome to Nowen Note");
    assert.ok(englishWelcome);
    assert.equal(englishWelcome.isPinned, 1);
    assert.match(englishWelcome.content, /will not be recreated after deletion/);

    assert.equal(notes.some((note) => note.title === "项目启动会议纪要"), false);
    assert.equal(notes.some((note) => note.title === "周末计划"), false);
  } finally {
    db.close();
  }
});

test("deleting the guide does not recreate it on later logins", () => {
  const db = createDb();
  try {
    installOnboarding(db);
    const userId = "delete-guide-user";
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run(userId, "delete-guide-user", "hash");
    confirmLogin(db, userId);

    const root = db.prepare(`
      SELECT id FROM notebooks
      WHERE userId = ? AND parentId IS NULL
    `).get(userId) as { id: string };
    db.prepare("DELETE FROM notebooks WHERE id = ?").run(root.id);

    confirmLogin(db, userId);
    db.prepare("UPDATE users SET displayName = ? WHERE id = ?")
      .run("Updated", userId);

    const notebooks = db.prepare(
      "SELECT COUNT(*) AS count FROM notebooks WHERE userId = ?",
    ).get(userId) as { count: number };
    const notes = db.prepare(
      "SELECT COUNT(*) AS count FROM notes WHERE userId = ?",
    ).get(userId) as { count: number };
    const state = db.prepare(`
      SELECT status FROM user_onboarding_state
      WHERE userId = ? AND version = 1
    `).get(userId) as { status: string } | undefined;

    assert.equal(notebooks.count, 0);
    assert.equal(notes.count, 0);
    assert.equal(state?.status, "seeded");
  } finally {
    db.close();
  }
});

test("upgrades suppress the welcome for seeded users and never seed an established desktop identity", () => {
  const db = createDb();
  try {
    installOnboarding(db);
    const createUser = db.prepare(
      "INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')",
    );
    createUser.run("seeded-user", "seeded-user");
    confirmLogin(db, "seeded-user");
    createUser.run("pre-upgrade-desktop", "desktop");
    onboardingWelcomePresentationMigration.up(db);

    for (const userId of ["seeded-user", "pre-upgrade-desktop"]) {
      confirmLogin(db, userId);
      assert.equal(claimOnboardingWelcome(db, userId), null);
    }
    const counts = db.prepare("SELECT userId, COUNT(*) AS count FROM notes GROUP BY userId").all();
    assert.deepEqual(counts, [{ userId: "seeded-user", count: 16 }]);
  } finally {
    db.close();
  }
});

test("new accounts get exactly one welcome grant across devices", () => {
  const db = createDb();
  try {
    installOnboarding(db);
    onboardingWelcomePresentationMigration.up(db);
    const createUser = db.prepare(
      "INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')",
    );
    for (const userId of ["alice", "bob"]) createUser.run(userId, userId);
    confirmLogin(db, "alice");
    confirmLogin(db, "bob");
    db.prepare("UPDATE notes SET isTrashed = 1 WHERE id = ?").run(onboardingWelcomeNoteId("bob"));
    assert.equal(claimOnboardingWelcome(db, "bob"), null);
    assert.equal(claimOnboardingWelcome(db, "alice"), onboardingWelcomeNoteId("alice"));
    confirmLogin(db, "alice");
    assert.equal(claimOnboardingWelcome(db, "alice"), null);
    const counts = db.prepare("SELECT userId, COUNT(*) AS count FROM notes GROUP BY userId ORDER BY userId").all();
    assert.deepEqual(counts, [{ userId: "alice", count: 16 }, { userId: "bob", count: 16 }]);
  } finally {
    db.close();
  }
});

test("managed desktop bootstrap does not generate tutorial data on the next startup", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nowen-onboarding-"));
  process.env.DB_PATH = path.join(dir, "test.db");
  process.env.ELECTRON_USER_DATA = dir;
  process.env.ELECTRON_LOCAL_ACCOUNT_SECRET = "onboarding-test-desktop-secret";
  process.env.JWT_SECRET = "onboarding-test-jwt-secret";
  const [{ getDb, closeDb }, { default: auth }] = await Promise.all([
    import("../src/db/schema.js"),
    import("../src/routes/auth.js"),
  ]);
  try {
    const bootstrap = () => auth.request("/desktop/bootstrap-local", {
      method: "POST",
      headers: {
        "X-Nowen-Desktop-Secret": process.env.ELECTRON_LOCAL_ACCOUNT_SECRET!,
        "X-Nowen-Desktop-Allow-Create": "1",
      },
    });
    const first = await bootstrap();
    const second = await bootstrap();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const { user } = await second.json() as { user: { id: string } };
    const db = getDb();
    assert.equal(claimOnboardingWelcome(db, user.id), null);
    assert.deepEqual(db.prepare("SELECT id FROM notebooks WHERE userId = ?").all(user.id), []);
    assert.deepEqual(db.prepare("SELECT id FROM notes WHERE userId = ?").all(user.id), []);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

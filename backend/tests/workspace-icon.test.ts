import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  DEFAULT_WORKSPACE_ICON,
  normalizeWorkspaceIcon,
} from "../src/lib/workspace-icon";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-workspace-icon-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const OWNER_ID = "workspace-icon-owner";
const ADMIN_ID = "workspace-icon-admin";
const VIEWER_ID = "workspace-icon-viewer";

function db() {
  return getDb();
}

function seedUsers() {
  for (const id of [OWNER_ID, ADMIN_ID, VIEWER_ID]) {
    db().prepare(
      "INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)",
    ).run(id, id, "hash");
  }
}

function resetWorkspaces() {
  db().prepare("DELETE FROM workspace_invites").run();
  db().prepare("DELETE FROM workspace_members").run();
  db().prepare("DELETE FROM workspaces").run();
}

function seedWorkspace(icon = DEFAULT_WORKSPACE_ICON) {
  const id = "workspace-icon-test";
  db().prepare(
    "INSERT INTO workspaces (id, name, description, icon, ownerId) VALUES (?, ?, '', ?, ?)",
  ).run(id, "Emoji Team", icon, OWNER_ID);
  db().prepare(
    "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'owner')",
  ).run(id, OWNER_ID);
  db().prepare(
    "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'admin')",
  ).run(id, ADMIN_ID);
  db().prepare(
    "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'viewer')",
  ).run(id, VIEWER_ID);
  return id;
}

async function requestJson(userId: string, method: string, url: string, body?: unknown) {
  const response = await app.request(url, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}

test.before(async () => {
  const [workspacesModule, schemaModule] = await Promise.all([
    import("../src/routes/workspaces"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/workspaces", workspacesModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  seedUsers();
});

test.beforeEach(() => {
  resetWorkspaces();
});

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

test("workspace icon validator accepts one Emoji grapheme and defaults blank values", () => {
  assert.deepEqual(normalizeWorkspaceIcon(undefined), { ok: true, icon: DEFAULT_WORKSPACE_ICON });
  assert.deepEqual(normalizeWorkspaceIcon("   "), { ok: true, icon: DEFAULT_WORKSPACE_ICON });
  assert.equal(normalizeWorkspaceIcon("🚀").icon, "🚀");
  assert.equal(normalizeWorkspaceIcon("👨‍👩‍👧‍👦").icon, "👨‍👩‍👧‍👦");
  assert.equal(normalizeWorkspaceIcon("🇨🇳").icon, "🇨🇳");
  assert.equal(normalizeWorkspaceIcon("1️⃣").icon, "1️⃣");
});

test("workspace icon validator rejects text, URLs, HTML and multiple Emoji", () => {
  for (const value of ["team", "https://example.com/icon.png", "<svg>", "🚀🔥", "a\u0000b"]) {
    assert.equal(normalizeWorkspaceIcon(value).ok, false, value);
  }
});

test("creating a workspace stores the selected Emoji and defaults a missing icon", async () => {
  const selected = await requestJson(OWNER_ID, "POST", "/workspaces", {
    name: "Rocket Team",
    description: "Launch group",
    icon: "🚀",
  });
  assert.equal(selected.status, 201);
  assert.equal(selected.json.icon, "🚀");

  const fallback = await requestJson(OWNER_ID, "POST", "/workspaces", {
    name: "Default Team",
  });
  assert.equal(fallback.status, 201);
  assert.equal(fallback.json.icon, DEFAULT_WORKSPACE_ICON);
});

test("workspace admin can update the icon while viewer cannot", async () => {
  const workspaceId = seedWorkspace();
  const updated = await requestJson(ADMIN_ID, "PUT", `/workspaces/${workspaceId}`, { icon: "🎯" });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.icon, "🎯");

  const denied = await requestJson(VIEWER_ID, "PUT", `/workspaces/${workspaceId}`, { icon: "🌈" });
  assert.equal(denied.status, 403);
  const row = db().prepare("SELECT icon FROM workspaces WHERE id = ?").get(workspaceId) as { icon: string };
  assert.equal(row.icon, "🎯");
});

test("invalid updates are rejected and historical blank icons read as the default", async () => {
  const workspaceId = seedWorkspace("");
  const listed = await requestJson(OWNER_ID, "GET", "/workspaces");
  assert.equal(listed.status, 200);
  assert.equal(listed.json[0].icon, DEFAULT_WORKSPACE_ICON);

  const invalid = await requestJson(OWNER_ID, "PUT", `/workspaces/${workspaceId}`, { icon: "<script>" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, "INVALID_WORKSPACE_ICON");
});

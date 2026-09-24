import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { collectSharedMindMapSnapshots, extractSharedMindMapIds } from "../src/services/sharedMindMapSnapshots.js";

const OWNER = "owner";
const OTHER = "other";
const VIEWER = "viewer";
const PERSONAL_MAP = "11111111-1111-4111-8111-111111111111";
const OTHER_MAP = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_MAP = "33333333-3333-4333-8333-333333333333";
const CROSS_WORKSPACE_MAP = "44444444-4444-4444-8444-444444444444";

function createDb() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE mindmaps (id TEXT PRIMARY KEY, userId TEXT NOT NULL, workspaceId TEXT, title TEXT NOT NULL, data TEXT NOT NULL, updatedAt TEXT NOT NULL); CREATE TABLE workspace_members (workspaceId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (workspaceId, userId));");
  return db;
}

function data(text: string) {
  return JSON.stringify({ root: { id: "root", text, children: [{ id: "child", text: "child", children: [] }] } });
}

test("extractSharedMindMapIds supports Markdown/Tiptap and ignores fenced examples", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const markdown = ["before ![[mindmap:" + PERSONAL_MAP + "]]", fence + "markdown", "![[mindmap:" + OTHER_MAP + "]]", fence].join("\n");
  assert.deepEqual(extractSharedMindMapIds(markdown, "markdown"), [PERSONAL_MAP]);
  const tiptap = JSON.stringify({ type: "doc", content: [{ type: "blockEmbed", attrs: { href: "mindmap:" + OTHER_MAP } }] });
  assert.deepEqual(extractSharedMindMapIds(tiptap, "tiptap-json"), [OTHER_MAP]);
});

test("personal shared note only exposes maps owned by the note owner in personal scope", () => {
  const db = createDb();
  try {
    const insert = db.prepare("INSERT INTO mindmaps (id, userId, workspaceId, title, data, updatedAt) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run(PERSONAL_MAP, OWNER, null, "Owner map", data("owner"), "2026-09-24 10:00:00");
    insert.run(OTHER_MAP, OTHER, null, "Other map", data("other"), "2026-09-24 10:00:00");
    const snapshots = collectSharedMindMapSnapshots(db, { content: "![[mindmap:" + PERSONAL_MAP + "]]\n\n![[mindmap:" + OTHER_MAP + "]]", contentFormat: "markdown", noteOwnerId: OWNER, noteWorkspaceId: null });
    assert.deepEqual(Object.keys(snapshots), [PERSONAL_MAP]);
    assert.equal(snapshots[PERSONAL_MAP]?.title, "Owner map");
    assert.equal(snapshots[PERSONAL_MAP]?.data, data("owner"));
  } finally { db.close(); }
});

test("workspace shared note exposes same-workspace maps only while owner remains a member", () => {
  const db = createDb();
  try {
    db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run("ws-a", OWNER, "editor");
    db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run("ws-a", VIEWER, "viewer");
    const insert = db.prepare("INSERT INTO mindmaps (id, userId, workspaceId, title, data, updatedAt) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run(WORKSPACE_MAP, OTHER, "ws-a", "Team map", data("team"), "2026-09-24 10:00:00");
    insert.run(CROSS_WORKSPACE_MAP, OTHER, "ws-b", "Other workspace", data("cross"), "2026-09-24 10:00:00");
    const content = "![[mindmap:" + WORKSPACE_MAP + "]]\n![[mindmap:" + CROSS_WORKSPACE_MAP + "]]";
    const visible = collectSharedMindMapSnapshots(db, { content, contentFormat: "markdown", noteOwnerId: OWNER, noteWorkspaceId: "ws-a" });
    assert.deepEqual(Object.keys(visible), [WORKSPACE_MAP]);
    db.prepare("DELETE FROM workspace_members WHERE workspaceId = ? AND userId = ?").run("ws-a", OWNER);
    const revoked = collectSharedMindMapSnapshots(db, { content, contentFormat: "markdown", noteOwnerId: OWNER, noteWorkspaceId: "ws-a" });
    assert.deepEqual(revoked, {});
  } finally { db.close(); }
});

test("oversized or malformed map payloads are not exposed", () => {
  const db = createDb();
  try {
    const insert = db.prepare("INSERT INTO mindmaps (id, userId, workspaceId, title, data, updatedAt) VALUES (?, ?, NULL, ?, ?, ?)");
    insert.run(PERSONAL_MAP, OWNER, "Broken", "{bad json", "2026-09-24 10:00:00");
    insert.run(OTHER_MAP, OWNER, "Huge", data("x".repeat(600 * 1024)), "2026-09-24 10:00:00");
    const snapshots = collectSharedMindMapSnapshots(db, { content: "![[mindmap:" + PERSONAL_MAP + "]]\n![[mindmap:" + OTHER_MAP + "]]", contentFormat: "markdown", noteOwnerId: OWNER, noteWorkspaceId: null });
    assert.deepEqual(snapshots, {});
  } finally { db.close(); }
});
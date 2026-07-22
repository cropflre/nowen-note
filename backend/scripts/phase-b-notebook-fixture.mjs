import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const [key, value = "true"] = entry.replace(/^--/, "").split("=");
  return [key, value];
}));

const dbPath = fs.realpathSync(path.resolve(process.env.DB_PATH || ""));
const tempRoots = [os.tmpdir(), "/tmp"].map((root) => fs.realpathSync(root) + path.sep);
if (!tempRoots.some((root) => dbPath.startsWith(root)) || !dbPath.includes("phase-b")) {
  throw new Error("Phase B fixture refuses to use a database outside a phase-b temporary path");
}

const count = Number(args.count || 10);
const shape = args.shape === "four-level" ? "four-level" : "roots";
const expansion = args.expansion === "current-path" ? "current-path" : "all";
const scope = args.scope === "team" ? "team" : "personal";
const withNotes = args.notes === "on";
if (![10, 100, 500, 1000].includes(count)) throw new Error(`Unsupported count: ${count}`);

const db = new Database(dbPath);
const user = db.prepare("SELECT id FROM users WHERE username = ?").get("phaseb");
if (!user) throw new Error("Run seed-demo for the phaseb user first");

const workspaceId = "phase-b-workspace";
const reset = db.transaction(() => {
  db.prepare("DELETE FROM notes WHERE userId = ?").run(user.id);
  db.prepare("DELETE FROM notebooks WHERE userId = ? OR workspaceId = ?").run(user.id, workspaceId);
  db.prepare(`INSERT INTO workspaces (id, name, icon, ownerId)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET ownerId = excluded.ownerId`).run(workspaceId, "Phase B Team", "🏢", user.id);
  db.prepare(`INSERT INTO workspace_members (workspaceId, userId, role)
    VALUES (?, ?, 'owner')
    ON CONFLICT(workspaceId, userId) DO UPDATE SET role = 'owner'`).run(workspaceId, user.id);

  const insertNotebook = db.prepare(`INSERT INTO notebooks
    (id, userId, workspaceId, parentId, name, icon, sortOrder, isExpanded)
    VALUES (?, ?, ?, ?, ?, '📒', ?, ?)`);
  const insertNote = db.prepare(`INSERT INTO notes
    (id, userId, workspaceId, notebookId, title, content, contentText, sortOrder)
    VALUES (?, ?, ?, ?, ?, '{}', ?, 0)`);

  for (let index = 0; index < count; index += 1) {
    const depth = shape === "four-level" ? index % 4 : 0;
    const parentIndex = depth === 0 ? null : index - 1;
    const id = `phase-b-${scope}-nb-${index.toString().padStart(4, "0")}`;
    const parentId = parentIndex === null
      ? null
      : `phase-b-${scope}-nb-${parentIndex.toString().padStart(4, "0")}`;
    const isExpanded = expansion === "all" || index < 4 ? 1 : 0;
    insertNotebook.run(
      id,
      user.id,
      scope === "team" ? workspaceId : null,
      parentId,
      `Phase B Notebook ${index}`,
      index,
      isExpanded,
    );
    if (withNotes) {
      insertNote.run(
        `phase-b-${scope}-note-${index.toString().padStart(4, "0")}`,
        user.id,
        scope === "team" ? workspaceId : null,
        id,
        `Phase B Note ${index}`,
        `Notebook ${index} note`,
      );
    }
  }
});

reset();
db.close();
console.log(JSON.stringify({ dbPath, count, shape, expansion, scope, withNotes }));

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-siyuan-tag-invariants-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const USER_ID = "siyuan-tag-user";
const WORKSPACE_ID = "siyuan-tag-workspace";
const NOTEBOOK_ID = "siyuan-tag-notebook";
const PERSONAL_TAG_ID = "existing-personal-tag";

let closeDb: () => void;
let getDb: () => import("better-sqlite3").Database;
let importSiyuanPackageFromZipFile: typeof import("../src/services/siyuanPackageImport").importSiyuanPackageFromZipFile;

function paragraph(children: any[]) {
  return { Type: "NodeParagraph", Children: children };
}

function text(value: string) {
  return { Type: "NodeText", Data: value };
}

function tag(value: string) {
  return {
    Type: "NodeTextMark",
    TextMarkType: "tag",
    TextMarkTextContent: value,
  };
}

function syDoc(title: string, children: any[]) {
  return {
    ID: "tag-invariant-doc",
    Type: "NodeDocument",
    Properties: { title },
    Children: children,
  };
}

async function writeZip(name: string, files: Record<string, string>) {
  const zip = new JSZip();
  for (const [filePath, content] of Object.entries(files)) zip.file(filePath, content);
  const zipPath = path.join(tmpDir, name);
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
  return zipPath;
}

test.before(async () => {
  const [serviceModule, schemaModule] = await Promise.all([
    import("../src/services/siyuanPackageImport"),
    import("../src/db/schema"),
  ]);
  importSiyuanPackageFromZipFile = serviceModule.importSiyuanPackageFromZipFile;
  closeDb = schemaModule.closeDb;
  getDb = schemaModule.getDb;

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run(WORKSPACE_ID, "Tag workspace", USER_ID);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run(WORKSPACE_ID, USER_ID, "editor");
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name, icon, workspaceId) VALUES (?, ?, NULL, ?, ?, ?)")
    .run(NOTEBOOK_ID, USER_ID, "Imported", "📥", WORKSPACE_ID);
  db.prepare("INSERT INTO tags (id, userId, name, color, workspaceId) VALUES (?, ?, ?, ?, NULL)")
    .run(PERSONAL_TAG_ID, USER_ID, "共同", "#58a6ff");
});

test.after(async () => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("removes cross-space tag links and newly-created invalid tags", async () => {
  const longTag = "超长标签".repeat(8);
  assert.ok(longTag.length > 30);

  const zipPath = await writeZip("tag-invariants.zip", {
    "tag-doc.sy": JSON.stringify(syDoc("标签边界", [
      paragraph([
        text("tags "),
        tag("共同"),
        text(" "),
        tag("新增"),
        text(" "),
        tag(longTag),
      ]),
    ])),
  });

  const result = await importSiyuanPackageFromZipFile(zipPath, {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    targetNotebookId: NOTEBOOK_ID,
    contentFormat: "markdown",
  });

  assert.equal(result.success, true);
  assert.equal(result.count, 1);
  const noteId = result.notes[0]?.id;
  assert.ok(noteId);

  const db = getDb();
  const links = db.prepare(`
    SELECT t.id, t.name, t.workspaceId
    FROM note_tags nt
    JOIN tags t ON t.id = nt.tagId
    WHERE nt.noteId = ?
    ORDER BY t.name
  `).all(noteId) as Array<{ id: string; name: string; workspaceId: string | null }>;

  assert.deepEqual(links.map((row) => row.name), ["新增"]);
  assert.equal(links[0]?.workspaceId, WORKSPACE_ID);

  const personalTag = db.prepare("SELECT id, workspaceId FROM tags WHERE id = ?")
    .get(PERSONAL_TAG_ID) as { id: string; workspaceId: string | null } | undefined;
  assert.deepEqual(personalTag, { id: PERSONAL_TAG_ID, workspaceId: null });

  const invalidTagCount = db.prepare("SELECT COUNT(*) AS count FROM tags WHERE userId = ? AND name = ?")
    .get(USER_ID, longTag) as { count: number };
  assert.equal(invalidTagCount.count, 0);

  assert.ok(result.warnings.some((warning) => warning.includes("another space") && warning.includes("共同")));
  assert.ok(result.warnings.some((warning) => warning.includes("exceeds 30") && warning.includes("超长标签")));
});

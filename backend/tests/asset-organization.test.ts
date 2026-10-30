import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-assets-c-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
let app: Hono;
let schema: typeof import("../src/db/schema");
function req(url: string, method = "GET", body?: unknown, userId = "c-owner") {
  return app.request(`/api/files${url.replace("/?", "?")}`, {
    method,
    headers: { "X-User-Id": userId, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(response: Promise<Response>, status = 200) {
  const value = await response;
  assert.equal(value.status, status, await value.clone().text());
  return value.json() as Promise<any>;
}
test.before(async () => {
  schema = await import("../src/db/schema");
  const { default: files } = await import("../src/routes/files");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree");
  app = new Hono().route("/api/files", wrapKnowledgeRoute("/api/files", files));
  const db = schema.getDb();
  for (const id of ["c-owner", "c-other", "c-viewer"])
    db.prepare(
      "INSERT INTO users (id,username,passwordHash) VALUES (?,?,'hash')",
    ).run(id, id);
  db.prepare(
    "INSERT INTO workspaces (id,name,ownerId) VALUES ('c-team','Team','c-owner')",
  ).run();
  for (const [id, role] of [
    ["c-owner", "owner"],
    ["c-viewer", "viewer"],
  ])
    db.prepare(
      "INSERT INTO workspace_members (workspaceId,userId,role) VALUES ('c-team',?,?)",
    ).run(id, role);
  db.prepare(
    "INSERT INTO notebooks (id,userId,name) VALUES ('c-book','c-owner','Notes')",
  ).run();
  for (const id of ["c-holder", "c-reference", "c-reference2"])
    db.prepare(
      "INSERT INTO notes (id,userId,notebookId,title,content) VALUES (?,'c-owner','c-book',?,'')",
    ).run(id, id);
  const insert =
    db.prepare(`INSERT INTO attachments (id,userId,noteId,filename,mimeType,size,path,hash,uploadSource,workspaceId,createdAt)
    VALUES (?,?,'c-holder',?,'image/png',?,?,?,'file_manager',?,'2026-10-14 00:00:00')`);
  for (const [id, user, hash, size, ws] of [
    ["c-file", "c-owner", "same-hash", 200, null],
    ["c-duplicate", "c-owner", "same-hash", 200, null],
    ["c-private", "c-other", "same-hash", 200, null],
    ["c-large", "c-owner", "other-hash", 20000, null],
    ["c-work", "c-owner", "team-hash", 10, "c-team"],
  ] as const)
    insert.run(id, user, `${id}.png`, size, `${id}.png`, hash, ws);
  db.prepare(
    "INSERT INTO attachment_references (attachmentId,noteId) VALUES ('c-file','c-reference'),('c-file','c-reference2')",
  ).run();
});
test.after(() => {
  schema?.closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("scoped tag uniqueness, viewer rejection and atomic batch tagging preserve asset identity", async () => {
  const tag = (
    await json(req("/organization/tags", "POST", { name: "  Design  " }), 201)
  ).tag;
  await json(req("/organization/tags", "POST", { name: "design" }), 409);
  const other = (
    await json(
      req("/organization/tags", "POST", { name: "Design" }, "c-other"),
      201,
    )
  ).tag;
  const team = (
    await json(
      req("/organization/tags?workspaceId=c-team", "POST", { name: "Design" }),
      201,
    )
  ).tag;
  await json(
    req("/organization?workspaceId=c-team", "GET", undefined, "c-other"),
    403,
  );
  await json(
    req(
      "/organization/tags?workspaceId=c-team",
      "POST",
      { name: "No" },
      "c-viewer",
    ),
    403,
  );
  const before = schema
    .getDb()
    .prepare("SELECT * FROM attachments WHERE id='c-file'")
    .get();
  await json(
    req("/organization/tag-files", "POST", {
      ids: ["c-file", "c-large"],
      tagIds: [tag.id],
      operation: "add",
    }),
  );
  await json(
    req("/organization/tag-files", "POST", {
      ids: ["c-duplicate", "c-private"],
      tagIds: [tag.id],
      operation: "add",
    }),
    403,
  );
  assert.equal(
    (await json(req("/organization/assets/c-duplicate"))).tags.length,
    0,
  );
  await json(
    req("/organization/tag-files", "POST", {
      ids: ["c-file"],
      tagIds: [other.id],
      operation: "add",
    }),
    404,
  );
  await json(
    req("/organization/tag-files?workspaceId=c-team", "POST", {
      ids: ["c-file"],
      tagIds: [team.id],
      operation: "add",
    }),
    409,
  );
  assert.deepEqual(
    schema.getDb().prepare("SELECT * FROM attachments WHERE id='c-file'").get(),
    before,
  );
  const list = await json(req(`/?tagIds=${tag.id}&pageSize=1`));
  assert.equal(list.total, 2);
  assert.equal(list.items.length, 1);
  const combined = await json(req(`/?tagIds=${tag.id}&minSize=1000`));
  assert.deepEqual(
    combined.items.map((f: any) => f.id),
    ["c-large"],
  );
  await json(
    req(`/organization/tags/${tag.id}`, "PATCH", {
      name: "Renamed",
      color: "#123456",
    }),
  );
  assert.equal(
    (await json(req("/organization/assets/c-file"))).tags[0].name,
    "Renamed",
  );
  await json(req(`/organization/tags/${tag.id}`, "DELETE"));
  assert.equal((await json(req("/organization/assets/c-file"))).tags.length, 0);
  assert.deepEqual(
    schema.getDb().prepare("SELECT * FROM attachments WHERE id='c-file'").get(),
    before,
  );
});

test("smart folders persist whitelisted filters without moving files and stay private to their owner", async () => {
  const before = schema
    .getDb()
    .prepare("SELECT id,folderId,path,noteId FROM attachments ORDER BY id")
    .all();
  const filters = {
    category: "image",
    minSize: 100,
    maxSize: 1000,
    referenceState: "multiple",
  };
  const saved = (
    await json(
      req("/organization/smart-folders", "POST", {
        name: "Used images",
        filters,
      }),
      201,
    )
  ).smartFolder;
  const state = await json(req("/organization"));
  assert.deepEqual(
    state.smartFolders.find((item: any) => item.id === saved.id).filters,
    filters,
  );
  assert.equal(
    (await json(req("/organization", "GET", undefined, "c-other"))).smartFolders
      .length,
    0,
  );
  await json(
    req(
      `/organization/smart-folders/${saved.id}`,
      "DELETE",
      undefined,
      "c-other",
    ),
    404,
  );
  await json(
    req("/organization/smart-folders", "POST", {
      name: "bad",
      filters: { sql: "DROP TABLE attachments" },
    }),
    400,
  );
  await json(
    req("/organization/smart-folders", "POST", {
      name: "bad",
      filters: { minSize: 100, maxSize: 1 },
    }),
    400,
  );
  await json(
    req(`/organization/smart-folders/${saved.id}`, "PATCH", {
      name: "Shared use",
      filters: { referenceState: "referenced" },
    }),
  );
  schema.closeDb();
  assert.equal(
    (await json(req("/organization"))).smartFolders[0].name,
    "Shared use",
  );
  assert.deepEqual(
    schema
      .getDb()
      .prepare("SELECT id,folderId,path,noteId FROM attachments ORDER BY id")
      .all(),
    before,
  );
  await json(req(`/organization/smart-folders/${saved.id}`, "DELETE"));
});

test("attribute and duplicate filters run before pagination and disclose only readable scoped files", async () => {
  const duplicates = await json(req("/?duplicateOnly=true&pageSize=1"));
  assert.equal(duplicates.total, 2);
  assert.equal(duplicates.items.length, 1);
  const metadata = await json(req("/organization/assets/c-file"));
  assert.deepEqual(
    metadata.duplicates.map((item: any) => item.id),
    ["c-duplicate"],
  );
  await json(
    req("/organization/assets/c-file", "GET", undefined, "c-other"),
    404,
  );
  assert.deepEqual(
    (await json(req("/?referenceState=multiple"))).items.map((f: any) => f.id),
    ["c-file"],
  );
  assert.equal((await json(req("/?referenceState=unreferenced"))).total, 2);
  assert.equal(
    (await json(req("/?minSize=1000&maxSize=30000&createdBefore=2026-10-15")))
      .total,
    1,
  );
  for (const query of [
    "minSize=-1",
    "maxSize=NaN",
    "recentDays=0",
    "duplicateOnly=sql",
    "tagIds=a%27%29--",
    "createdBefore=invalid",
    "referenceState=any",
    "minSize=200&maxSize=1",
  ])
    await json(req(`/?${query}`), 400);
});

test("migration is idempotent, relation constraints reject cross-scope rows and snapshots retain metadata", async () => {
  const { assetOrganizationMigration } =
    await import("../src/db/assetOrganizationMigration");
  const db = schema.getDb();
  assetOrganizationMigration.up(db);
  const tag = (
    await json(req("/organization/tags", "POST", { name: "Snapshot" }), 201)
  ).tag;
  await json(
    req("/organization/tag-files", "POST", {
      ids: ["c-file"],
      tagIds: [tag.id],
      operation: "add",
    }),
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO asset_tag_relations (attachmentId,tagId) VALUES ('c-work',?)",
        )
        .run(tag.id),
    /SCOPE/,
  );
  const snapshot = path.join(directory, "snapshot.db");
  await db.backup(snapshot);
  const { default: Database } = await import("better-sqlite3");
  const copy = new Database(snapshot);
  assert.equal(
    (copy.prepare("SELECT COUNT(*) AS n FROM asset_tag_relations").get() as any)
      .n,
    1,
  );
  copy.close();
  db.prepare(
    "UPDATE attachments SET workspaceId='c-team' WHERE id='c-file'",
  ).run();
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM asset_tag_relations WHERE attachmentId='c-file'",
        )
        .get() as any
    ).n,
    0,
  );
});

test("upgrading an old database preserves attachments and an interrupted migration rolls back", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { assetOrganizationMigration } =
    await import("../src/db/assetOrganizationMigration");
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE workspaces(id TEXT PRIMARY KEY);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,userId TEXT,workspaceId TEXT,path TEXT);
    INSERT INTO users VALUES ('old-user');INSERT INTO attachments VALUES ('old-id','old-user',NULL,'2025/01/original.png');`);
  const before = db.prepare("SELECT * FROM attachments").all();
  assert.throws(
    () =>
      db.transaction(() => {
        assetOrganizationMigration.up(db);
        throw new Error("simulated migration interruption");
      })(),
    /interruption/,
  );
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='asset_tags'").get(),
    undefined,
  );
  assert.deepEqual(db.prepare("SELECT * FROM attachments").all(), before);
  db.transaction(() => assetOrganizationMigration.up(db))();
  assetOrganizationMigration.up(db);
  assert.deepEqual(db.prepare("SELECT * FROM attachments").all(), before);
  db.close();
});

test("metadata search is paginated and invalid mutation bodies leave files intact", async () => {
  const db = schema.getDb();
  const insert = db.prepare(
    "INSERT INTO asset_tags (id,userId,name,normalizedName) VALUES (?,'c-owner',?,?)",
  );
  db.transaction(() => {
    for (let i = 0; i < 205; i++)
      insert.run(
        `page-tag-${i}`,
        `PageTag ${i}`,
        `pagetag ${String(i).padStart(3, "0")}`,
      );
  })();
  const first = await json(req("/organization?q=PageTag"));
  assert.equal(first.tags.length, 200);
  assert.equal(first.hasMoreTags, true);
  const second = await json(req("/organization?q=PageTag&tagPage=2"));
  assert.equal(second.tags.length, 5);
  assert.equal(second.hasMoreTags, false);
  assert.equal(
    new Set([...first.tags, ...second.tags].map((tag: any) => tag.id)).size,
    205,
  );
  const count = db.prepare("SELECT COUNT(*) AS n FROM attachments").get();
  for (const body of [null, [], { name: 1 }])
    await json(req("/organization/tags", "POST", body), 400);
  await json(req("/organization?tagPage=-1"), 400);
  assert.deepEqual(
    db.prepare("SELECT COUNT(*) AS n FROM attachments").get(),
    count,
  );
});

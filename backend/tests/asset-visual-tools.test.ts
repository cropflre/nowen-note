import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { Hono } from "hono";

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "nowen-assets-visual-"),
);
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
let app: Hono;
let schema: typeof import("../src/db/schema");
let storage: typeof import("../src/services/attachment-storage");
function req(url: string, method = "GET", body?: unknown, user = "v-owner") {
  return app.request(`/api/files/tools${url}`, {
    method,
    headers: { "X-User-Id": user, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function result(response: Promise<Response>, status = 200) {
  const res = await response;
  assert.equal(res.status, status, await res.clone().text());
  return res.json() as Promise<any>;
}
test.before(async () => {
  schema = await import("../src/db/schema");
  storage = await import("../src/services/attachment-storage");
  const { default: files } = await import("../src/routes/files");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree");
  app = new Hono().route("/api/files", wrapKnowledgeRoute("/api/files", files));
  const db = schema.getDb();
  for (const id of ["v-owner", "v-other", "v-viewer"])
    db.prepare(
      "INSERT INTO users (id,username,passwordHash) VALUES (?,?,'hash')",
    ).run(id, id);
  db.prepare(
    "INSERT INTO notebooks (id,userId,name) VALUES ('v-book','v-owner','Notes')",
  ).run();
  db.prepare(
    "INSERT INTO notes (id,userId,notebookId,title) VALUES ('v-note','v-owner','v-book','Reference')",
  ).run();
  db.prepare(
    "INSERT INTO workspaces (id,name,ownerId) VALUES ('v-team','Team','v-owner')",
  ).run();
  for (const [user, role] of [
    ["v-owner", "owner"],
    ["v-viewer", "viewer"],
  ])
    db.prepare(
      "INSERT INTO workspace_members (workspaceId,userId,role) VALUES ('v-team',?,?)",
    ).run(user, role);
  const original = await sharp(
    Buffer.from(
      '<svg width="128" height="96"><rect width="128" height="96" fill="#b7d5e9"/><rect x="20" y="10" width="70" height="50" fill="#284760"/><circle cx="94" cy="70" r="18" fill="#e28343"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  const insert = db.prepare(
    "INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,path,hash,uploadSource,workspaceId) VALUES (?,'v-note',?,?,'image/png',?,?,?,'file_manager',?)",
  );
  for (const [id, bytes, user, workspace] of [
    ["a-anchor", original, "v-owner", null],
    [
      "b-resized",
      await sharp(original).resize(64, 48).png().toBuffer(),
      "v-owner",
      null,
    ],
    [
      "c-unrelated",
      await sharp({
        create: { width: 64, height: 48, channels: 3, background: "#ed1743" },
      })
        .png()
        .toBuffer(),
      "v-owner",
      null,
    ],
    ["d-broken", Buffer.from("not an image"), "v-owner", null],
    ["e-hidden", original, "v-other", null],
    ["f-work", original, "v-owner", "v-team"],
    ["g-trash", original, "v-owner", null],
  ] as const) {
    await storage.writeAttachmentObject(`${id}.png`, bytes, "image/png");
    insert.run(id, user, `${id}.png`, bytes.length, `${id}.png`, id, workspace);
  }
  db.prepare(
    "UPDATE attachments SET trashedAt=datetime('now') WHERE id='g-trash'",
  ).run();
  db.prepare(
    "INSERT INTO attachment_references (attachmentId,noteId) VALUES ('a-anchor','v-note')",
  ).run();
});
test.after(() => {
  schema?.closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("visual search finds resized bytes, skips corruption and never exposes other scopes or trash", async () => {
  const before = schema
    .getDb()
    .prepare("SELECT * FROM attachments ORDER BY id")
    .all();
  const payload = await result(req("/similar/a-anchor"));
  assert.deepEqual(
    payload.matches.map((item: any) => item.id),
    ["b-resized"],
  );
  assert.equal(payload.examined, 3);
  assert.equal(payload.skipped, 1);
  assert.equal(payload.nextAfter, null);
  assert.ok(payload.accessUrls["b-resized"]);
  assert.equal(JSON.stringify(payload).includes("e-hidden"), false);
  assert.deepEqual(
    schema.getDb().prepare("SELECT * FROM attachments ORDER BY id").all(),
    before,
  );
  assert.equal(
    (await storage.readAttachmentObject("a-anchor.png"))!.length,
    (await storage.readAttachmentObject("g-trash.png"))!.length,
  );
});
test("visual search rejects foreign anchors, scope forgery, nonmembers and unreadable files", async () => {
  await result(req("/similar/e-hidden"), 404);
  await result(req("/similar/g-trash"), 404);
  await result(req("/similar/f-work"), 409);
  await result(
    req("/similar/f-work?workspaceId=v-team", "GET", undefined, "v-other"),
    403,
  );
  await result(req("/similar/d-broken"), 422);
  await result(req("/similar/a-anchor?after=bad%2Fcursor"), 400);
  const team = await result(
    req("/similar/f-work?workspaceId=v-team", "GET", undefined, "v-viewer"),
  );
  assert.deepEqual(team.matches, []);
  schema
    .getDb()
    .prepare(
      "INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,path,uploadSource) VALUES ('v-large','v-note','v-owner','large.png','image/png',22000000,'missing.png','file_manager'),('v-svg','v-note','v-owner','vector.svg','image/svg+xml',1,'missing.svg','file_manager')",
    )
    .run();
  await result(req("/similar/v-large"), 422);
  await result(req("/similar/v-svg"), 422);
  schema
    .getDb()
    .prepare("DELETE FROM attachments WHERE id IN ('v-large','v-svg')")
    .run();
});
test("visual search pages all authorized candidates without repeating or skipping IDs", async () => {
  const db = schema.getDb();
  for (let index = 0; index < 43; index++)
    db.prepare(
      "INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,path,hash,uploadSource) SELECT ?,noteId,userId,?,mimeType,size,path,?,uploadSource FROM attachments WHERE id='b-resized'",
    ).run(
      `p-${String(index).padStart(3, "0")}`,
      `page-${index}.png`,
      `p-${index}`,
    );
  const matches: string[] = [];
  let after: string | null = null;
  let examined = 0;
  do {
    const payload = await result(
      req(`/similar/a-anchor${after ? `?after=${after}` : ""}`),
    );
    matches.push(...payload.matches.map((item: any) => item.id));
    examined += payload.examined;
    after = payload.nextAfter;
  } while (after);
  assert.equal(examined, 46);
  assert.equal(matches.length, 44);
  assert.equal(new Set(matches).size, 44);
});
test("batch rename is atomic, checks original names and preserves bytes, identity and references", async () => {
  const db = schema.getDb();
  const before = db
    .prepare("SELECT * FROM attachments WHERE id='a-anchor'")
    .get() as any;
  const item = {
    id: "a-anchor",
    expectedFilename: before.filename,
    filename: "Reference-001.png",
  };
  await result(
    req("/batch-rename", "POST", {
      items: [
        item,
        {
          id: "e-hidden",
          expectedFilename: "e-hidden.png",
          filename: "Reference-002.png",
        },
      ],
    }),
    403,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM attachments WHERE id='a-anchor'").get(),
    before,
  );
  await result(
    req("/batch-rename", "POST", {
      items: [{ ...item, expectedFilename: "outdated.png" }],
    }),
    409,
  );
  await result(
    req("/batch-rename", "POST", {
      items: [{ ...item, filename: "unsafe/part.png" }],
    }),
    400,
  );
  await result(
    req("/batch-rename", "POST", {
      items: [{ ...item, filename: "changed.exe" }],
    }),
    400,
  );
  await result(req("/batch-rename", "POST", { items: [item, item] }), 400);
  const payload = await result(req("/batch-rename", "POST", { items: [item] }));
  assert.equal(payload.renamed, 1);
  assert.deepEqual(
    db.prepare("SELECT * FROM attachments WHERE id='a-anchor'").get(),
    { ...before, filename: item.filename },
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM attachment_references WHERE attachmentId='a-anchor'",
        )
        .get() as any
    ).n,
    1,
  );
  await result(req("/batch-rename", "POST", { items: [item] }), 409);
});
test("batch rename rejects cross-scope, read-only and trashed rows without partial writes", async () => {
  const item = {
    id: "f-work",
    expectedFilename: "f-work.png",
    filename: "Team-001.png",
  };
  await result(req("/batch-rename", "POST", { items: [item] }), 409);
  await result(
    req(
      "/batch-rename?workspaceId=v-team",
      "POST",
      { items: [item] },
      "v-viewer",
    ),
    403,
  );
  await result(
    req("/batch-rename", "POST", {
      items: [
        {
          id: "g-trash",
          expectedFilename: "g-trash.png",
          filename: "Trash.png",
        },
      ],
    }),
    404,
  );
  const before = schema
    .getDb()
    .prepare("SELECT filename FROM attachments WHERE id='f-work'")
    .get();
  schema
    .getDb()
    .exec(
      "CREATE TEMP TRIGGER fail_visual_rename BEFORE UPDATE OF filename ON attachments WHEN NEW.id='f-work' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    );
  await result(
    req("/batch-rename?workspaceId=v-team", "POST", { items: [item] }),
    500,
  );
  assert.deepEqual(
    schema
      .getDb()
      .prepare("SELECT filename FROM attachments WHERE id='f-work'")
      .get(),
    before,
  );
});

test("batch rename captures existing attachment mutations atomically and rolls back names and Outbox on failure", async () => {
  const db = schema.getDb();
  const { createProfile, switchActiveProfile } =
    await import("../src/sync/profile");
  const { ensureDevice } = await import("../src/sync/device");
  const profile = createProfile(db, {
    name: "Visual tools",
    serverUrl: "http://visual-sync.test",
  });
  switchActiveProfile(db, profile.id);
  db.prepare(
    "UPDATE sync_profiles SET remoteUserId='v-owner',bootstrapStatus='ready' WHERE id=?",
  ).run(profile.id);
  ensureDevice(db, { profileId: profile.id });
  const rows = db
    .prepare(
      "SELECT id,filename FROM attachments WHERE id IN ('a-anchor','b-resized') ORDER BY id",
    )
    .all() as Array<{ id: string; filename: string }>;
  const items = rows.map((row, index) => ({
    id: row.id,
    expectedFilename: row.filename,
    filename: `Sync-${index}.png`,
  }));
  await result(req("/batch-rename", "POST", { items }));
  const outbox = db
    .prepare(
      "SELECT entityId,payload FROM sync_outbox WHERE entityType='attachment' ORDER BY entityId",
    )
    .all() as Array<{ entityId: string; payload: string }>;
  assert.deepEqual(
    outbox.map((row) => row.entityId),
    rows.map((row) => row.id),
  );
  assert.deepEqual(
    outbox.map((row) => JSON.parse(row.payload).filename),
    items.map((row) => row.filename),
  );
  const beforeNames = db
    .prepare("SELECT id,filename FROM attachments ORDER BY id")
    .all();
  const beforeOutbox = db
    .prepare("SELECT * FROM sync_outbox ORDER BY id")
    .all();
  db.exec(
    "CREATE TEMP TRIGGER fail_visual_outbox BEFORE INSERT ON sync_outbox WHEN NEW.entityId='b-resized' BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END",
  );
  await result(
    req("/batch-rename", "POST", {
      items: items.map((item) => ({
        ...item,
        expectedFilename: item.filename,
        filename: `Changed-${item.id}.png`,
      })),
    }),
    500,
  );
  assert.deepEqual(
    db.prepare("SELECT id,filename FROM attachments ORDER BY id").all(),
    beforeNames,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM sync_outbox ORDER BY id").all(),
    beforeOutbox,
  );
});

import "./setup-db-isolation";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { getDb } from "../src/db/schema";
import { setKnowledgeNodeDenied } from "../src/services/knowledgeDenyPolicy";
import routes from "../src/routes/sync-v2";
import { coalesceMutations } from "../src/sync/push";
import { createProfile, switchActiveProfile } from "../src/sync/profile";
import { ensureDevice } from "../src/sync/device";
import { permanentlyDeleteNote } from "../src/services/trash/noteTrashAdapter";
import { setKnowledgeNodeRole } from "../src/services/knowledgeCapabilities";
import { applyMutation } from "../src/sync/apply";
import type { SyncOutboxRow } from "../src/sync/types";

const db = getDb(),
  owner = "deletion-owner",
  other = "deletion-editor";
for (const id of [owner, other])
  db.prepare(
    "INSERT INTO users(id,username,passwordHash) VALUES(?,?,'fixture')",
  ).run(id, id);
db.prepare(
  "INSERT INTO notebooks(id,userId,name) VALUES('deletion-book',?,'Deletion')",
).run(owner);
const app = new Hono().route("/api/sync/v2", routes);
function note(trashed = 0, locked = 0) {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO notes(id,userId,notebookId,title,content,contentFormat,isTrashed,isLocked,version) VALUES(?,?,'deletion-book','Delete','preserved','markdown',?,?,2)",
  ).run(id, owner, trashed, locked);
  return id;
}
async function push(
  id: string,
  baseVersion: number | undefined = 2,
  mutationId = randomUUID(),
) {
  const response = await app.request("/api/sync/v2/push", {
    method: "POST",
    headers: { "X-User-Id": owner, "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: "delete-device",
      mutations: [
        {
          mutationId,
          entityType: "note",
          entityId: id,
          operation: "delete",
          baseVersion,
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  return (
    (await response.json()) as {
      results: Array<{ status: string; code?: string }>;
    }
  ).results[0];
}
function snapshot(id: string) {
  return {
    note: db.prepare("SELECT * FROM notes WHERE id=?").get(id),
    tree: db
      .prepare(
        "SELECT * FROM knowledge_tree_nodes WHERE resourceType='note' AND resourceId=?",
      )
      .all(id),
    history: db.prepare("SELECT * FROM note_versions WHERE noteId=?").all(id),
    attachments: db.prepare("SELECT * FROM attachments WHERE noteId=?").all(id),
  };
}
test("direct Sync delete refuses an active note without changing body, tree, history or attachments", async () => {
  const id = note();
  db.prepare(
    "INSERT INTO note_versions(id,noteId,userId,title,content,contentFormat,version) VALUES(?,?,?,'Delete','history','markdown',1)",
  ).run(randomUUID(), id, owner);
  db.prepare(
    "INSERT INTO attachments(id,noteId,userId,filename,path,mimeType,size) VALUES(?,?,?,'a','a','image/png',1)",
  ).run(randomUUID(), id, owner);
  const before = snapshot(id),
    result = await push(id);
  assert.equal(result.code, "NOTE_NOT_TRASHED");
  assert.deepEqual(snapshot(id), before);
});
test("permanent deletion requires a matching version and refuses locked notes", async () => {
  for (const [base, locked, code] of [
    [undefined, 0, "VERSION_CONFLICT"],
    [1, 0, "VERSION_CONFLICT"],
    [2, 1, "NOTE_LOCKED"],
  ] as const) {
    const id = note(1, locked),
      before = snapshot(id);
    // Explicit undefined must remain absent rather than selecting the helper default.
    const response = await app.request("/api/sync/v2/push", {
      method: "POST",
      headers: { "X-User-Id": owner, "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "delete-device",
        mutations: [
          {
            mutationId: randomUUID(),
            entityType: "note",
            entityId: id,
            operation: "delete",
            baseVersion: base,
          },
        ],
      }),
    });
    assert.equal(((await response.json()) as any).results[0].code, code);
    assert.deepEqual(snapshot(id), before);
  }
});
test("canDelete without manage and explicit deny cannot permanently delete a workspace tombstone", () => {
  const workspace = randomUUID(),
    book = randomUUID(),
    id = randomUUID();
  db.prepare(
    "INSERT INTO workspaces(id,name,ownerId) VALUES(?,'Deletion ACL',?)",
  ).run(workspace, owner);
  db.prepare(
    "INSERT INTO workspace_members(workspaceId,userId,role) VALUES(?,?,'editor')",
  ).run(workspace, other);
  db.prepare(
    "INSERT INTO notebooks(id,userId,workspaceId,name) VALUES(?,?,?,'Shared')",
  ).run(book, owner, workspace);
  db.prepare(
    "INSERT INTO notes(id,userId,workspaceId,notebookId,title,content,isTrashed,version) VALUES(?,?,?,?,'ACL','retained',1,2)",
  ).run(id, owner, workspace, book);
  setKnowledgeNodeRole({
    nodeId: `note:${id}`,
    targetUserId: other,
    rolePreset: "maintainer",
    actorUserId: owner,
    db,
  });
  const apply = () =>
    db.transaction(() =>
      applyMutation(db, {
        userId: other,
        workspaceId: workspace,
        deviceId: "editor",
        mutationId: randomUUID(),
        entityType: "note",
        entityId: id,
        operation: "delete",
        baseVersion: 2,
      }),
    )();
  assert.throws(apply, (e: any) => e.code === "SCOPE_FORBIDDEN");
  setKnowledgeNodeDenied({
    nodeId: `note:${id}`,
    targetUserId: other,
    actorUserId: owner,
    db,
  });
  assert.throws(apply, (e: any) => e.code === "SCOPE_FORBIDDEN");
  assert.ok(db.prepare("SELECT id FROM notes WHERE id=?").get(id));
});
test("confirmed trashed deletion removes the tree and stays idempotent after a lost ACK", async () => {
  const id = note(1),
    mutationId = randomUUID();
  assert.equal((await push(id, 2, mutationId)).status, "applied");
  assert.equal(
    db.prepare("SELECT id FROM notes WHERE id=?").get(id),
    undefined,
  );
  assert.equal(
    db
      .prepare(
        "SELECT id FROM knowledge_tree_nodes WHERE resourceType='note' AND resourceId=?",
      )
      .get(id),
    undefined,
  );
  assert.equal((await push(id, 2, mutationId)).status, "duplicate");
});
test("desktop coalescing preserves a trash acknowledgement before a legacy terminal delete", () => {
  const rows = [
    {
      mutationId: "edit",
      operation: "upsert",
      payload: JSON.stringify({ content: "offline", isTrashed: 0 }),
      baseVersion: 2,
    },
    {
      mutationId: "trash",
      operation: "upsert",
      payload: JSON.stringify({ content: "offline", isTrashed: 1 }),
      baseVersion: 3,
    },
    {
      mutationId: "permanent",
      operation: "delete",
      payload: null,
      baseVersion: 4,
    },
  ].map(
    (row) =>
      ({ ...row, entityType: "note", entityId: "legacy" }) as SyncOutboxRow,
  );
  const batch = coalesceMutations(rows);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].operation, "upsert");
  assert.equal(batch[0].payload?.isTrashed, 1);
  assert.equal(batch[0].baseVersion, 2);
  assert.ok(!batch[0].supersededIds.includes("permanent"));
});
test("desktop delete durably retains the last body and attachment bytes until the delete ACK", async () => {
  const profile = createProfile(db, {
    name: "delete-fixture",
    serverUrl: "http://deletion.invalid",
    remoteUserId: owner,
  });
  switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus='ready' WHERE id=?").run(
    profile.id,
  );
  ensureDevice(db, { profileId: profile.id, platform: "test" });
  const id = note(1),
    attachment = randomUUID(),
    filename = attachment + ".png";
  const dir = path.join(process.env.ELECTRON_USER_DATA!, "attachments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), "recovery bytes");
  db.prepare(
    "INSERT INTO attachments(id,noteId,userId,filename,path,mimeType,size) VALUES(?,?,?, ?,?,'image/png',14)",
  ).run(attachment, id, owner, filename, filename);
  permanentlyDeleteNote(id, owner);
  const pending = db
    .prepare(
      "SELECT payload FROM sync_outbox WHERE entityId=? AND operation='delete' AND entityType='note'",
    )
    .get(id) as { payload: string };
  assert.equal(
    JSON.parse(pending.payload)._deletionRecovery.note.content,
    "preserved",
  );
  assert.equal(
    JSON.parse(pending.payload)._deletionRecovery.attachments[0].id,
    attachment,
  );
  assert.equal(
    fs.readFileSync(path.join(dir, filename), "utf8"),
    "recovery bytes",
  );
  const { scanOrphanAttachments } =
    await import("../src/routes/attachments-core");
  assert.ok(
    !scanOrphanAttachments(0).dbOrphans.some(
      (row) => row.filename === filename,
    ),
  );
  db.prepare("UPDATE sync_profiles SET enabled=0 WHERE id=?").run(profile.id);
});

test("failed mutation ledger rolls back deletion, cleanup job and knowledge tree atomically", () => {
  const id = note(1),
    before = snapshot(id),
    mutationId = randomUUID();
  db.exec(
    `CREATE TRIGGER fail_deletion_ledger BEFORE INSERT ON sync_v2_applied_mutations WHEN NEW.mutationId='${mutationId}' BEGIN SELECT RAISE(ABORT,'ledger unavailable'); END`,
  );
  try {
    assert.throws(
      () =>
        db.transaction(() =>
          applyMutation(db, {
            userId: owner,
            deviceId: "fixture",
            mutationId,
            entityType: "note",
            entityId: id,
            operation: "delete",
            baseVersion: 2,
          }),
        )(),
      /ledger unavailable/,
    );
    assert.deepEqual(snapshot(id), before);
    assert.equal(
      db
        .prepare("SELECT 1 FROM sync_note_deletion_cleanup WHERE mutationId=?")
        .get(mutationId),
      undefined,
    );
  } finally {
    db.exec("DROP TRIGGER fail_deletion_ledger");
  }
});
test("retained file-trash contents block permanent note deletion without losing the attachment", async () => {
  const id = note(1),
    attachment = randomUUID();
  db.prepare(
    "INSERT INTO attachments(id,noteId,userId,filename,path,mimeType,size,trashedAt) VALUES(?,?,?,'retained','retained','image/png',1,datetime('now'))",
  ).run(attachment, id, owner);
  const before = snapshot(id);
  assert.equal((await push(id)).code, "ATTACHMENT_TRASH_RETAINED");
  assert.deepEqual(snapshot(id), before);
});
test("legacy active terminal delete is rejected repeatedly with the same mutation identity", async () => {
  const id = note(),
    mutationId = randomUUID();
  assert.equal((await push(id, 2, mutationId)).code, "NOTE_NOT_TRASHED");
  assert.equal((await push(id, 2, mutationId)).code, "NOTE_NOT_TRASHED");
  assert.equal(
    db
      .prepare("SELECT 1 FROM sync_v2_applied_mutations WHERE mutationId=?")
      .get(mutationId),
    undefined,
  );
  assert.equal(
    (
      db.prepare("SELECT content FROM notes WHERE id=?").get(id) as {
        content: string;
      }
    ).content,
    "preserved",
  );
});

test("upgrading a legacy delete retains mutation identity, retry state and the last queued body", async () => {
  const { noteDeletionLifecycleMigration } =
    await import("../src/db/noteDeletionLifecycleMigration");
  const profile = createProfile(db, {
    name: "legacy-upgrade",
    serverUrl: "http://legacy.invalid",
    remoteUserId: owner,
  });
  switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus='ready' WHERE id=?").run(
    profile.id,
  );
  ensureDevice(db, { profileId: profile.id, platform: "test" });
  const id = note(1);
  db.prepare("DELETE FROM notes WHERE id=?").run(id);
  db.prepare(
    "UPDATE sync_outbox SET payload=NULL,retryCount=7,status='failed',lastError='NETWORK_UNAVAILABLE' WHERE entityId=? AND operation='delete' AND entityType='note'",
  ).run(id);
  const before = db
    .prepare(
      "SELECT mutationId,retryCount,lastError,status FROM sync_outbox WHERE entityId=? AND operation='delete' AND entityType='note'",
    )
    .get(id);
  noteDeletionLifecycleMigration.up(db);
  const after = db
    .prepare(
      "SELECT mutationId,retryCount,lastError,status,payload FROM sync_outbox WHERE entityId=? AND operation='delete' AND entityType='note'",
    )
    .get(id) as any;
  assert.deepEqual(
    {
      mutationId: after.mutationId,
      retryCount: after.retryCount,
      lastError: after.lastError,
      status: after.status,
    },
    before,
  );
  assert.equal(
    JSON.parse(after.payload)._deletionRecovery.note.content,
    "preserved",
  );
  noteDeletionLifecycleMigration.up(db);
  assert.deepEqual(
    db
      .prepare(
        "SELECT mutationId,retryCount,lastError,status,payload FROM sync_outbox WHERE entityId=? AND operation='delete' AND entityType='note'",
      )
      .get(id),
    after,
  );
  db.prepare("UPDATE sync_profiles SET enabled=0 WHERE id=?").run(profile.id);
});

test("desktop deletion conflict choices preserve both versions and only keep-local requeues deletion", async () => {
  const { recordConflict } = await import("../src/sync/conflict");
  const { applyConflictResolution } = await import("../src/sync/resolve");
  for (const resolution of ["keep-local", "keep-remote", "manual"] as const) {
    const profile = createProfile(db, {
      name: "deletion-choice",
      serverUrl: `http://${resolution}.choice.invalid`,
      remoteUserId: owner,
    });
    const id = randomUUID(),
      local = {
        id,
        notebookId: "deletion-book",
        title: "Local",
        content: "local body",
        contentFormat: "markdown",
        version: 2,
        isTrashed: 1,
        workspaceId: null,
      };
    const remote = {
      ...local,
      content: "remote body",
      version: 6,
      isTrashed: 0,
    };
    const conflictId = recordConflict(db, {
      profileId: profile.id,
      scopeKey: "personal",
      entityType: "note",
      entityId: id,
      localVersion: 2,
      remoteVersion: 6,
      localPayload: {
        ...local,
        _deletionRecovery: { note: local, attachments: [] },
      },
      remotePayload: remote,
    });
    applyConflictResolution(db, {
      conflictId,
      deviceId: "choice-device",
      userId: owner,
      resolution,
      mergedPayload:
        resolution === "manual"
          ? { ...remote, content: "merged body" }
          : undefined,
    });
    const rows = db
      .prepare(
        "SELECT operation,payload FROM sync_outbox WHERE profileId=? AND entityId=? ORDER BY rowid",
      )
      .all(profile.id, id) as { operation: string; payload: string }[];
    if (resolution === "keep-local") {
      assert.deepEqual(
        rows.map((row) => row.operation),
        ["upsert", "delete"],
      );
      assert.equal(JSON.parse(rows[0].payload).isTrashed, 1);
    } else {
      assert.ok(!rows.some((row) => row.operation === "delete"));
      assert.equal(
        (
          db.prepare("SELECT content FROM notes WHERE id=?").get(id) as {
            content: string;
          }
        ).content,
        resolution === "keep-remote" ? "remote body" : "merged body",
      );
    }
    assert.equal(
      JSON.parse(
        (
          db
            .prepare("SELECT localPayload FROM sync_conflicts WHERE id=?")
            .get(conflictId) as { localPayload: string }
        ).localPayload,
      )._deletionRecovery.note.content,
      "local body",
    );
    db.prepare("UPDATE sync_profiles SET enabled=0 WHERE id=?").run(profile.id);
  }
});

test("committed Sync deletion cleans attachment objects only after their last live reference", async () => {
  const first = note(1),
    second = note(1),
    filename = randomUUID() + ".png";
  const dir = path.join(process.env.ELECTRON_USER_DATA!, "attachments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), "shared bytes");
  for (const id of [first, second])
    db.prepare(
      "INSERT INTO attachments(id,noteId,userId,filename,path,mimeType,size) VALUES(?,?,?, ?,?,'image/png',12)",
    ).run(randomUUID(), id, owner, filename, filename);
  assert.equal((await push(first)).status, "applied");
  assert.ok(fs.existsSync(path.join(dir, filename)));
  assert.equal((await push(second)).status, "applied");
  assert.equal(fs.existsSync(path.join(dir, filename)), false);
  assert.equal(
    db
      .prepare("SELECT 1 FROM sync_note_deletion_cleanup WHERE noteId IN (?,?)")
      .get(first, second),
    undefined,
  );
});

test("a personal-scope delete cannot acknowledge a note belonging to a workspace", async () => {
  const workspace = randomUUID(),
    book = randomUUID(),
    id = randomUUID();
  db.prepare("INSERT INTO workspaces(id,name,ownerId) VALUES(?,'Scope',?)").run(
    workspace,
    owner,
  );
  db.prepare(
    "INSERT INTO notebooks(id,userId,workspaceId,name) VALUES(?,?,?,'Scope')",
  ).run(book, owner, workspace);
  db.prepare(
    "INSERT INTO notes(id,userId,workspaceId,notebookId,title,content,isTrashed,version) VALUES(?,?,?,?,'Scope','body',1,2)",
  ).run(id, owner, workspace, book);
  const before = snapshot(id);
  assert.equal((await push(id)).code, "SCOPE_FORBIDDEN");
  assert.deepEqual(snapshot(id), before);
});

test("encrypted deletion recovery retains the original envelope without converting it to plaintext", () => {
  const vector = JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json",
      ),
      "utf8",
    ),
  );
  const cipher = JSON.stringify(vector.envelope),
    id = randomUUID();
  const profile = createProfile(db, {
    name: "encrypted-delete",
    serverUrl: "http://encrypted-delete.invalid",
    remoteUserId: owner,
  });
  switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus='ready' WHERE id=?").run(
    profile.id,
  );
  ensureDevice(db, { profileId: profile.id, platform: "test" });
  db.prepare(
    "INSERT INTO notes(id,userId,notebookId,title,content,contentText,contentFormat,isTrashed,version) VALUES(?,?,'deletion-book','Encrypted',?,'','encrypted-note-v1',1,2)",
  ).run(id, owner, cipher);
  permanentlyDeleteNote(id, owner);
  const recovery = JSON.parse(
    (
      db
        .prepare(
          "SELECT payload FROM sync_outbox WHERE entityId=? AND entityType='note' AND operation='delete'",
        )
        .get(id) as { payload: string }
    ).payload,
  )._deletionRecovery;
  assert.equal(recovery.note.content, cipher);
  assert.equal(recovery.note.contentFormat, "encrypted-note-v1");
  assert.equal(recovery.note.contentText, "");
  db.prepare("UPDATE sync_profiles SET enabled=0 WHERE id=?").run(profile.id);
});

test("workspace owners can permanently delete an authorized tombstone through the actual Sync route",async()=>{
  const workspace=randomUUID(),book=randomUUID(),id=randomUUID();
  db.prepare("INSERT INTO workspaces(id,name,ownerId) VALUES(?,'Workspace deletion',?)").run(workspace,owner);
  db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES(?,?,'owner')").run(workspace,owner);
  db.prepare("INSERT INTO notebooks(id,userId,workspaceId,name) VALUES(?,?,?,'Workspace deletion')").run(book,owner,workspace);
  db.prepare("INSERT INTO notes(id,userId,workspaceId,notebookId,title,content,isTrashed,version) VALUES(?,?,?,?,'Workspace deletion','body',1,2)").run(id,owner,workspace,book);
  const response=await app.request(`/api/sync/v2/push?scopeKey=workspace:${workspace}`,{method:'POST',headers:{'X-User-Id':owner,'Content-Type':'application/json'},body:JSON.stringify({deviceId:'workspace-delete',mutations:[{mutationId:randomUUID(),entityType:'note',entityId:id,operation:'delete',baseVersion:2}]})});
  assert.equal(response.status,200);assert.equal((await response.json() as any).results[0].status,'applied');assert.equal(db.prepare('SELECT 1 FROM notes WHERE id=?').get(id),undefined);
});

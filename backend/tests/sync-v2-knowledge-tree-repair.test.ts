import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-repair-"));
process.env.DB_PATH = path.join(tempDir, "repair.db");
process.env.ELECTRON_USER_DATA = tempDir;

test.after(async () => {
  const { closeDb } = await import("../src/db/schema.js");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tree repair previews and atomically converges 18 structural conflicts without rewriting business resources", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { createProfile, switchActiveProfile, advanceSyncState, getSyncState } = await import("../src/sync/profile.js");
  const { prepareKnowledgeTreeSnapshot } = await import("../src/sync/knowledgeTreeSnapshot.js");
  const { runKnowledgeTreeBaseline } = await import("../src/sync/knowledgeTreeBaseline.js");
  const { listUnresolvedConflicts, recordConflict } = await import("../src/sync/conflict.js");
  const { applyTreeRepair, fetchTreeRepairSnapshot, previewTreeRepair } = await import("../src/sync/knowledgeTreeRepair.js");
  const { enqueueMutation } = await import("../src/sync/outbox.js");
  const { ensureDevice } = await import("../src/sync/device.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('left', 'owner', 'Left'), ('right', 'owner', 'Right')").run();
  for (let i = 0; i < 18; i += 1) {
    db.prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, 'owner', 'left', ?, ?)")
      .run(`n${i}`, `Note ${i}`, JSON.stringify({ original: i }));
  }
  const profile = createProfile(db, { name: "NAS", serverUrl: "http://repair.test" });
  switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus = 'ready' WHERE id = ?").run(profile.id);
  const device = ensureDevice(db, { profileId: profile.id, platform: "test" });
  advanceSyncState(db, profile.id, 41, "personal");

  const localTree = prepareKnowledgeTreeSnapshot(db, "owner", null);
  let remoteTree = localTree.map((item) => item.payload.resourceType === "note"
    ? { ...item, payload: { ...item.payload, parentId: "notebook:right", sortOrder: -4 } }
    : item);
  const completeTree = remoteTree;
  const conflictIds = localTree.filter((item) => item.payload.resourceType === "note").map((item) =>
    recordConflict(db, {
      profileId: profile.id, entityType: "knowledge_tree_node",
      entityId: item.entityId, localPayload: item.payload, remotePayload: null,
    }));
  const input = { userId: "owner", profileId: profile.id, strategy: "keep-remote" as const, conflictIds };
  let remoteSequence = 41;
  let ackCount = 0;
  const client = {
    async plan() {
      return { scopeKey: "personal", accessFingerprint: "owner", serverSequence: remoteSequence, resetRequired: false };
    },
    async snapshot(cursor: string | null, sequence: number, _limit: number, scopeKey: string, subscription: { deviceId?: string }) {
      if (!subscription.deviceId) {
        assert.equal(cursor, "knowledge_tree_node:");
        assert.equal(sequence, 41);
      }
      return {
        scopeKey, accessFingerprint: "owner", snapshotSequence: 41, hasMore: false, nextCursor: null,
        items: remoteTree.map((item) => ({ entityType: "knowledge_tree_node", ...item })),
      };
    },
    async ack() { ackCount += 1; },
  } as unknown as Parameters<typeof fetchTreeRepairSnapshot>[1];
  const readRemote = () => fetchTreeRepairSnapshot(db, client, input);
  const businessBefore = db.prepare("SELECT * FROM notes ORDER BY id").all();

  remoteSequence += 1;
  await assert.rejects(readRemote(), /游标已变化/);
  remoteSequence -= 1;

  enqueueMutation(db, {
    profileId: profile.id, deviceId: device.id, entityType: "note", entityId: "n0",
    operation: "upsert", mutationId: "unconfirmed-edit", payload: { content: "edited" },
  });
  await assert.rejects(readRemote(), /待同步的修改/);
  assert.ok(db.prepare("SELECT 1 FROM sync_outbox WHERE mutationId = 'unconfirmed-edit'").get());
  db.prepare("DELETE FROM sync_outbox WHERE mutationId = 'unconfirmed-edit'").run();

  db.prepare(`INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
    VALUES ('pending', 'n0', 'owner', 'pending.png', 'image/png', 10, '/pending.png')`).run();
  db.prepare("DELETE FROM sync_outbox WHERE entityId = 'pending'").run();
  await assert.rejects(readRemote(), /未上传的附件/);
  db.prepare("DELETE FROM attachments WHERE id = 'pending'").run();
  db.prepare("DELETE FROM sync_outbox WHERE entityId = 'pending'").run();

  remoteTree = completeTree.filter((item) => item.entityId !== "note:n0");
  let snapshot = await readRemote();
  assert.throws(() => previewTreeRepair(db, input, snapshot), /云端缺少/);

  for (const [parentId, isDeleted, error] of [
    ["note:n0", 0, /循环/], ["notebook:other-space", 0, /父目录缺失/],
    ["notebook:right", 1, /删除或恢复/],
  ] as const) {
    remoteTree = completeTree.map((item) => item.entityId === "note:n0"
      ? { ...item, payload: { ...item.payload, parentId, isDeleted } } : item);
    snapshot = await readRemote();
    assert.throws(() => previewTreeRepair(db, input, snapshot), error);
  }
  remoteTree = completeTree;
  db.prepare("DELETE FROM knowledge_tree_nodes WHERE id = 'note:n0'").run();
  const incompleteLocal = prepareKnowledgeTreeSnapshot(db, "owner", null);
  snapshot = await readRemote();
  const preview = previewTreeRepair(db, input, snapshot);
  assert.equal(preview.changes.length, 18);
  assert.ok(preview.changes.some((change) => change.title === "Note 0"));
  assert.equal(listUnresolvedConflicts(db, profile.id).length, 18);
  assert.equal(preview.changes.find((change) => change.title === "Note 0")?.local, null);
  assert.deepEqual(prepareKnowledgeTreeSnapshot(db, "owner", null), incompleteLocal);

  db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 7 WHERE id = 'note:n1'").run();
  assert.throws(() => applyTreeRepair(db, input, snapshot, preview.token, device.id), /重新预览/);
  const nextPreview = previewTreeRepair(db, input, snapshot);
  db.exec(`CREATE TRIGGER reject_repair BEFORE UPDATE OF status ON sync_conflicts
    WHEN OLD.id = '${conflictIds.at(-1)}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  assert.throws(() => applyTreeRepair(db, input, snapshot, nextPreview.token, device.id), /injected failure/);
  assert.equal(listUnresolvedConflicts(db, profile.id).length, 18);
  assert.equal((db.prepare("SELECT sortOrder FROM knowledge_tree_nodes WHERE id = 'note:n1'").get() as { sortOrder: number }).sortOrder, 7);
  db.exec("DROP TRIGGER reject_repair");

  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/plan")) {
      void client.plan(41).then((plan) => res.end(JSON.stringify(plan)));
    } else if (url.pathname.endsWith("/snapshot")) {
      void client.snapshot(url.searchParams.get("cursor"), Number(url.searchParams.get("snapshotSequence")),
        500, "personal", { entityTypes: [] }).then((page) => res.end(JSON.stringify(page)));
    } else {
      res.writeHead(404).end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const serverUrl = `http://127.0.0.1:${address.port}`;
    db.prepare("UPDATE sync_profiles SET serverUrl = ? WHERE id = ?").run(serverUrl, profile.id);
    const { saveRemoteCredential } = await import("../src/sync/credentials.js");
    const { getBackupManager } = await import("../src/services/backup.js");
    const { default: routes } = await import("../src/routes/sync-local.js");
    saveRemoteCredential({ profileId: profile.id, serverUrl, token: "test-token" });
    const app = new Hono().route("/api/sync/local", routes);
    const request = (action: string, userId: string, token?: string) =>
      app.request(`/api/sync/local/knowledge-tree/repair/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": userId },
        body: JSON.stringify({ strategy: input.strategy, conflictIds, token }),
      });
    assert.equal((await request("preview", "other")).status, 403);
    const previewResponse = await request("preview", "owner");
    assert.equal(previewResponse.status, 200);
    const routePreview = await previewResponse.json() as { token: string };
    const applyResponse = await request("apply", "owner", routePreview.token);
    const result = await applyResponse.json() as { resolved: number; backupId: string };
    assert.equal(applyResponse.status, 200, JSON.stringify(result));
    assert.equal(result.resolved, 18);
    assert.ok(getBackupManager().listBackups().some((backup) => backup.type === "full" && backup.id === result.backupId));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.deepEqual(db.prepare("SELECT * FROM notes ORDER BY id").all(), businessBefore);
  assert.equal(listUnresolvedConflicts(db, profile.id).length, 0);
  assert.equal(getSyncState(db, profile.id, "personal")?.lastSequence, 41);
  assert.equal(ackCount, 0);
  assert.equal(db.prepare("SELECT 1 FROM sync_outbox").get(), undefined);
  assert.deepEqual(
    new Map(prepareKnowledgeTreeSnapshot(db, "owner", null).map((item) => [item.entityId, item.payload])),
    new Map(remoteTree.map((item) => [item.entityId, item.payload])),
  );

  for (let i = 0; i < 2; i += 1) {
    assert.equal((await runKnowledgeTreeBaseline({
      db, profileId: profile.id, deviceId: device.id, userId: "owner", scopeKey: "personal", workspaceId: null, client,
    })).status, "ready");
  }
  assert.equal(ackCount, 1);
  assert.equal(listUnresolvedConflicts(db, profile.id).length, 0);

  const beforeLocalChoice = prepareKnowledgeTreeSnapshot(db, "owner", null);
  const localChoice = beforeLocalChoice.find((item) => item.entityId === "note:n1")!;
  remoteTree = remoteTree.map((item) => item.entityId === "note:n1"
    ? { ...item, payload: { ...item.payload, sortOrder: 12 } } : item);
  const localChoiceId = recordConflict(db, {
    profileId: profile.id, entityType: "knowledge_tree_node", entityId: "note:n1",
    localPayload: localChoice.payload, remotePayload: remoteTree.find((item) => item.entityId === "note:n1")!.payload,
  });
  const localInput = { ...input, strategy: "keep-local" as const, conflictIds: [localChoiceId] };
  const localSnapshot = await fetchTreeRepairSnapshot(db, client, localInput);
  const localPreview = previewTreeRepair(db, localInput, localSnapshot);
  assert.deepEqual(applyTreeRepair(db, localInput, localSnapshot, localPreview.token, device.id), { resolved: 1 });
  assert.deepEqual(prepareKnowledgeTreeSnapshot(db, "owner", null), beforeLocalChoice);
  const pending = db.prepare("SELECT payload FROM sync_outbox WHERE entityId = 'note:n1'").get() as { payload: string };
  assert.equal(JSON.parse(pending.payload).baseSortOrder, 12);
  assert.equal(JSON.parse(pending.payload).sortOrder, -4);
});

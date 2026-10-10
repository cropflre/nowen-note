import { withEncryptedBlockWrite } from "../src/lib/encryptedBlockWrites.js";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { closeDb, getDb } from "../src/db/schema.js";
import { ENCRYPTED_NOTE_FORMAT } from "../src/lib/encryptedNotes.js";
import { ensureNormalizedSearchFts } from "../src/lib/searchIndex.js";
import { applyRemoteChanges } from "../src/sync/applyLocal.js";
import { runBootstrap } from "../src/sync/bootstrap.js";
import { getConflict, listUnresolvedConflicts, recordConflict } from "../src/sync/conflict.js";
import { SYNC_V2_BASE_PATH } from "../src/sync/constants.js";
import { ensureDevice } from "../src/sync/device.js";
import { SyncEngine } from "../src/sync/engine.js";
import { listPendingMutations } from "../src/sync/outbox.js";
import { createProfile, getSyncState, switchActiveProfile } from "../src/sync/profile.js";
import { SyncRemoteClient } from "../src/sync/remote.js";
import { applyConflictResolution, fillRemotePayload } from "../src/sync/resolve.js";

// Public interoperable vector; OpenSSL verifies that both conflict sides remain decryptable.
const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
const original = JSON.stringify(vector.envelope);
const directory = path.dirname(process.env.DB_PATH!);
const template = path.join(directory, "empty-installation.db");
const databases: Database.Database[] = [];
let app: Hono;
let note: Record<string, any>;

function open(cipher: { iv: string; ciphertext: string }, key: Buffer, aad: string): Buffer {
  const bytes = Buffer.from(cipher.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(cipher.iv, "base64"));
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
}
const dek = open(vector.envelope.wrappedKey, Buffer.from(vector.derivedKeyHex, "hex"), vector.aadKeyUtf8);
function decrypt(content: string): string {
  return open(JSON.parse(content).payload, dek, vector.aadContentUtf8).toString("utf8");
}
function encryptedVersion(plaintext: string): string {
  const envelope = structuredClone(vector.envelope);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(Buffer.from(vector.aadContentUtf8));
  envelope.payload = { iv: iv.toString("base64"), ciphertext: Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64") };
  return JSON.stringify(envelope);
}
function device(name: string) {
  const filename = path.join(directory, `${name}.db`);
  fs.copyFileSync(template, filename);
  const db = new Database(filename); databases.push(db);
  db.pragma("foreign_keys = ON"); db.pragma("journal_mode = WAL");
  ensureNormalizedSearchFts(db);
  const userId = `local-${name}`;
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(userId, userId);
  const profile = createProfile(db, { name, serverUrl: "http://fixture.invalid", remoteUserId: "server-owner" });
  switchActiveProfile(db, profile.id);
  const installation = ensureDevice(db, { profileId: profile.id, platform: "test" });
  return { db, profileId: profile.id, deviceId: installation.id, userId };
}
function client(options: { corruptSnapshots?: boolean; corruptPushConflicts?: boolean; requests?: string[] } = {}) {
  return new SyncRemoteClient({ serverUrl: "http://fixture.invalid", token: "public-fixture-token" }, {
    fetchImpl: async (url, init) => {
      const target = new URL(url);
      options.requests?.push(target.pathname);
      const response = await app.request(target.pathname + target.search, { ...init, headers: { ...init?.headers, "X-User-Id": "server-owner" } });
      const corruptSnapshot = options.corruptSnapshots && target.pathname.endsWith("/snapshot");
      const corruptPush = options.corruptPushConflicts && target.pathname.endsWith("/push");
      if ((!corruptSnapshot && !corruptPush) || !response.ok) return response;
      const body = await response.json() as any;
      for (const item of body.items ?? []) {
        if (item.entityType === "note") item.payload.content = malformed;
      }
      for (const result of body.results ?? []) {
        if (result.code === "VERSION_CONFLICT" && result.serverPayload) result.serverPayload.content = malformed;
      }
      return Response.json(body);
    },
  });
}
const malformed = JSON.stringify({ ...vector.envelope, payload: { ...vector.envelope.payload, ciphertext: "not-canonical-base64!" } });
function read(db: Database.Database) { return db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id) as Record<string, any>; }
async function bootstrap(installation: ReturnType<typeof device>, remote = client()) {
  return runBootstrap({ ...installation, client: remote, pageSize: 1 });
}
function engine(installation: ReturnType<typeof device>, remote = client()) {
  return new SyncEngine({ ...installation, client: remote, intervalMs: 0, scheduler: { setTimeout: () => 0, clearTimeout: () => {} } });
}

test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES ('server-owner', 'server-owner', 'hash')").run();
  const { initAuditTables } = await import("../src/services/audit.js"); initAuditTables();
  await getDb().backup(template);
  app = new Hono();
  const { default: notes } = await import("../src/routes/notes.js"); app.route("/notes", notes);
  const { default: sync } = await import("../src/routes/sync-v2.js"); app.route(SYNC_V2_BASE_PATH, sync);
  const created = await app.request("/notes", { method: "POST", headers: { "X-User-Id": "server-owner", "Content-Type": "application/json" }, body: JSON.stringify({ title: "Public metadata", content: original, contentFormat: ENCRYPTED_NOTE_FORMAT }) });
  assert.equal(created.status, 201); note = await created.json() as any;
});
test.after(() => { for (const db of databases) db.close(); closeDb(); dek.fill(0); });

test("two independent installations bootstrap paginated ciphertext through real Sync V2 routes", async () => {
  for (const name of ["bootstrap-a", "bootstrap-b"]) {
    const installation = device(name);
    const progress = await bootstrap(installation);
    assert.equal(progress.status, "ready");
    const loaded = read(installation.db);
    assert.equal(loaded.content, original); assert.equal(loaded.contentText, "");
    assert.equal(loaded.userId, installation.userId); assert.equal(decrypt(loaded.content), vector.plaintext);
    assert.equal(listPendingMutations(installation.db, 100, installation.profileId).length, 0);
    for (const table of ["note_blocks_index", "note_block_records", "note_yupdates", "note_embeddings"]) {
      assert.equal((installation.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE noteId = ?`).get(note.id) as any).count, 0);
    }
  }
});

test("malformed bootstrap ciphertext stops before ACK, cursor advancement or note persistence", async () => {
  const installation = device("malformed-bootstrap"); const requests: string[] = [];
  await assert.rejects(bootstrap(installation, client({ corruptSnapshots: true, requests })), { code: "INVALID_PAYLOAD" });
  assert.equal(read(installation.db), undefined);
  assert.equal(getSyncState(installation.db, installation.profileId)?.lastSequence ?? 0, 0);
  assert.equal(requests.some((url) => url.endsWith("/ack")), false);
  assert.equal((installation.db.prepare("SELECT bootstrapStatus, bootstrapCursor FROM sync_profiles WHERE id = ?").get(installation.profileId) as any).bootstrapStatus, "failed");
});

test("independent offline edits preserve authenticated local and remote ciphertext after conflict resolution", async () => {
  const a = device("conflict-a"), b = device("conflict-b");
  await bootstrap(a); await bootstrap(b);
  const left = encryptedVersion("PUBLIC_FIXTURE_PRIVATE_LEFT"), right = encryptedVersion("PUBLIC_FIXTURE_PRIVATE_RIGHT");
  a.db.prepare("UPDATE notes SET content = ?, version = version + 1 WHERE id = ?").run(left, note.id);
  b.db.prepare("UPDATE notes SET content = ?, version = version + 1 WHERE id = ?").run(right, note.id);
  assert.ok(listPendingMutations(a.db, 100, a.profileId).some((row) => row.entityId === note.id));
  const ae = engine(a), be = engine(b);
  try {
    assert.equal((await ae.syncOnce()).state, "idle");
    assert.equal(read(getDb()).content, left);
    await be.syncOnce();
    assert.equal(read(b.db).content, right);
    const conflict = listUnresolvedConflicts(b.db, b.profileId).find((row) => row.entityId === note.id);
    assert.ok(conflict);
    assert.equal(JSON.parse(conflict.localPayload!).content, right);
    assert.equal(JSON.parse(conflict.remotePayload!).content, left);
    const pendingBefore = listPendingMutations(b.db, 100, b.profileId);
    assert.throws(() => applyConflictResolution(b.db, { conflictId: conflict.id, resolution: "manual", mergedPayload: { ...read(b.db), content: "must-never-persist", contentFormat: "markdown" }, deviceId: b.deviceId, userId: b.userId }), { code: "INVALID_PAYLOAD" });
    assert.deepEqual(listPendingMutations(b.db, 100, b.profileId), pendingBefore);
    assert.equal(getConflict(b.db, conflict.id)?.status, "unresolved");
    applyConflictResolution(b.db, { conflictId: conflict.id, resolution: "keep-remote", deviceId: b.deviceId, userId: b.userId });
    assert.equal(read(b.db).content, left);
    const resolved = getConflict(b.db, conflict.id)!;
    assert.equal(resolved.status, "resolved");
    assert.equal(decrypt(JSON.parse(resolved.localPayload!).content), "PUBLIC_FIXTURE_PRIVATE_RIGHT");
    assert.equal(decrypt(JSON.parse(resolved.remotePayload!).content), "PUBLIC_FIXTURE_PRIVATE_LEFT");
    await be.syncOnce(); assert.equal(read(getDb()).content, left);
    for (const db of [a.db, b.db, getDb()]) {
      for (const table of ["notes", "sync_outbox", "sync_conflicts"]) {
        const rows = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
        for (const marker of ["PUBLIC_FIXTURE_PRIVATE_LEFT", "PUBLIC_FIXTURE_PRIVATE_RIGHT", vector.passphrase]) assert.equal(rows.includes(marker), false);
      }
    }
  } finally { ae.stop(); be.stop(); }
});

test("pull and conflict ledger reject downgrades and malformed envelopes before touching local pending edits", async () => {
  const installation = device("invalid-download"); await bootstrap(installation);
  const current = read(installation.db);
  installation.db.prepare("UPDATE notes SET isPinned = 1 WHERE id = ?").run(note.id);
  assert.ok(listPendingMutations(installation.db, 100, installation.profileId).some((item) => item.entityId === note.id));
  for (const patch of [{ content: malformed }, { content: "must-never-persist", contentFormat: "markdown" }, { contentText: "must-never-persist" }]) {
    const payload = { ...current, ...patch };
    assert.throws(() => applyRemoteChanges(installation.db, [{ entityType: "note", entityId: note.id, operation: "upsert", payload }], { userId: installation.userId }), { code: "INVALID_PAYLOAD" });
    assert.throws(() => recordConflict(installation.db, { profileId: installation.profileId, entityType: "note", entityId: note.id, localPayload: current, remotePayload: payload }), { code: "INVALID_PAYLOAD" });
  }
  const id = recordConflict(installation.db, { profileId: installation.profileId, entityType: "note", entityId: note.id, localPayload: current, remotePayload: current });
  assert.throws(() => fillRemotePayload(installation.db, "note", note.id, { ...current, content: malformed }), { code: "INVALID_PAYLOAD" });
  assert.equal(JSON.parse(getConflict(installation.db, id)!.remotePayload!).content, current.content);
  assert.equal(read(installation.db).content, current.content);
});

test("a malformed Push conflict response returns local ciphertext to pending instead of stranding inflight mutations", async () => {
  const installation = device("malformed-push"); await bootstrap(installation);
  const ready = engine(installation);
  try { assert.equal((await ready.syncOnce()).state, "idle"); } finally { ready.stop(); }
  const current = read(installation.db);
  const localCiphertext = encryptedVersion("PUBLIC_FIXTURE_PENDING_PRIVATE");
  installation.db.prepare("UPDATE notes SET content = ?, version = version + 1 WHERE id = ?").run(localCiphertext, note.id);
  const pushed = await client().push("remote-fixture-installation", [{ mutationId: "public-fixture-advance", entityType: "note", entityId: note.id, operation: "upsert", baseVersion: current.version, payload: { ...read(getDb()) } }]);
  assert.equal(pushed.results[0].status, "applied");
  const rejecting = engine(installation, client({ corruptPushConflicts: true }));
  try {
    assert.notEqual((await rejecting.syncOnce()).state, "idle");
    assert.equal(read(installation.db).content, localCiphertext);
    assert.equal(decrypt(read(installation.db).content), "PUBLIC_FIXTURE_PENDING_PRIVATE");
    assert.equal(listUnresolvedConflicts(installation.db, installation.profileId).length, 0);
    const pending = listPendingMutations(installation.db, 100, installation.profileId);
    assert.ok(pending.some((item) => item.entityId === note.id && item.status === "pending"));
    assert.equal((installation.db.prepare("SELECT count(*) AS count FROM sync_outbox WHERE status = 'inflight'").get() as any).count, 0);
  } finally { rejecting.stop(); }
});

test("regional ciphertext survives bootstrap, modern Push/Pull, conflict choices and legacy write rejection", async () => {
  const block = structuredClone(vector.envelope); block.kind = "block";
  function seal(bytes: Buffer, key: Buffer, aad: string) {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(aad));
    return { iv: iv.toString("base64"), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString("base64") };
  }
  const keyAAD = vector.aadKeyUtf8.replace('"note"', '"block"');
  const contentAAD = vector.aadContentUtf8.replace('"note"', '"block"');
  block.wrappedKey = seal(dek, Buffer.from(vector.derivedKeyHex, "hex"), keyAAD);
  block.payload = seal(Buffer.from("PRIVATE_ENCRYPTED_M3_SENTINEL"), dek, contentAAD);
  const source = JSON.stringify(block);
  const content = `Public region before\n\n\`\`\`nowen-encrypted-v1\n${source}\n\`\`\``;
  getDb().prepare("INSERT INTO notebooks (id, name, userId) VALUES ('sync-block-book', 'Public book', 'server-owner')").run();
  const created = await app.request("/notes", { method: "POST", headers: { "X-User-Id": "server-owner", "Content-Type": "application/json" }, body: JSON.stringify({ notebookId: "sync-block-book", title: "Public region metadata", content, contentFormat: "markdown", encryptedBlocksVersion: 1 }) });
  assert.equal(created.status, 201); const regional = await created.json() as any;
  const a = device("region-a"); const b = device("region-b");
  await bootstrap(a); await bootstrap(b);
  const row = (db: Database.Database) => db.prepare("SELECT * FROM notes WHERE id = ?").get(regional.id) as any;
  for (const local of [a, b]) assert.ok(row(local.db).content.includes(source));
  const ae = engine(a), be = engine(b);
  try {
    assert.equal((await ae.syncOnce()).state, "idle");
    assert.equal((await be.syncOnce()).state, "idle");
    const changedContent = row(a.db).content.replace("Public region before", "Public region changed");
    withEncryptedBlockWrite(a.db, regional.id, changedContent, "markdown", () =>
      a.db.prepare("UPDATE notes SET content = ?, version = version + 1 WHERE id = ?").run(changedContent, regional.id));
    assert.equal((await ae.syncOnce()).state, "idle");
    assert.equal((await be.syncOnce()).state, "idle");
  } finally { ae.stop(); be.stop(); }
  assert.ok(row(getDb()).content.includes("Public region changed"));
  assert.ok(row(b.db).content.includes(source));
  assert.ok(row(b.db).content.includes("Public region changed"));
  const current = row(getDb());
  // Raw old-client transport deliberately bypasses the modern SyncRemoteClient declaration.
  const rejected = await app.request(`${SYNC_V2_BASE_PATH}/push?scopeKey=personal`, { method: "POST", headers: { "X-User-Id": "server-owner", "Content-Type": "application/json" }, body: JSON.stringify({ scopeKey: "personal", deviceId: "legacy-region-device", mutations: [{ mutationId: "legacy-region-erase", entityType: "note", entityId: regional.id, operation: "upsert", baseVersion: current.version, payload: { ...current, content: "legacy public replacement" } }] }) });
  assert.equal(rejected.status, 200); const rejectedBody = await rejected.json() as any;
  assert.equal(rejectedBody.results[0].status, "conflict"); assert.equal(rejectedBody.results[0].code, "INVALID_PAYLOAD");
  assert.ok(row(getDb()).content.includes(source));
  const conflictId = recordConflict(a.db, { profileId: a.profileId, entityType: "note", entityId: regional.id, localPayload: row(a.db), remotePayload: { ...current, encryptedBlocksVersion: 1 }, remoteVersion: current.version });
  assert.throws(() => applyConflictResolution(a.db, { conflictId, resolution: "manual", mergedPayload: current, userId: a.userId, deviceId: a.deviceId }), { code: "INVALID_PAYLOAD" });
  applyConflictResolution(a.db, { conflictId, resolution: "keep-local", userId: a.userId, deviceId: a.deviceId });
  assert.ok(row(a.db).content.includes(source));
  assert.equal(open(block.payload, dek, contentAAD).toString(), "PRIVATE_ENCRYPTED_M3_SENTINEL");
  for (const db of [getDb(), a.db, b.db]) {
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM notes WHERE id = ?").get(regional.id)).includes("PRIVATE_ENCRYPTED_M3_SENTINEL"));
  }
});

// @vitest-environment node
import { createRequire } from "node:module";
import type { SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openNativeDatabase, type NativeDatabase } from "../nativeDatabase";
import { migrateMobileLocalAccount } from "../mobileLocalAccountMigration";
import type { NativeAttachmentStore } from "../nativeAttachmentStore";

// node:sqlite is available on Node >=22.13; keep older frontend-only runners usable.
let DatabaseSync: typeof import("node:sqlite").DatabaseSync | undefined;
try { ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite")); } catch { /* Covered by the suite skip below. */ }

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("../localRepository", () => ({ newLocalId: () => randomUUID() }));
vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    connections = new Map();
    async checkConnectionsConsistency() { return { result: true }; }
    async isConnection(name: string) { return { result: this.connections.has(name) }; }
    async retrieveConnection(name: string) { return this.connections.get(name); }
    async createConnection(name: string) {
      const sqlite = new DatabaseSync!(":memory:");
      const raw = {
        isDBOpen: async () => ({ result: true }),
        execute: async (sql: string) => { sqlite.exec(sql); },
        query: async (sql: string, values: SQLInputValue[] = []) => ({ values: sqlite.prepare(sql).all(...values) }),
        run: async (sql: string, values: SQLInputValue[] = []) => {
          const result = sqlite.prepare(sql).run(...values);
          return { changes: { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) } };
        },
        close: async () => { sqlite.close(); },
      };
      this.connections.set(name, raw);
      return raw;
    }
    async closeConnection(name: string) { await this.connections.get(name).close(); this.connections.delete(name); }
  },
}));

let sourceDb: NativeDatabase;
let targetDb: NativeDatabase;
const stamp = "2026-10-07T00:00:00Z";
const sourceFiles = { read: vi.fn(async () => new Blob(["image"])) };
const targetFiles = { save: vi.fn(async ({ attachmentId }: { attachmentId: string }) => ({ path: attachmentId, size: 5, sha256: "hash" })) };
const migrate = () => migrateMobileLocalAccount({
  sourceDb, targetDb, sourceAttachments: sourceFiles as unknown as NativeAttachmentStore,
  targetAttachments: targetFiles as unknown as NativeAttachmentStore,
  targetUserId: "account", profileId: "profile", deviceId: "device",
});
const all = (table: string) => targetDb.query<Record<string, unknown>>(`SELECT * FROM ${table}`);
const marker = async () => JSON.parse((await targetDb.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key='mobileLocalAccountMigrationV1'"))[0].value);
async function note(id = "n1", content = "first") {
  await sourceDb.run("INSERT INTO notes (id,scopeKey,userId,notebookId,title,content,createdAt,updatedAt) VALUES (?,'personal','guest','b1','Note',?,?,?)", [id,content,stamp,stamp]);
}
beforeEach(async () => {
  sourceFiles.read.mockClear(); targetFiles.save.mockClear();
  sourceDb = await openNativeDatabase("source-" + randomUUID());
  targetDb = await openNativeDatabase("target-" + randomUUID());
  await sourceDb.run("INSERT INTO notebooks (id,scopeKey,userId,name,createdAt,updatedAt) VALUES ('b1','personal','guest','Book',?,?)", [stamp,stamp]);
  await targetDb.run("INSERT INTO sync_profiles (id,name,serverUrl,enabled,createdAt,updatedAt) VALUES ('profile','Account','https://server',1,?,?)", [stamp,stamp]);
  await targetDb.run("INSERT INTO sync_devices (profileId,deviceId,platform,createdAt) VALUES ('profile','device','android',?)", [stamp]);
});
afterEach(async () => { await sourceDb.close(); await targetDb.close(); });

describe.skipIf(!DatabaseSync)("Android incremental device-only import with real SQLite", () => {
  it("imports again after complete, without replaying old entities", async () => {
    await note(); await migrate();
    const first = await all("notes");
    await targetDb.run("DELETE FROM sync_outbox");
    await note("n2", "second"); await migrate();
    expect((await all("notes")).map((row) => row.content).sort()).toEqual(["first", "second"]);
    const queue = await all("sync_outbox");
    expect(queue).toHaveLength(1);
    expect(queue[0].entityId).not.toBe(first[0].id);
    await migrate();
    expect(await all("sync_outbox")).toHaveLength(1);
  });
  it("updates an imported note and creates a fresh mutation after ACK", async () => {
    await note(); await migrate();
    const [old] = await all("notes");
    const oldMutation = (await all("sync_outbox")).find((row) => row.entityType === "note")!.mutationId;
    await targetDb.run("DELETE FROM sync_outbox");
    await sourceDb.run("UPDATE notes SET content='edited',version=2 WHERE id='n1'");
    await migrate();
    const [edited] = await all("notes");
    expect(edited.id).toBe(old.id); expect(edited.content).toBe("edited");
    const [mutation] = await all("sync_outbox");
    expect(mutation.mutationId).not.toBe(oldMutation); expect(mutation.baseVersion).toBe(1);
  });
  it("preserves account edits, forks a changed device copy and remains idempotent", async () => {
    await note(); await migrate();
    const [account] = await all("notes");
    await targetDb.run("UPDATE notes SET content='account edit',version=2 WHERE id=?", [account.id]);
    await targetDb.run("DELETE FROM sync_outbox");
    await migrate();
    expect(await all("sync_outbox")).toHaveLength(0);
    await sourceDb.run("UPDATE notes SET content='device edit' WHERE id='n1'");
    await migrate(); await migrate();
    expect((await all("notes")).map((row) => row.content).sort()).toEqual(["account edit", "device edit"]);
    expect(await all("sync_outbox")).toHaveLength(1);
  });
  it("upgrades an old complete marker, conservatively preserving ambiguous edits", async () => {
    await note(); await migrate();
    const saved = await marker(); delete saved.versions;
    await targetDb.run("UPDATE native_runtime_meta SET value=? WHERE key='mobileLocalAccountMigrationV1'", [JSON.stringify(saved)]);
    await targetDb.run("DELETE FROM sync_outbox");
    await sourceDb.run("UPDATE notes SET content='new device edit' WHERE id='n1'");
    await note("n2");
    await migrate();
    expect(await all("notes")).toHaveLength(3);
    expect(await all("sync_outbox")).toHaveLength(2);
  });
  it("does not resurrect an account deletion unless the device copy is edited", async () => {
    await note(); await migrate();
    await targetDb.run("DELETE FROM notes"); await targetDb.run("DELETE FROM sync_outbox");
    await migrate(); expect(await all("notes")).toHaveLength(0);
    await sourceDb.run("UPDATE notes SET content='new edit' WHERE id='n1'"); await migrate();
    expect(await all("notes")).toHaveLength(1);
    await sourceDb.run("DELETE FROM notes"); await migrate();
    expect(await all("notes")).toHaveLength(1);
  });
  it("imports new device notes after their old account folder was deleted", async () => {
    await note(); await migrate();
    await targetDb.run("DELETE FROM notebooks"); await targetDb.run("DELETE FROM sync_outbox");
    await migrate(); expect(await all("notebooks")).toHaveLength(0);
    await note("n2", "new device note"); await migrate();
    expect((await all("notes")).map((row) => row.content)).toEqual(["new device note"]);
    expect(await all("notebooks")).toHaveLength(1);
    expect(await all("sync_outbox")).toHaveLength(2);
  });
  it("imports all module entities and remaps their relationships", async () => {
    await note();
    await sourceDb.run("INSERT INTO tasks (id,userId,title,noteId,createdAt,updatedAt) VALUES ('t1','guest','Task','n1',?,?)", [stamp,stamp]);
    await sourceDb.run("INSERT INTO task_reminders (id,taskId,userId,createdAt,updatedAt) VALUES ('r1','t1','guest',?,?)", [stamp,stamp]);
    await sourceDb.run("INSERT INTO diaries (id,userId,contentText,createdAt) VALUES ('d1','guest','Diary',?)", [stamp]);
    await sourceDb.run("INSERT INTO mindmaps (id,userId,title,data,createdAt,updatedAt) VALUES ('m1','guest','Map','{}',?,?)", [stamp,stamp]);
    await sourceDb.run("INSERT INTO tags (id,userId,name,createdAt,updatedAt) VALUES ('tag1','guest','Tag',?,?)", [stamp,stamp]);
    await sourceDb.run("INSERT INTO note_tags (noteId,tagId,createdAt) VALUES ('n1','tag1',?)", [stamp]);
    await sourceDb.run("INSERT INTO favorites (userId,noteId,createdAt) VALUES ('guest','n1',?)", [stamp]);
    await migrate();
    const saved = await marker();
    expect((await all("tasks"))[0].noteId).toBe(saved.notes.n1);
    expect((await all("task_reminders"))[0].taskId).toBe(saved.tasks.t1);
    expect((await all("note_tags"))[0].tagId).toBe(saved.tags.tag1);
    expect((await all("favorites"))[0].userId).toBe("account");
    expect(await all("sync_outbox")).toHaveLength(9);
    await migrate(); expect(await all("sync_outbox")).toHaveLength(9);
  });
  it("retries failed attachment copies without duplicating notes or old mutations", async () => {
    await note();
    await sourceDb.run("INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,hash,localPath,available,createdAt,updatedAt) VALUES ('a1','n1','guest','image','image/png',5,'hash','source/a1',1,?,?)", [stamp,stamp]);
    sourceFiles.read.mockRejectedValueOnce(new Error("read failed"));
    await migrate(); expect((await marker()).status).toBe("running");
    expect(await all("attachments")).toHaveLength(0);
    await migrate(); await migrate();
    expect(await all("attachments")).toHaveLength(1);
    expect(await all("sync_outbox")).toHaveLength(3);
    expect(targetFiles.save).toHaveBeenCalledTimes(1);
  });
  it("rolls back imported entities, outbox and entity versions together", async () => {
    await note();
    await targetDb.run("CREATE TRIGGER fail_note BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT,'test failure'); END");
    await expect(migrate()).rejects.toThrow("test failure");
    expect(await all("notebooks")).toHaveLength(0);
    expect(await all("sync_outbox")).toHaveLength(0);
    expect((await marker()).versions).toEqual({});
    await targetDb.run("DROP TRIGGER fail_note"); await migrate();
    expect(await all("notes")).toHaveLength(1); expect(await all("sync_outbox")).toHaveLength(2);
  });
  it("keeps the account note's attachments when importing a divergent device copy", async () => {
    await note("n1", "![image](/api/attachments/a1)");
    await sourceDb.run("INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,hash,localPath,available,createdAt,updatedAt) VALUES ('a1','n1','guest','image','image/png',5,'hash','source/a1',1,?,?)", [stamp,stamp]);
    await migrate();
    const [original] = await all("notes");
    const [attachment] = await all("attachments");
    expect(original.content).toBe(`![image](/api/attachments/${attachment.id})`);
    await targetDb.run("UPDATE notes SET content='account edit' WHERE id=?", [original.id]);
    await sourceDb.run("UPDATE notes SET content='device edit ![image](/api/attachments/a1)' WHERE id='n1'");
    await targetDb.run("DELETE FROM sync_outbox");
    await migrate(); await migrate();
    const copies = await all("notes"), files = await all("attachments");
    expect(files).toHaveLength(2);
    expect(files.find((row) => row.id === attachment.id)?.noteId).toBe(original.id);
    const copy = copies.find((row) => row.id !== original.id)!;
    expect(copy.title).toBe("Note（仅此设备副本）");
    const copiedFile = files.find((row) => row.noteId === copy.id)!;
    expect(copy.content).toBe(`device edit ![image](/api/attachments/${copiedFile.id})`);
    const mutation = (await all("sync_outbox")).find((row) => row.entityType === "note")!;
    expect(JSON.parse(String(mutation.payload)).content).toBe(copy.content);
    expect(await all("sync_outbox")).toHaveLength(2);
  });
  it("keeps a forked attachment ID stable when its first copy fails", async () => {
    await note("n1", "![image](/api/attachments/a1)");
    await sourceDb.run("INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,hash,localPath,available,createdAt,updatedAt) VALUES ('a1','n1','guest','image','image/png',5,'hash','source/a1',1,?,?)", [stamp,stamp]);
    await migrate();
    await targetDb.run("UPDATE notes SET content='account edit'");
    await sourceDb.run("UPDATE notes SET content='device edit ![image](/api/attachments/a1)'");
    sourceFiles.read.mockRejectedValueOnce(new Error("copy interrupted"));
    await migrate();
    const saved = await marker(), copyId = saved.attachments.a1;
    await migrate();
    expect((await marker()).attachments.a1).toBe(copyId);
    expect((await all("attachments")).some((row) => row.id === copyId)).toBe(true);
    expect((await all("notes")).find((row) => row.id === saved.notes.n1)?.content).toContain(copyId);
  });
});

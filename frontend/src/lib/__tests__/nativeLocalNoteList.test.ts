import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NativeLocalRepository } from "../nativeLocalRepository";
import { MOBILE_SYNC_STATUS_CHANGED_EVENT } from "../mobileSyncStatus";
import { readNativeNoteSyncReceipt, nativeReceiptKey } from "../mobileNoteSyncReceipt";
import type { NativeDatabase } from "../nativeDatabase";

interface SqliteDatabase {
  run(sql: string, values?: unknown[]): void;
  getRowsModified(): number;
  prepare(sql: string): { bind(values: unknown[]): void; step(): boolean; getAsObject(): Record<string, unknown>; free(): void };
  close(): void;
}
const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js") as (options: { wasmBinary: Uint8Array }) => Promise<{ Database: new () => SqliteDatabase }>;
let SQLite: Awaited<ReturnType<typeof initSqlJs>>;
let sqlite: SqliteDatabase;
let db: NativeDatabase;
let repository: NativeLocalRepository;
let bridgeResults: unknown[][];

beforeAll(async () => { SQLite = await initSqlJs({ wasmBinary: readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm")) }); });
beforeEach(async () => {
  sqlite = new SQLite.Database();
  bridgeResults = [];
  db = {
    async run(sql, values = []) { sqlite.run(sql, values); return { changes: sqlite.getRowsModified() }; },
    async query<T>(sql: string, values: unknown[] = []) {
      const statement = sqlite.prepare(sql);
      try {
        statement.bind(values);
        const rows: T[] = [];
        while (statement.step()) rows.push(statement.getAsObject() as T);
        // Capture the raw query result that the native bridge would serialize.
        bridgeResults.push(rows);
        return rows;
      } finally { statement.free(); }
    },
    async transaction(work) { return work(db); },
    async close() { sqlite.close(); },
  };
  const source = readFileSync(require.resolve("../nativeDatabase.ts"), "utf8");
  const scopeCheck = source.match(/const SCOPE_CHECK = `([\s\S]*?)`;/)![1];
  const entityTypes = source.match(/const ENTITY_TYPE_CHECK = `([\s\S]*?)`;/)![1];
  for (const [, sql] of source.matchAll(/`(CREATE TABLE IF NOT EXISTS [\s\S]*?)`/g)) {
    sqlite.run(sql.replaceAll("${SCOPE_CHECK}", scopeCheck).replaceAll("${ENTITY_TYPE_CHECK}", entityTypes));
  }
  await db.run("INSERT INTO notebooks (id,userId,name,createdAt,updatedAt) VALUES ('book','user','Book','now','now')");
  repository = new NativeLocalRepository({ db, attachments: {} as never, accountId: "account", userId: "user", getScopeKey: () => "personal" });
});
afterEach(async () => { await db.close(); });

async function insertNote(id: string, content = "full body", contentText = "preview", title = id) {
  await db.run(`INSERT INTO notes (id,userId,notebookId,title,content,contentText,contentFormat,colorMark,isPinned,isFavorite,version,sortOrder,createdAt,updatedAt)
    VALUES (?,'user','book',?,?,?,'markdown','blue',1,1,7,3,'created','updated')`, [id,title,content,contentText]);
}

describe("PR #821 native committed-write receipt notifications", () => {
  it.each(["markdown", "tiptap-json"])("refreshes a %s note only after the new Outbox mutation is committed", async (format) => {
    await db.run("INSERT INTO sync_profiles (id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt) VALUES ('profile','A','https://example.com','user',1,'now','now')");
    await db.run("INSERT INTO sync_devices (profileId,deviceId,platform,createdAt) VALUES ('profile','device','android','now')");
    await insertNote("receipt-note");
    await db.run("UPDATE notes SET contentFormat=? WHERE id='receipt-note'", [format]);
    await db.run("INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)", [
      nativeReceiptKey("profile", "receipt-note"),
      JSON.stringify({ mutationId:"previous-ack", serverVersion:7 }), "now",
    ]);
    expect((await readNativeNoteSyncReceipt(db, "profile", "receipt-note")).phase).toBe("confirmed");
    const observed: Array<Promise<string>> = [];
    const onChanged = () => observed.push(
      readNativeNoteSyncReceipt(db, "profile", "receipt-note").then((result) => result.phase),
    );
    window.addEventListener(MOBILE_SYNC_STATUS_CHANGED_EVENT, onChanged);
    try {
      await repository.notes.update("receipt-note", { content:"new local text" });
      expect(observed).toHaveLength(1);
      expect(await observed[0]).toBe("pending");
      const rows = await db.query<{mutationId:string}>(
        "SELECT mutationId FROM sync_outbox WHERE entityType='note' AND entityId='receipt-note'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].mutationId).not.toBe("previous-ack");
    } finally {
      window.removeEventListener(MOBILE_SYNC_STATUS_CHANGED_EVENT, onChanged);
    }
  });
});

describe("native note list bridge payloads", () => {
  it("bounds raw list results for many large notes while detail reads preserve the entire body", async () => {
    const body = "正文".repeat(64_000);
    const text = "预览".repeat(8_000);
    for (let index = 0; index < 64; index++) await insertNote(`note-${index}`, body, text);
    const notes = await repository.listNotesForWorkspace(undefined);
    expect(notes).toHaveLength(64);
    for (const note of notes) {
      expect(Object.keys(note)).not.toContain("content");
      expect(note.contentText).toBe(text.slice(0,2000));
      expect(note).toMatchObject({ notebookId:"book",contentFormat:"markdown",colorMark:"blue",isPinned:1,isFavorite:1,version:7,sortOrder:3,createdAt:"created",updatedAt:"updated" });
    }
    expect(JSON.stringify(bridgeResults[0]).length).toBeLessThan(160_000);
    const detail = await repository.notes.get("note-0");
    expect(detail?.content).toBe(body);
    expect(detail?.contentText).toBe(text);
    expect((await repository.notes.list({ limit:2,offset:2 })).map((note) => note.id)).toEqual(notes.slice(2,4).map((note) => note.id));
  });

  it("bounds single and multiple tag lists and still requires every selected tag", async () => {
    await insertNote("both", "x".repeat(1_000_000), "y".repeat(50_000));
    await insertNote("one");
    for (const tagId of ["a","b"]) await db.run("INSERT INTO tags (id,userId,name,createdAt,updatedAt) VALUES (?,'user',?,'now','now')", [tagId,tagId]);
    for (const [noteId,tagId] of [["both","a"],["both","b"],["one","a"]]) {
      await db.run("INSERT INTO note_tags (noteId,tagId,createdAt) VALUES (?,?,'now')", [noteId,tagId]);
    }
    const single = await repository.notes.list({ tagId:"a" });
    const multiple = await repository.listNotesWithTags(["a","b","a"]);
    expect(single).toHaveLength(2);
    expect(multiple.map((note) => note.id)).toEqual(["both"]);
    for (const rows of bridgeResults) for (const row of rows as Record<string, unknown>[]) {
      expect(Object.keys(row)).not.toContain("content");
      expect(String(row.contentText).length).toBeLessThanOrEqual(2000);
    }
  });

  it("searches beyond the preview boundary and returns a bounded excerpt around the match", async () => {
    await insertNote("late", "x".repeat(1_000_000), `${"前".repeat(12_000)}Needle${"后".repeat(12_000)}`, "other");
    await insertNote("title", "large body", "title-only preview", "NEEDLE in title");
    await insertNote("both", "large body", "针在正文里", "标题也有针");
    const results = await repository.searchNotes("needle");
    expect(results.find((note) => note.id === "late")).toMatchObject({ snippet:`${"前".repeat(60)}Needle${"后".repeat(100)}`,matchedField:"content" });
    expect(results.find((note) => note.id === "title")).toMatchObject({ snippet:"title-only preview",matchedField:"title" });
    expect(JSON.stringify(bridgeResults[0]).length).toBeLessThan(2000);
    expect((await repository.searchNotes("针"))[0]).toMatchObject({ id:"both",matchedField:"title+content" });
    expect(await repository.searchNotes("   ")).toEqual([]);
    expect(await repository.searchNotes("absent")).toEqual([]);
  });

  it("keeps scope, trash, archive and full-text filters on lightweight list results", async () => {
    for (const id of ["normal","trashed","archived"]) await insertNote(id, "body", `${"x".repeat(4000)}late-hit`);
    await db.run("UPDATE notes SET isTrashed=1 WHERE id='trashed'");
    await db.run("UPDATE notes SET isArchived=1 WHERE id='archived'");
    await db.run("INSERT INTO notebooks (id,scopeKey,workspaceId,userId,name,createdAt,updatedAt) VALUES ('book','workspace:team','team','user','Team','now','now')");
    await db.run("INSERT INTO notes (id,scopeKey,workspaceId,userId,notebookId,createdAt,updatedAt) VALUES ('team-note','workspace:team','team','user','book','now','now')");
    expect((await repository.notes.list({ keyword:"late-hit" })).map((note) => note.id)).toEqual(["normal"]);
    expect((await repository.notes.list({ trashedOnly:true })).map((note) => note.id)).toEqual(["trashed"]);
    expect(await repository.notes.list({ includeArchived:true })).toHaveLength(2);
    expect((await repository.listNotesForWorkspace("team")).map((note) => note.id)).toEqual(["team-note"]);
  });
});

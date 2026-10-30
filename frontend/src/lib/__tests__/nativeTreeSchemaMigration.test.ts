import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { openNativeDatabase } from "../nativeDatabase";
import { NATIVE_TASK_REPEAT_FIELDS, nativeTaskRepeatValues } from "../nativeTaskFields";
import { cacheConfirmedNativeTasks } from "../nativeTaskComposerCache";
import type { Task } from "@/types";
import { installMobileLocalModuleBridge } from "../mobileLocalModuleBridge";
import { api } from "../api";
import { NativeLocalRepository } from "../nativeLocalRepository";
import { ensureMobileLocalTaskSchema } from "../mobileLocalAdvancedTaskBridge";
import { updateRepeatingTaskOnline } from "../taskComposerApi";

vi.mock("../taskComposerApi", () => ({ registerTaskComposerCache: () => () => undefined, updateRepeatingTaskOnline: vi.fn(), getTaskComposerContext: () => ({}), isTaskComposerContextCurrent: () => true, TaskComposerApiError: class extends Error {} }));
vi.mock("../mobileLocalMode", () => ({ isMobileLocalMode: () => false }));

const fixture = vi.hoisted(() => ({ raw: undefined as unknown as DatabaseSync, fail: false, failTree: false }));
const { DatabaseSync: SQLiteDatabase } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: {}, SQLiteConnection: class {
    async checkConnectionsConsistency() { return {result:true}; }
    async isConnection() { return {result:false}; }
    async closeConnection() {}
    async createConnection() { return {
      isDBOpen: async () => ({result:true}), close: async () => {},
      execute: async (sql:string) => {
        if (fixture.fail && sql === "ALTER TABLE sync_conflicts_v2 RENAME TO sync_conflicts") throw new Error("Migration interruption");
        if (fixture.failTree && sql === "ALTER TABLE native_knowledge_tree_nodes_v12 RENAME TO native_knowledge_tree_nodes") throw new Error("Tree migration interruption");
        fixture.raw.exec(sql); return {};
      },
      run: async (sql:string, values: never[] = []) => ({changes:fixture.raw.prepare(sql).run(...values)}),
      query: async (sql:string, values: never[] = []) => ({values:fixture.raw.prepare(sql).all(...values)}),
    }; }
  },
}));

beforeEach(() => {
  Reflect.deleteProperty(globalThis,"__nowenNoteNativeDatabaseState");
  fixture.failTree = false; fixture.fail = false; fixture.raw = new SQLiteDatabase(":memory:");
  fixture.raw.exec("PRAGMA foreign_keys=ON");
  const source = readFileSync(new NodeURL("../nativeDatabase.ts",import.meta.url),"utf8");
  const scope = source.match(/const SCOPE_CHECK = `([\s\S]*?)`;/)![1];
  const types = source.match(/const ENTITY_TYPE_CHECK = `([\s\S]*?)`;/)![1].replace(", 'knowledge_tree_node'","").replace(", 'attachment_organization'","");
  for (let [,sql] of source.matchAll(/`(CREATE TABLE IF NOT EXISTS [\s\S]*?)`/g)) {
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS native_knowledge_tree_nodes")) {
      sql = sql.replace("sortOrder INTEGER NOT NULL,", "sortOrder INTEGER NOT NULL CHECK (sortOrder >= 0),");
    }
    fixture.raw.exec(sql.replaceAll("${SCOPE_CHECK}",scope).replaceAll("${ENTITY_TYPE_CHECK}",types));
  }
  fixture.raw.exec(`PRAGMA user_version=6;
    INSERT INTO sync_profiles(id,name,serverUrl,remoteUserId,createdAt,updatedAt) VALUES ('p','fixture','http://localhost','u','now','now');
    INSERT INTO sync_devices(profileId,deviceId,platform,createdAt) VALUES ('p','d','android','now');
    INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,baseVersion,payload,status,retryCount,lastAttemptAt,lastError,createdAt)
      VALUES ('o','stable-mutation','p','d','personal','note','n','upsert',17,'{"content":"fixture"}','inflight',4,'attempt','NETWORK_UNAVAILABLE','created');
    INSERT INTO sync_conflicts(id,profileId,scopeKey,entityType,entityId,localVersion,remoteVersion,basePayload,localPayload,remotePayload,status,createdAt,resolvedAt)
      VALUES ('c','p','personal','note','n',18,19,'{}','{"side":"local"}','{"side":"remote"}','resolved','created','resolved');`);
});
afterEach(() => { fixture.raw.close(); Reflect.deleteProperty(globalThis,"__nowenNoteNativeDatabaseState"); });

it("migrates schema 6 queues without losing mutation identity, retries, versions or resolved history", async () => {
  const before = fixture.raw.prepare("SELECT * FROM sync_outbox").all(), history = fixture.raw.prepare("SELECT * FROM sync_conflicts").all();
  const db = await openNativeDatabase("tree-migration-fixture");
  expect(fixture.raw.prepare("SELECT * FROM sync_outbox").all()).toEqual(before);
  expect(fixture.raw.prepare("SELECT * FROM sync_conflicts").all()).toEqual(history);
  expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({user_version: 12});
  await db.run(`INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,createdAt)
    VALUES ('tree','tree-mutation','p','d','personal','knowledge_tree_node','note:n','upsert','now')`);
  expect(fixture.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  await db.close();
});

it("rolls back both queue rebuilds and schema version when the second rebuild fails", async () => {
  const before = fixture.raw.prepare("SELECT * FROM sync_outbox").all(), history = fixture.raw.prepare("SELECT * FROM sync_conflicts").all();
  fixture.fail = true;
  await expect(openNativeDatabase("tree-migration-fixture")).rejects.toThrow("Migration interruption");
  expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({user_version:6});
  expect(fixture.raw.prepare("SELECT * FROM sync_outbox").all()).toEqual(before);
  expect(fixture.raw.prepare("SELECT * FROM sync_conflicts").all()).toEqual(history);
  expect(fixture.raw.prepare("SELECT sql FROM sqlite_master WHERE name='sync_outbox'").get()?.sql).not.toContain("knowledge_tree_node");
});

it("upgrades schema 7 task recurrence and caches confirmed batches without overwriting edits or Outbox", async () => {
  fixture.raw.exec("PRAGMA user_version=7; INSERT INTO tasks(id,userId,title,createdAt,updatedAt) VALUES ('old','local','Preserved','now','now')");
  const before = fixture.raw.prepare("SELECT * FROM sync_outbox").all();
  const db = await openNativeDatabase("task-composer-fixture");
  expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
  expect(fixture.raw.prepare("SELECT title,repeatRule FROM tasks WHERE id='old'").get()).toEqual({ title: "Preserved", repeatRule: "none" });
  const task = { id: "confirmed", workspaceId: null, userId: "remote", title: "Daily study", description: "Practice", priority: 2, isCompleted: 0, dueDate: "2026-12-31", dueAt: "2026-12-31T09:00", repeatRule: "daily", repeatInterval: 1, repeatEndCount: 7, createdAt: "now", updatedAt: "now" } as Task;
  await cacheConfirmedNativeTasks(db, "local", [task], [{ id: "remote-project", userId: "remote", workspaceId: null, name: "Server project", icon: "", color: "#123456", sortOrder: 0, createdAt: "now", updatedAt: "now" }]);
  expect(await db.query("SELECT name,userId FROM mobile_local_task_projects WHERE id='remote-project'")).toEqual([{ name: "Server project", userId: "local" }]);
  const row = fixture.raw.prepare("SELECT title,dueAt,repeatRule,repeatEndCount,userId FROM tasks WHERE id='confirmed'").get();
  expect(row).toEqual({ title: "Daily study", dueAt: "2026-12-31T09:00", repeatRule: "daily", repeatEndCount: 7, userId: "local" });
  await db.run("UPDATE tasks SET title='Local edit' WHERE id='confirmed'");
  await cacheConfirmedNativeTasks(db, "local", [task]);
  expect(fixture.raw.prepare("SELECT title FROM tasks WHERE id='confirmed'").get()).toEqual({ title: "Local edit" });
  expect(fixture.raw.prepare("SELECT * FROM sync_outbox").all()).toEqual(before);
  await db.close();
});

it("native recurring completion uses the canonical online route, caches its successor and preserves pending edits", async () => {
  vi.mocked(updateRepeatingTaskOnline).mockReset();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  const db = await openNativeDatabase("task-repeat-fixture");
  const task = { id: "repeat", workspaceId: null, userId: "local", title: "Study", priority: 2, isCompleted: 0, dueDate: "2026-12-31", repeatRule: "daily", repeatInterval: 1, repeatEndCount: 7, createdAt: "now", updatedAt: "now" } as Task;
  await cacheConfirmedNativeTasks(db, "local", [task]);
  const successor = { ...task, id: "next", dueDate: "2027-01-01", repeatSequenceIndex: 2 };
  vi.mocked(updateRepeatingTaskOnline).mockResolvedValue({ task: { ...task, isCompleted: 1, status: "done", repeatNextGeneratedId: "next" }, generatedTask: successor });
  const restore = installMobileLocalModuleBridge({} as never, db, "local");
  try {
    const result = await api.toggleTask("repeat");
    expect(result.generatedTask?.id).toBe("next");
    expect(await db.query("SELECT dueDate,repeatEndCount FROM tasks WHERE id='next'")).toEqual([{ dueDate: "2027-01-01", repeatEndCount: 7 }]);
    expect(await db.query("SELECT id FROM sync_outbox WHERE entityType='task'")).toEqual([]);
    Object.defineProperty(navigator, "onLine", { value: false });
    await expect(api.toggleTask("next")).rejects.toThrow();
    expect((await db.query<Task>("SELECT * FROM tasks WHERE id='next'"))[0].isCompleted).toBe(0);
    Object.defineProperty(navigator, "onLine", { value: true });
    await db.run("INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,createdAt) VALUES ('task-pending','task-pending','p','d','personal','task','next','upsert','now')");
    await expect(api.toggleTask("next")).rejects.toThrow();
    expect(updateRepeatingTaskOnline).toHaveBeenCalledOnce();
    expect(await db.query("SELECT id FROM sync_outbox WHERE id='task-pending'")).toHaveLength(1);
    vi.mocked(updateRepeatingTaskOnline).mockImplementationOnce(async () => {
      await db.run("UPDATE tasks SET title='Concurrent edit' WHERE id='repeat'");
      await db.run("INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,createdAt) VALUES ('concurrent','concurrent','p','d','personal','task','repeat','upsert','now')");
      return { task: { ...task, isCompleted: 0 }, generatedTask: null };
    });
    expect((await api.toggleTask("repeat")).task?.title).toBe("Concurrent edit");
    expect(await db.query("SELECT id FROM sync_outbox WHERE id='concurrent'")).toHaveLength(1);
  } finally { restore(); await db.close(); }
});
it("upgrades schema 7 task rows without inventing archives or losing pending mutations",async () => {
  fixture.raw.exec("ALTER TABLE tasks DROP COLUMN archivedAt; PRAGMA user_version=7");
  fixture.raw.exec(`INSERT INTO tasks (id,userId,title,isCompleted,completedAt,status,createdAt,updatedAt)
    VALUES ('task','u','Historical task',1,'2026-10-12T10:00:00Z','done','created','updated')`);
  const task=fixture.raw.prepare("SELECT * FROM tasks").get();
  const outbox=fixture.raw.prepare("SELECT * FROM sync_outbox").all();
  const db=await openNativeDatabase("task-migration-fixture");
  expect(fixture.raw.prepare("SELECT * FROM tasks").get()).toEqual({...task,archivedAt:null,...Object.fromEntries(NATIVE_TASK_REPEAT_FIELDS.map((field,index) => [field,nativeTaskRepeatValues({})[index]]))});
  expect(fixture.raw.prepare("SELECT * FROM sync_outbox").all()).toEqual(outbox);
  expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({user_version: 12});
  await db.close();
});


it("upgrades lifecycle schema 8 with recurrence while preserving archives and pending mutations", async () => {
  fixture.raw.exec(`PRAGMA user_version=8;
    INSERT INTO tasks(id,userId,title,isCompleted,status,archivedAt,createdAt,updatedAt)
    VALUES ('archived','local','Preserved archive',1,'done','archive-time','created','updated')`);
  const before = fixture.raw.prepare("SELECT * FROM sync_outbox").all();
  const db = await openNativeDatabase("lifecycle-v8-fixture");
  expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
  expect(fixture.raw.prepare("SELECT title,archivedAt,repeatRule,repeatInterval FROM tasks WHERE id='archived'").get()).toEqual({
    title: "Preserved archive", archivedAt: "archive-time", repeatRule: "none", repeatInterval: 1,
  });
  expect(fixture.raw.prepare("SELECT * FROM sync_outbox").all()).toEqual(before);
  const restore = installMobileLocalModuleBridge({} as never, db, "local");
  try {
    await db.run("UPDATE tasks SET repeatRule='daily' WHERE id='archived'");
    vi.mocked(updateRepeatingTaskOnline).mockClear();
    await expect(api.toggleTask("archived")).rejects.toThrow("请先恢复已归档任务");
    expect(updateRepeatingTaskOnline).not.toHaveBeenCalled();
  } finally { restore(); await db.close(); }
});

async function recurrenceFixture() {
  const db = await openNativeDatabase("repeat-deletion-fixture");
  const repository = new NativeLocalRepository({ db, attachments:{} as never, accountId:"u",userId:"u",getScopeKey:()=>"personal" });
  for (const [id,parent,group,done] of [["root",null,null,1],["next",null,"root",0],["child","next",null,0],["grandchild","child",null,0],["other",null,null,0]] as const) {
    await db.run("INSERT INTO tasks(id,userId,title,parentId,repeatGroupId,isCompleted,repeatRule,createdAt,updatedAt) VALUES (?,'u',?,?,?,?, 'daily','created','updated')",[id,id,parent,group,done]);
  }
  return {db,repository};
}
it("native series deletion atomically removes deep descendants and queues explicit series intent",async()=>{
  const {db,repository}=await recurrenceFixture();
  await ensureMobileLocalTaskSchema(db);
  await db.run("INSERT INTO mobile_local_task_dependencies(id,userId,predecessorTaskId,successorTaskId,createdAt,updatedAt) VALUES('dep','u','grandchild','other','created','updated')");
  await db.run("INSERT INTO task_reminders(id,taskId,userId,createdAt,updatedAt) VALUES('r','grandchild','u','created','updated')");
  expect(await repository.removeTaskOccurrences("next","series")).toEqual({success:true,affected:4});
  expect((await db.query<Task>("SELECT * FROM tasks")).map(row=>row.id)).toEqual(["other"]);
  expect(await db.query("SELECT * FROM task_reminders")).toEqual([]);
  expect(await db.query("SELECT * FROM mobile_local_task_dependencies")).toEqual([]);
  expect(await db.query("SELECT id FROM task_deletion_tombstones")).toHaveLength(4);
  const queued = await db.query<{payload:string,entityId:string}>("SELECT * FROM sync_outbox WHERE entityType='task'");
  expect(queued).toHaveLength(4);
  expect(JSON.parse(queued.find(row=>row.entityId==="next")!.payload)).toMatchObject({recurrenceAction:"series",repeatGroupId:"root"});
  expect(JSON.parse(queued.find(row=>row.entityId==="grandchild")!.payload).recurrenceAction).toBe("single");
  await db.close();
});
it("native stop preserves history and survives reopening with a durable series command",async()=>{
  const {db,repository}=await recurrenceFixture();
  await repository.removeTaskOccurrences("next","stop");
  expect(await db.query("SELECT isCompleted,repeatRule FROM tasks WHERE id='root'")).toEqual([{isCompleted:1,repeatRule:"none"}]);
  expect(await db.query("SELECT * FROM tasks")).toHaveLength(5);
  const before=await db.query("SELECT * FROM sync_outbox WHERE entityType='task'");
  expect(before).toHaveLength(1);await db.close();
  const reopened=await openNativeDatabase("repeat-deletion-fixture");
  expect(await reopened.query("SELECT * FROM sync_outbox WHERE entityType='task'")).toEqual(before);
  expect(await reopened.query("SELECT action FROM task_recurrence_state")).toEqual([{action:"stop"}]);
  await reopened.close();
});
it("native deletion and stop roll back tasks and lifecycle markers when Outbox insertion fails",async()=>{
  const {db,repository}=await recurrenceFixture();const before=await db.query("SELECT * FROM tasks");
  await db.run("CREATE TRIGGER fail_task_intent BEFORE INSERT ON sync_outbox WHEN NEW.entityType='task' BEGIN SELECT RAISE(ABORT,'Outbox interruption'); END");
  for(const mode of ["stop","series"] as const){
    await expect(repository.removeTaskOccurrences("next",mode)).rejects.toThrow("Outbox interruption");
    expect(await db.query("SELECT * FROM tasks")).toEqual(before);
    expect(await db.query("SELECT * FROM task_recurrence_state")).toEqual([]);
    expect(await db.query("SELECT * FROM task_deletion_tombstones")).toEqual([]);
  }
  await db.close();
});
it("a late confirmed recurrence response cannot recreate a locally deleted series",async()=>{
  const {db,repository}=await recurrenceFixture();const stale=(await db.query<Task>("SELECT * FROM tasks WHERE id='next'"))[0];
  await repository.removeTaskOccurrences("next","series");
  await cacheConfirmedNativeTasks(db,"u",[stale,{...stale,id:"late",repeatGroupId:"root"}]);
  expect(await db.query("SELECT id FROM tasks WHERE repeatGroupId='root'")).toEqual([]);
  await db.close();
});

it("upgrades schema 10 asset queues and preserves existing local folders before binding sync",async()=>{
  const {installMobileLocalAttachmentFolderBridge}=await import("../mobileLocalAttachmentFolderBridge");
  const {NATIVE_ASSET_ENTITY_SET,nativeAssetBindingKey}=await import("../nativeAssetOrganization");
  fixture.raw.exec(`PRAGMA user_version=10;
    INSERT INTO mobile_local_attachment_folders(id,userId,name,parentId,createdAt,updatedAt) VALUES ('preserved','u','Preserved folder',NULL,'now','now');`);
  const before=fixture.raw.prepare("SELECT * FROM sync_outbox").all();
  const db=await openNativeDatabase("asset-upgrade-account");
  expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({user_version:12});
  expect(fixture.raw.prepare("SELECT * FROM sync_outbox").all()).toEqual(before);
  let active=true;const onCommitted=vi.fn();
  const restore=installMobileLocalAttachmentFolderBridge(db,"u",{onCommitted,assertActive:()=>{if(!active) throw new Error("Session changed");}});
  try{
    await expect(api.attachmentFolders.create("Unbound")).rejects.toMatchObject({code:"MOBILE_SYNC_ATTACHMENT_FOLDER_UNSUPPORTED"});
    expect(fixture.raw.prepare("SELECT COUNT(*) AS count FROM mobile_local_attachment_folders").get()?.count).toBe(1);
    await db.run("INSERT INTO native_runtime_meta(key,value,updatedAt) VALUES (?,?,'now')",[nativeAssetBindingKey("p"),NATIVE_ASSET_ENTITY_SET]);
    const folder=await api.attachmentFolders.create("Synced child","preserved");
    const queued=await db.query<{payload:string}>("SELECT payload FROM sync_outbox WHERE entityType='attachment_organization'");
    expect(queued).toHaveLength(1);expect(JSON.parse(queued[0].payload)).toMatchObject({id:`folder:${folder.id}`,parentId:"preserved",userId:"u",name:"Synced child"});
    await db.run("CREATE TRIGGER asset_enqueue_failure BEFORE INSERT ON sync_outbox WHEN NEW.entityType='attachment_organization' BEGIN SELECT RAISE(ABORT,'asset enqueue failure'); END");
    await expect(api.attachmentFolders.rename(folder.id,"Must roll back")).rejects.toThrow("asset enqueue failure");
    expect(await db.query("SELECT name FROM mobile_local_attachment_folders WHERE id=?",[folder.id])).toEqual([{name:"Synced child"}]);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    active=false;await expect(api.attachmentFolders.remove(folder.id)).rejects.toThrow("Session changed");
    expect(await db.query("SELECT name FROM mobile_local_attachment_folders WHERE id='preserved'")).toEqual([{name:"Preserved folder"}]);
  }finally{restore();await db.close();}
});

it.each([false, true])("schema 11 signed-order migration preserves tree and queues, rollback=%s", async (rollback) => {
  fixture.raw.exec(`PRAGMA user_version=11;
    INSERT INTO native_knowledge_tree_nodes(scopeKey,id,userId,nodeType,resourceType,resourceId,sortOrder,isDeleted,createdAt,updatedAt)
      VALUES ('personal','note:n','u','note','note','n',7,0,'created','updated')`);
  const tree = fixture.raw.prepare("SELECT * FROM native_knowledge_tree_nodes").all();
  const queue = fixture.raw.prepare("SELECT * FROM sync_outbox").all();
  fixture.failTree = rollback;
  if (rollback) {
    await expect(openNativeDatabase("signed-order-migration")).rejects.toThrow("Tree migration interruption");
    expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({user_version:11});
    expect(fixture.raw.prepare("SELECT sql FROM sqlite_master WHERE name='native_knowledge_tree_nodes'").get()?.sql).toContain("CHECK (sortOrder >= 0)");
  } else {
    const db = await openNativeDatabase("signed-order-migration");
    expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({user_version:12});
    expect(fixture.raw.prepare("SELECT name FROM sqlite_master WHERE name='idx_native_tree_parent'").get()).toBeTruthy();
    await db.run("UPDATE native_knowledge_tree_nodes SET sortOrder=-2147483647 WHERE id='note:n'");
    expect(fixture.raw.prepare("SELECT sortOrder FROM native_knowledge_tree_nodes").get()).toEqual({sortOrder:-2147483647});
    await db.run("UPDATE native_knowledge_tree_nodes SET sortOrder=7 WHERE id='note:n'");
    await db.close();
  }
  expect(fixture.raw.prepare("SELECT * FROM native_knowledge_tree_nodes").all()).toEqual(tree);
  expect(fixture.raw.prepare("SELECT * FROM sync_outbox").all()).toEqual(queue);
});

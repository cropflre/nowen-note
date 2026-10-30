import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-repeat-delete-"));
process.env.DB_PATH = path.join(directory, "test.db");
let db: Database.Database;
let app: Hono;
let closeDb: () => void;
let applyMutation: typeof import("../src/sync/apply").applyMutation;
test.before(async () => {
  const schema = await import("../src/db/schema");
  db = schema.getDb(); closeDb = schema.closeDb;
  for (const id of ["owner", "other"]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'hash')").run(id,id);
  app = new Hono(); app.route("/tasks", (await import("../src/routes/tasks")).default);
  app.route("/sync", (await import("../src/routes/sync-v2")).default);
  applyMutation = (await import("../src/sync/apply")).applyMutation;
});
test.after(() => { closeDb?.(); fs.rmSync(directory, { recursive: true, force: true }); });
async function request(url: string, method = "GET", body?: unknown, user = "owner") {
  const response = await app.request(url, { method, headers: { "X-User-Id": user, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: response.headers.get("Content-Type")?.includes("json") ? JSON.parse(text) : text };
}
async function series() {
  const first = (await request("/tasks", "POST", { title: "Daily", dueDate: "2026-10-14", repeatRule: "daily" })).body;
  const next = (await request(`/tasks/${first.id}/toggle`, "PATCH")).body.generatedTask;
  return { first, next };
}
test("single deletion keeps the next occurrence and its recurrence", async () => {
  const { first, next } = await series();
  assert.equal((await request(`/tasks/${first.id}`, "DELETE")).status, 200);
  assert.equal((await request(`/tasks/${next.id}`, "GET")).status, 200);
  assert.ok((await request(`/tasks/${next.id}/toggle`, "PATCH")).body.generatedTask);
});
test("monthly completion accepts SQLite wall times without generating NaN dates",async()=>{
  const task=(await request("/tasks","POST",{title:"Monthly",dueDate:"2026-09-20",dueAt:"2026-09-20 16:30:00",repeatRule:"monthly"})).body;
  const response=await request(`/tasks/${task.id}/toggle`,"PATCH");
  assert.equal(response.body.generatedTask.dueDate,"2026-10-20");
  assert.equal(response.body.generatedTask.dueAt,"2026-10-20T16:30:00");
});
test("legacy corrupt dates can be completed, stopped or deleted without generating corrupt successors",async()=>{
  for(const action of ["toggle","single","stop","series"]){
    const task=(await request("/tasks","POST",{title:"Corrupt legacy",dueDate:"2026-09-20",repeatRule:"monthly"})).body;
    db.prepare("UPDATE tasks SET dueDate='NaN-NaN-NaN',dueAt='NaN-T00:00:00' WHERE id=?").run(task.id);
    const response=await request(action==="toggle"?`/tasks/${task.id}/toggle`:action==="stop"?`/tasks/${task.id}/recurrence/stop`:`/tasks/${task.id}?mode=${action}`,action==="toggle"||action==="stop"?"PATCH":"DELETE");
    assert.equal(response.status,200);
    assert.equal(db.prepare("SELECT 1 FROM tasks WHERE repeatGeneratedFromId=?").get(task.id),undefined);
  }
});
test("REST rejects invalid task dates and recurrence intervals before writing",async()=>{
  for(const patch of [{dueDate:"NaN-NaN-NaN"},{dueDate:"2026-02-30"},{dueAt:"2026-09-20T99:99"},{dueAt:"NaN-T00:00:00"},{startDate:"invalid"},{repeatEndDate:"invalid"},{repeatInterval:"invalid",repeatRule:"monthly",dueDate:"2026-09-20"}]){
    const response=await request("/tasks","POST",{title:"Invalid",...patch});assert.equal(response.status,400);
  }
});
test("invalid dates in REST updates and Sync V2 cannot corrupt a healthy task",async()=>{
  const {next}=await series();
  const bad={dueDate:"NaN-NaN-NaN",dueAt:"NaN-T00:00:00"};
  assert.equal((await request(`/tasks/${next.id}`,"PUT",bad)).status,400);
  assert.throws(()=>sync(next.id,{...next,...bad,baseUpdatedAt:next.updatedAt}),/Invalid dueDate/);
  assert.equal((await request(`/tasks/${next.id}`)).body.dueDate,next.dueDate);
});
test("deleting the active occurrence skips it and keeps the following occurrence", async () => {
  const { first, next } = await series();
  await request(`/tasks/${next.id}`, "DELETE");
  const remaining = db.prepare("SELECT * FROM tasks WHERE repeatGeneratedFromId=?").get(next.id) as any;
  assert.equal(remaining.dueDate, "2026-10-16");
  assert.equal(remaining.repeatGroupId, first.id);
  assert.equal(remaining.repeatRule, "daily");
});
test("stop preserves history and existing tasks, and blocks generation from any occurrence", async () => {
  const { first, next } = await series();
  const stopped = await request(`/tasks/${next.id}/recurrence/stop`, "PATCH");
  assert.equal(stopped.status, 200); assert.equal(stopped.body.affected, 2);
  assert.equal((await request(`/tasks/${first.id}`, "GET")).body.isCompleted, 1);
  assert.equal((await request(`/tasks/${next.id}/toggle`, "PATCH")).body.generatedTask, null);
  await request(`/tasks/${first.id}/toggle`, "PATCH");
  assert.equal((await request(`/tasks/${first.id}/toggle`, "PATCH")).body.generatedTask, null);
  assert.equal((await request(`/tasks/${first.id}`, "PUT", { repeatRule: "daily" })).status, 409);
});
test("series deletion includes archived occurrences, descendants and reminders even without the root", async () => {
  const { first, next } = await series();
  const child = (await request("/tasks", "POST", { title: "Child", parentId: next.id })).body;
  db.prepare("INSERT INTO task_reminders(id,taskId,userId,offsetMinutes,enabled) VALUES (?,?,'owner',30,1)").run(randomUUID(), child.id);
  db.prepare("UPDATE tasks SET archivedAt='archived' WHERE id=?").run(first.id);
  await request(`/tasks/${first.id}`, "DELETE");
  const result = await request(`/tasks/${next.id}?mode=series`, "DELETE");
  assert.equal(result.status, 200); assert.equal(result.body.affected, 2);
  for (const id of [next.id, child.id]) assert.equal((await request(`/tasks/${id}`)).status, 404);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM task_reminders WHERE taskId=?").get(child.id) as any).n, 0);
});
test("invalid modes and unauthorized actors leave the series untouched", async () => {
  const { first, next } = await series();
  assert.equal((await request(`/tasks/${first.id}?mode=unknown`, "DELETE")).status, 400);
  assert.equal((await request(`/tasks/${next.id}?mode=series`, "DELETE", undefined, "other")).status, 403);
  assert.equal((await request(`/tasks/${next.id}/recurrence/stop`, "PATCH", undefined, "other")).status, 403);
  assert.equal((await request(`/tasks/${first.id}`)).status, 200);
});
function sync(id: string, payload: Record<string, unknown>, operation: "upsert" | "delete" = "upsert") {
  return db.transaction(() => applyMutation(db, { userId: "owner", deviceId: "offline-device", mutationId: randomUUID(), entityType: "task", entityId: id, operation, payload }))();
}
test("a delayed offline update cannot resurrect a deleted occurrence", async () => {
  const { first } = await series();
  await request(`/tasks/${first.id}`, "DELETE");
  assert.throws(() => sync(first.id, { ...first, baseUpdatedAt: first.updatedAt }), /已删除/);
  assert.equal((await request(`/tasks/${first.id}`)).status, 404);
});
test("a delayed successor cannot recreate a deleted or stopped series", async () => {
  for (const action of ["stop", "series"]) {
    const { first, next } = await series();
    await request(action === "stop" ? `/tasks/${first.id}/recurrence/stop` : `/tasks/${first.id}?mode=series`, action === "stop" ? "PATCH" : "DELETE");
    assert.throws(() => sync(randomUUID(), { ...next, repeatGeneratedFromId: next.id }), /循环|已删除/);
  }
});
test("a stale stopped-series snapshot cannot downgrade a whole-series deletion",async()=>{
  const {first,next}=await series();await request(`/tasks/${first.id}?mode=series`,"DELETE");
  const {applyRemoteChanges}=await import("../src/sync/applyLocal");
  const late=randomUUID();
  applyRemoteChanges(db,[{entityType:"task",entityId:late,operation:"upsert",payload:{...next,recurrenceAction:"stop",repeatRule:"none"}}],{userId:"owner"});
  assert.equal(db.prepare("SELECT 1 FROM tasks WHERE id=?").get(late),undefined);
  assert.equal((db.prepare("SELECT action FROM task_recurrence_state WHERE groupId=?").get(first.id) as any).action,"series");
});
test("series sync intents are idempotent and include remotely generated occurrences", async () => {
  const { first, next } = await series();
  const third = (await request(`/tasks/${next.id}/toggle`, "PATCH")).body.generatedTask;
  sync(first.id, { recurrenceAction: "series", repeatGroupId: first.id }, "delete");
  assert.equal((await request(`/tasks/${third.id}`)).status, 404);
  sync(first.id, { recurrenceAction: "series", repeatGroupId: first.id }, "delete");
  assert.equal((await request(`/tasks/${next.id}`)).status, 404);
});
test("failed series deletion rolls back tasks, tombstones and lifecycle state", async () => {
  const { first, next } = await series();
  db.exec(`CREATE TRIGGER fail_repeat_delete BEFORE DELETE ON tasks WHEN OLD.id='${next.id}' BEGIN SELECT RAISE(ABORT,'Deletion interruption'); END`);
  try {
    assert.equal((await request(`/tasks/${first.id}?mode=series`, "DELETE")).status, 500);
    assert.equal((await request(`/tasks/${first.id}`)).status, 200);
    assert.equal(db.prepare("SELECT 1 FROM task_recurrence_state WHERE groupId=?").get(first.id), undefined);
    assert.equal(db.prepare("SELECT 1 FROM task_deletion_tombstones WHERE id=?").get(first.id), undefined);
  } finally { db.exec("DROP TRIGGER fail_repeat_delete"); }
});
test("desktop Outbox carries stop and whole-series intents to an independent SQLite peer", async () => {
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile");
  const { ensureDevice } = await import("../src/sync/device");
  const profile = createProfile(db,{name:"recurrence-peer",serverUrl:"http://peer.test"});
  switchActiveProfile(db,profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus='ready',bootstrapReadyAt=datetime('now') WHERE id=?").run(profile.id);
  ensureDevice(db,{profileId:profile.id,platform:"darwin"});
  const { first, next } = await series();
  const peerPath = path.join(directory,"peer.db"); await db.backup(peerPath);
  const Constructor = (await import("better-sqlite3")).default;
  const peer = new Constructor(peerPath);peer.pragma("foreign_keys=ON");
  try {
    await request(`/tasks/${next.id}/recurrence/stop`,"PATCH");
    const stop = db.prepare("SELECT payload FROM sync_outbox WHERE entityType='task' AND entityId=? ORDER BY rowid DESC LIMIT 1").get(next.id) as any;
    assert.equal(JSON.parse(stop.payload).recurrenceAction,"stop");
    peer.transaction(()=>applyMutation(peer,{userId:"owner",deviceId:"desktop",mutationId:randomUUID(),entityType:"task",entityId:next.id,operation:"upsert",payload:JSON.parse(stop.payload)}))();
    assert.equal((peer.prepare("SELECT repeatRule FROM tasks WHERE id=?").get(first.id) as any).repeatRule,"none");
    await request(`/tasks/${next.id}?mode=series`,"DELETE");
    const deletion = db.prepare("SELECT payload FROM sync_outbox WHERE entityType='task' AND entityId=? AND operation='delete' ORDER BY rowid DESC LIMIT 1").get(next.id) as any;
    assert.equal(JSON.parse(deletion.payload).recurrenceAction,"series");
    peer.transaction(()=>applyMutation(peer,{userId:"owner",deviceId:"desktop",mutationId:randomUUID(),entityType:"task",entityId:next.id,operation:"delete",payload:JSON.parse(deletion.payload)}))();
    assert.equal(peer.prepare("SELECT 1 FROM tasks WHERE id=?").get(first.id),undefined);
    assert.equal(peer.prepare("SELECT 1 FROM tasks WHERE id=?").get(next.id),undefined);
  } finally {peer.close();}
});
test("HTTP Sync V2 acknowledges series intent once and rejects deleted task resurrection",async()=>{
  const {first,next}=await series();
  const mutation={mutationId:randomUUID(),entityType:"task",entityId:next.id,operation:"delete",payload:{recurrenceAction:"series"}};
  const body={deviceId:"native",mutations:[mutation]};
  const applied=await request("/sync/push","POST",body);
  assert.equal(applied.status,200);assert.equal(applied.body.results[0].status,"applied");
  const duplicate=await request("/sync/push","POST",body);
  assert.equal(duplicate.body.results[0].status,"duplicate");
  const rejected=await request("/sync/push","POST",{deviceId:"old-device",mutations:[{...mutation,mutationId:randomUUID(),entityId:first.id,operation:"upsert",payload:first}]});
  assert.equal(rejected.body.results[0].code,"VERSION_CONFLICT");
  assert.equal((await request(`/tasks/${first.id}`)).status,404);
});
test("series actions reject unauthorized occurrences within a shared workspace atomically",async()=>{
  const ws=randomUUID(),first=randomUUID(),next=randomUUID();
  db.prepare("INSERT INTO workspaces(id,name,ownerId) VALUES(?,'Shared','other')").run(ws);
  db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES(?,'owner','editor'),(?,'other','owner')").run(ws,ws);
  db.prepare("INSERT INTO tasks(id,userId,workspaceId,title,repeatRule,repeatGroupId) VALUES(?,'owner',?,'Root','daily',NULL),(?,'other',?,'Next','daily',?)").run(first,ws,next,ws,first);
  assert.equal((await request(`/tasks/${first}?mode=series`,"DELETE")).status,403);
  assert.equal((await request(`/tasks/${first}/recurrence/stop`,"PATCH")).status,403);
  const response=await request(`/sync/push?scopeKey=workspace:${ws}`,"POST",{deviceId:"editor",scopeKey:`workspace:${ws}`,mutations:[{mutationId:randomUUID(),entityType:"task",entityId:first,operation:"delete",payload:{recurrenceAction:"series"}}]});
  assert.equal(response.body.results[0].code,"SCOPE_FORBIDDEN");
  assert.equal(db.prepare("SELECT 1 FROM task_recurrence_state WHERE groupId=?").get(first),undefined);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE workspaceId=?").get(ws) as any).n,2);
  // Outbox coalescing can combine a stop command with deletion of its occurrence.
  db.prepare("UPDATE tasks SET repeatGroupId=NULL,parentId=? WHERE id=?").run(first,next);
  const coalesced=await request(`/sync/push?scopeKey=workspace:${ws}`,"POST",{deviceId:"editor",scopeKey:`workspace:${ws}`,mutations:[{mutationId:randomUUID(),entityType:"task",entityId:first,operation:"delete",payload:{recurrenceAction:"stop"}}]});
  assert.equal(coalesced.body.results[0].code,"SCOPE_FORBIDDEN");
  assert.equal(db.prepare("SELECT 1 FROM task_recurrence_state WHERE groupId=?").get(first),undefined);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE workspaceId=?").get(ws) as any).n,2);
});

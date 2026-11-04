import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { MobileSyncEngine } from "../mobileSyncEngine";
import type { NativeDatabase } from "../nativeDatabase";
import { NATIVE_TREE_ENTITY_SET } from "../nativeKnowledgeTreeSync";
import { readNativeTreeRepairBackup } from "../nativeTreeConflictRepair";

const { DatabaseSync: SQLiteDatabase } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const context = { profileId: "p", deviceId: "d", userId: "u" };
const entity = (id: string, parentId: string | null, sortOrder: number) => ({
  id: `notebook:${id}`, userId: context.userId, workspaceId: null, parentId, nodeType: "folder",
  resourceType: "notebook", resourceId: id, sortOrder, isDeleted: 0, deletedAt: null,
  createdAt: "2026-11-02", updatedAt: "2026-11-02",
});
const open = new Set<DatabaseSync>();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const db of open) db.close();
  open.clear();
});

function fixture(count = 1) {
  vi.useFakeTimers();
  const raw = new SQLiteDatabase(":memory:");
  open.add(raw);
  const source = readFileSync(new NodeURL("../nativeDatabase.ts", import.meta.url), "utf8");
  const scope = source.match(/const SCOPE_CHECK = `([\s\S]*?)`;/)![1];
  const types = source.match(/const ENTITY_TYPE_CHECK = `([\s\S]*?)`;/)![1];
  for (const [, sql] of source.matchAll(/`(CREATE TABLE IF NOT EXISTS [\s\S]*?)`/g)) {
    raw.exec(sql.replaceAll("${SCOPE_CHECK}", scope).replaceAll("${ENTITY_TYPE_CHECK}", types));
  }
  raw.exec(`
    INSERT INTO sync_profiles(id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt)
      VALUES ('p','Test','http://localhost:3001','u',1,'created','created');
    INSERT INTO sync_devices(profileId,deviceId,platform,createdAt) VALUES ('p','d','android','created');
    INSERT INTO sync_state(profileId,scopeKey,lastSequence,accessFingerprint) VALUES ('p','personal',100,'owner');
    INSERT INTO notebooks(id,userId,name,createdAt,updatedAt) VALUES ('old','u','Local folder','created','created'),
      ('new','u','Cloud folder','created','created');
    INSERT INTO notes(id,userId,notebookId,content,createdAt,updatedAt) VALUES ('n','u','old','keep me','created','created');
  `);
  raw.prepare("INSERT INTO native_runtime_meta(key,value,updatedAt) VALUES ('nativeTreeSubscription:p:personal',?,'created')").run(NATIVE_TREE_ENTITY_SET);
  const remote = [entity("old", null, 0), entity("new", null, 1)];
  function putLocal(node: ReturnType<typeof entity>) {
    raw.prepare(`INSERT INTO native_knowledge_tree_nodes
      (scopeKey,id,userId,workspaceId,parentId,nodeType,resourceType,resourceId,sortOrder,isDeleted,deletedAt,createdAt,updatedAt)
      VALUES ('personal',?,?,?,?,?,?,?,?,?,?,?,?)`).run(...Object.values(node));
  }
  remote.forEach(putLocal);
  for (let index = 0; index < count; index++) {
    const id = `folder-${index}`;
    const local = entity(id, "notebook:old", index);
    const cloud = entity(id, "notebook:new", index + 10);
    putLocal(local);
    remote.push(cloud);
    raw.prepare("INSERT INTO notebooks(id,userId,parentId,name,createdAt,updatedAt) VALUES (?,'u','old',?,'created','created')")
      .run(id, `Folder ${index + 1}`);
    raw.prepare(`INSERT INTO sync_conflicts(id,profileId,scopeKey,entityType,entityId,localPayload,remotePayload,createdAt)
      VALUES (?,'p','personal','knowledge_tree_node',?,?,?,'created')`)
      .run(`c-${index}`, local.id, JSON.stringify(local), JSON.stringify(cloud));
    raw.prepare(`INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,payload,createdAt)
      VALUES (?,?,'p','d','personal','knowledge_tree_node',?,'upsert',?,'created')`)
      .run(`o-${index}`, `m-${index}`, local.id, JSON.stringify({ ...local, baseParentId: null, baseSortOrder: 0, baseIsDeleted: 0 }));
  }
  const db: NativeDatabase = {
    async run(sql, values = []) { return { changes: Number(raw.prepare(sql).run(...values as SQLInputValue[]).changes) }; },
    async query(sql, values = []) { return raw.prepare(sql).all(...values as SQLInputValue[]) as never; },
    async transaction(work) {
      raw.exec("BEGIN");
      try { const result = await work(db); raw.exec("COMMIT"); return result; }
      catch (error) { raw.exec("ROLLBACK"); throw error; }
    },
    async close() {},
  };
  const server = { sequence: 100, changedEntityId: "" };
  const request = vi.fn(async (input: string) => {
    const url = new NodeURL(input);
    let payload: unknown;
    if (url.pathname.endsWith("/scopes")) payload = { items: [{ scopeKey: "personal", workspaceId: null, canWrite: true, accessFingerprint: "owner" }] };
    else if (url.pathname.endsWith("/plan")) payload = {
      serverSequence: server.sequence, resetRequired: false, accessFingerprint: "owner", entityTypes: NATIVE_TREE_ENTITY_SET.split(","),
    };
    else if (url.pathname.endsWith("/snapshot")) {
      if (url.searchParams.has("cursor")) {
        expect(url.searchParams.has("deviceId")).toBe(false);
        expect(url.searchParams.get("cursor")).toBe("knowledge_tree_node:");
      }
      payload = { accessFingerprint: "owner", snapshotSequence: server.sequence, nextCursor: null,
        items: remote.map((node) => ({ entityType: "knowledge_tree_node", entityId: node.id, payload: node })) };
    } else if (url.pathname.endsWith("/changes")) payload = {
      resetRequired: false, nextSequence: server.sequence,
      items: server.changedEntityId && Number(url.searchParams.get("after")) < server.sequence
        ? [{ entityType: "knowledge_tree_node", entityId: server.changedEntityId, operation: "upsert" }] : [],
    };
    else if (url.pathname.endsWith("/ack")) payload = {};
    else throw new Error(`Unexpected request ${url.pathname}`);
    return { ok: true, status: 200, json: async () => payload };
  });
  vi.stubGlobal("fetch", request);
  const engine = new MobileSyncEngine({ db, attachments: {} as never, serverUrl: "http://localhost:3001", token: "test", ...context });
  engine.start();
  return { engine, db, raw, remote, server, request, ids: Array.from({ length: count }, (_, index) => `c-${index}`) };
}

it("repairs 18 Android directory conflicts atomically, retaining business data, cursor and conflict history", async () => {
  const { engine, raw, ids, request, remote, server } = fixture(18);
  const preview = await engine.repairPersonalTree("keep-remote", ids);
  if (!("token" in preview)) throw new Error("Expected a repair preview");
  expect(preview.changes.find((change) => change.id === "c-0")).toMatchObject({
    title: "Folder 1", local: { parentId: "notebook:old" }, remote: { parentId: "notebook:new" },
  });
  expect(raw.prepare("SELECT id FROM sync_outbox").all()).toHaveLength(18);
  const result = await engine.repairPersonalTree("keep-remote", ids, preview.token);
  expect(result).toMatchObject({ resolved: 18, backupId: expect.any(String) });
  expect(raw.prepare("SELECT id FROM sync_outbox").all()).toHaveLength(0);
  expect(raw.prepare("SELECT id FROM sync_conflicts WHERE status='resolved'").all()).toHaveLength(18);
  expect(raw.prepare("SELECT id FROM notebooks WHERE parentId='new'").all()).toHaveLength(18);
  expect(raw.prepare("SELECT id FROM native_knowledge_tree_nodes WHERE parentId='notebook:new'").all()).toHaveLength(18);
  expect(raw.prepare("SELECT content FROM notes WHERE id='n'").get()).toEqual({ content: "keep me" });
  expect(raw.prepare("SELECT lastSequence FROM sync_state").get()).toEqual({ lastSequence: 100 });
  expect(raw.prepare("SELECT key FROM native_runtime_meta WHERE key LIKE 'knowledgeTreeRepairBackup:%'").all()).toHaveLength(1);
  expect(request.mock.calls.every(([url]) => !/\/(ack|push)$/.test(url))).toBe(true);

  raw.exec("INSERT INTO native_runtime_meta(key,value,updatedAt) VALUES ('offlineBaseline:p:personal','100','created')");
  // Replay a later accepted move from a device that has just returned online.
  server.sequence++;
  server.changedEntityId = remote[2].id;
  remote[2].sortOrder = 29;
  await engine.syncOnce();
  await engine.syncOnce();
  expect(raw.prepare("SELECT id FROM sync_conflicts WHERE status='unresolved'").all()).toHaveLength(0);
  expect(raw.prepare("SELECT sortOrder FROM native_knowledge_tree_nodes WHERE id='notebook:folder-0'").get()).toEqual({ sortOrder: 29 });
  expect(raw.prepare("SELECT lastSequence FROM sync_state").get()).toEqual({ lastSequence: 101 });
});

it("blocks a stale confirmation and preserves every queued mutation", async () => {
  const { engine, raw, ids, remote } = fixture();
  const preview = await engine.repairPersonalTree("keep-remote", ids);
  if (!("token" in preview)) throw new Error("Expected a repair preview");
  remote[2].sortOrder++;
  await expect(engine.repairPersonalTree("keep-remote", ids, preview.token)).rejects.toThrow("重新预览");
  expect(raw.prepare("SELECT mutationId FROM sync_outbox").get()).toEqual({ mutationId: "m-0" });
  expect(raw.prepare("SELECT parentId FROM notebooks WHERE id='folder-0'").get()).toEqual({ parentId: "old" });
});

it.each(["body", "attachment", "failed-upload", "delete", "cursor", "cycle", "missing-cloud", "missing-local-resource"] as const)(
  "blocks %s before replacing directories",
  async (condition) => {
    const { engine, raw, ids, remote, server } = fixture();
    if (condition === "body") raw.exec(`INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,createdAt)
      VALUES ('body','m-body','p','d','personal','note','n','upsert','created')`);
    if (condition === "attachment") raw.exec(`INSERT INTO attachments(id,noteId,userId,filename,mimeType,size,transferStatus,createdAt,updatedAt)
      VALUES ('a','n','u','x','text/plain',1,'pending_upload','created','created')`);
    if (condition === "failed-upload") raw.exec(`INSERT INTO attachments(id,noteId,userId,filename,mimeType,size,available,localPath,transferStatus,createdAt,updatedAt)
      VALUES ('a','n','u','x','text/plain',1,1,'local-path','failed','created','created')`);
    if (condition === "delete") raw.exec("UPDATE sync_outbox SET operation='delete'");
    if (condition === "cursor") server.sequence++;
    if (condition === "cycle") remote[1].parentId = "notebook:folder-0";
    if (condition === "missing-cloud") remote.pop();
    if (condition === "missing-local-resource") raw.exec("DELETE FROM notebooks WHERE id='folder-0'");
    await expect(engine.repairPersonalTree("keep-remote", ids)).rejects.toThrow();
    expect(raw.prepare("SELECT id FROM sync_conflicts WHERE status='unresolved'").all()).toHaveLength(1);
    expect(raw.prepare("SELECT mutationId FROM sync_outbox WHERE id='o-0'").get()).toEqual({ mutationId: "m-0" });
    expect(raw.prepare("SELECT key FROM native_runtime_meta WHERE key LIKE 'knowledgeTreeRepairBackup:%'").all()).toHaveLength(0);
  },
);

it("repairs directory positions while retaining a failed cloud attachment download", async () => {
  const { engine, raw, ids } = fixture();
  raw.exec(`INSERT INTO attachments(id,noteId,userId,filename,mimeType,size,available,transferStatus,transferError,createdAt,updatedAt)
    VALUES ('download','n','u','cloud.txt','text/plain',1,0,'failed','HTTP 404','created','created')`);
  const preview = await engine.repairPersonalTree("keep-remote", ids);
  if (!("token" in preview)) throw new Error("Expected a repair preview");
  await expect(engine.repairPersonalTree("keep-remote", ids, preview.token)).resolves.toMatchObject({ resolved: 1 });
  expect(raw.prepare("SELECT available,transferStatus,transferError FROM attachments WHERE id='download'").get())
    .toEqual({ available: 0, transferStatus: "failed", transferError: "HTTP 404" });
});

it("refreshes historical version-only tree conflict payloads from the current cloud snapshot", async () => {
  const { engine, raw, ids } = fixture();
  raw.exec("UPDATE sync_conflicts SET remotePayload='{\"version\":17}'");
  const preview = await engine.repairPersonalTree("keep-remote", ids);
  if (!("token" in preview)) throw new Error("Expected a repair preview");
  expect(preview.changes[0].remote.parentId).toBe("notebook:new");
  await expect(engine.repairPersonalTree("keep-remote", ids, preview.token)).resolves.toMatchObject({ resolved: 1 });
});

it("rolls back structure, history and the backup if apply cannot finish", async () => {
  const { engine, raw, ids } = fixture();
  const preview = await engine.repairPersonalTree("keep-remote", ids);
  if (!("token" in preview)) throw new Error("Expected a repair preview");
  raw.exec(`CREATE TRIGGER interrupted_repair BEFORE UPDATE ON sync_conflicts
    BEGIN SELECT RAISE(ABORT,'interrupted'); END;`);
  await expect(engine.repairPersonalTree("keep-remote", ids, preview.token)).rejects.toThrow("interrupted");
  expect(raw.prepare("SELECT parentId FROM notebooks WHERE id='folder-0'").get()).toEqual({ parentId: "old" });
  expect(raw.prepare("SELECT mutationId FROM sync_outbox").get()).toEqual({ mutationId: "m-0" });
  expect(raw.prepare("SELECT key FROM native_runtime_meta WHERE key LIKE 'knowledgeTreeRepairBackup:%'").all()).toHaveLength(0);
});

it("adopts the cloud tree node when its local business resource is already present", async () => {
  const { engine, raw, ids } = fixture();
  raw.exec("DELETE FROM native_knowledge_tree_nodes WHERE id='notebook:folder-0'; DELETE FROM sync_outbox; UPDATE sync_conflicts SET localPayload=NULL");
  const preview = await engine.repairPersonalTree("keep-remote", ids);
  if (!("token" in preview)) throw new Error("Expected a repair preview");
  expect(preview.changes[0].local).toBeNull();
  await expect(engine.repairPersonalTree("keep-remote", ids, preview.token)).resolves.toMatchObject({ resolved: 1 });
  expect(raw.prepare("SELECT parentId FROM native_knowledge_tree_nodes WHERE id='notebook:folder-0'").get()).toEqual({ parentId: "notebook:new" });
});

it("keeps validated local positions by replacing old queue entries with CAS against the current cloud baseline", async () => {
  const { engine, raw, ids, remote } = fixture();
  raw.prepare("INSERT INTO native_runtime_meta(key,value,updatedAt) VALUES ('knowledgeTreeSnapshot:v1:personal:0',?,'created')")
    .run(JSON.stringify(remote.map((node) => ({
      ...node, isPasswordProtected: 0, access: { source: "owner", capabilities: { canView: true, canMove: true, canCreate: true } },
    }))));
  const preview = await engine.repairPersonalTree("keep-local", ids);
  if (!("token" in preview)) throw new Error("Expected a repair preview");
  await expect(engine.repairPersonalTree("keep-local", ids, preview.token)).resolves.toMatchObject({ resolved: 1 });
  expect(raw.prepare("SELECT parentId FROM native_knowledge_tree_nodes WHERE id='notebook:folder-0'").get()).toEqual({ parentId: "notebook:old" });
  const queued = raw.prepare("SELECT mutationId,payload FROM sync_outbox").all();
  expect(queued).toHaveLength(1);
  expect(queued[0].mutationId).not.toBe("m-0");
  expect(JSON.parse(String(queued[0].payload))).toMatchObject({
    parentId: "notebook:old", baseParentId: "notebook:new", baseSortOrder: 10, baseIsDeleted: 0,
  });
});

it("retrieves only saved structural fields and rejects another account or profile", async () => {
  const { engine, db, raw, ids } = fixture();
  const preview = await engine.repairPersonalTree("keep-remote", ids);
  if (!("token" in preview)) throw new Error("Expected a repair preview");
  const result = await engine.repairPersonalTree("keep-remote", ids, preview.token);
  if (!("backupId" in result)) throw new Error("Expected a saved backup");
  const backup = await readNativeTreeRepairBackup(db, context, result.backupId);
  expect(backup).toMatchObject({ id: result.backupId, strategy: "keep-remote", changes: [{
    id: "c-0", local: { parentId: "notebook:old" }, remote: { parentId: "notebook:new" },
  }] });
  expect(Object.keys(backup.changes[0].local!).sort()).toEqual([
    "deletedAt", "id", "isDeleted", "nodeType", "parentId", "resourceId", "resourceType", "sortOrder",
  ]);
  expect(backup).not.toHaveProperty("outbox");
  expect(backup).not.toHaveProperty("token");
  await expect(readNativeTreeRepairBackup(db, {...context, userId: "other"}, result.backupId)).rejects.toThrow("账号已变化");
  raw.exec(`INSERT INTO sync_profiles(id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt)
    VALUES ('p2','Other','http://localhost:3001','u2',1,'created','created')`);
  await expect(readNativeTreeRepairBackup(db, {...context, profileId: "p2", userId: "u2"}, result.backupId)).rejects.toThrow("没有这份");
});

it("exports a missing local tree node as a null saved before snapshot", async () => {
  const { engine, db, raw, ids } = fixture();
  raw.exec("DELETE FROM native_knowledge_tree_nodes WHERE id='notebook:folder-0'; DELETE FROM sync_outbox; UPDATE sync_conflicts SET localPayload=NULL");
  const preview = await engine.repairPersonalTree("keep-remote", ids);
  if (!("token" in preview)) throw new Error("Expected a repair preview");
  const result = await engine.repairPersonalTree("keep-remote", ids, preview.token);
  if (!("backupId" in result)) throw new Error("Expected a saved backup");
  expect((await readNativeTreeRepairBackup(db, context, result.backupId)).changes[0].local).toBeNull();
});

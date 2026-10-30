// Test-only entry. Included only by vite.android-sync.config.ts, never normal builds.
import { openNativeDatabase } from "../../src/lib/nativeDatabase";
import { createNativeAttachmentStore } from "../../src/lib/nativeAttachmentStore";
import { NativeLocalRepository } from "../../src/lib/nativeLocalRepository";
import { MobileSyncEngine } from "../../src/lib/mobileSyncEngine";
import { installMobileSyncRealtime } from "../../src/lib/mobileSyncRealtime";
import { setMobileSyncEnabled } from "../../src/lib/mobileSyncStatus";
import { readNativeNoteSyncReceipt } from "../../src/lib/mobileNoteSyncReceipt";
import { realtime } from "../../src/lib/realtime";
import { api, setCurrentWorkspace } from "../../src/lib/api";
import { knowledgeTreeApi } from "../../src/lib/knowledgeTreeApi";
import { installMobileLocalFirstBridge } from "../../src/lib/mobileLocalFirstBridge";

type Config = { serverUrl: string; token: string; userId: string };
let initialized: Promise<void> | undefined;
async function initialize(config: Config) {
  localStorage.setItem("sync-acceptance-config", JSON.stringify(config));
  localStorage.setItem("nowen-token", config.token);
  localStorage.setItem("nowen-server-url", config.serverUrl);
  initialized ||= initializeOnce(config);
  return initialized;
}
async function initializeOnce(config: Config) {
  setCurrentWorkspace("personal");
  const profileId = "isolated-acceptance", deviceId = "android-acceptance";
  const accountId = `sync-acceptance:${config.userId}`;
  const db = await openNativeDatabase(accountId);
  const attachments = await createNativeAttachmentStore(accountId);
  await db.run(`INSERT OR IGNORE INTO sync_profiles (id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt)
    VALUES (?,'Acceptance',?,?,1,'now','now')`, [profileId, config.serverUrl, config.userId]);
  await db.run("INSERT OR IGNORE INTO sync_devices (profileId,deviceId,platform,createdAt) VALUES (?,?,'android','now')", [profileId, deviceId]);
  const engine = new MobileSyncEngine({ db, attachments, profileId, deviceId, ...config });
  const repository = new NativeLocalRepository({ db, attachments, accountId, userId: config.userId,
    getScopeKey: () => "personal", requestSync: () => engine.requestSync(150) });
  installMobileLocalFirstBridge(repository, db, config.userId);
  let dispose: (() => void) | undefined;
  const ids = async () => {
    const row = (await db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key='acceptance-note-ids'"))[0];
    return JSON.parse(row?.value || "[]") as string[];
  };
  const acceptance = {
    async createOffline() {
      const notes: string[] = [];
      for (const [index, nodeType] of (["markdown", "note"] as const).entries()) {
        const node = await knowledgeTreeApi.create({ parentId: null, nodeType, title: "Acceptance" });
        notes.push(node.resourceId);
        await api.updateNote(node.resourceId, { contentText: index ? "offline-rich" : "offline-markdown",
          content: index ? JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "offline-rich" }] }] }) : "offline-markdown" });
        await api.getNote(node.resourceId);
      }
      await db.run("INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES ('acceptance-note-ids',?,'now') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(notes)]);
      return notes;
    },
    async status() {
      return Promise.all((await ids()).map(async (id) => ({ id, note: await api.getNote(id), receipt: await readNativeNoteSyncReceipt(db, profileId, id) })));
    },
    async edit(id: string, text: string) {
      const note = await api.getNote(id);
      await api.updateNote(id, { contentText: text, content: note?.contentFormat === "markdown" ? text : JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }) });
    },
    async tryPermanentDelete(id: string) {
      try { await api.deleteNote(id); return { success: true }; }
      catch (error) { return { code: (error as { code?: string }).code }; }
    },
    start() { setMobileSyncEnabled(true); dispose = installMobileSyncRealtime(engine); engine.start(); },
    stop() { dispose?.(); dispose = undefined; engine.stop(); setMobileSyncEnabled(false); realtime.disconnect(); },
    async sync() { await engine.syncOnce(); },
    async errors() { return db.query("SELECT lastError FROM sync_state WHERE profileId=?", [profileId]); },
    async structure(id: string) {
      return (await db.query("SELECT id,parentId,sortOrder,isDeleted FROM native_knowledge_tree_nodes WHERE scopeKey='personal' AND id=?", [id]))[0] || null;
    },
    async schema() { return db.query("PRAGMA user_version"); },
    async treeList(includeDeleted=false) { return knowledgeTreeApi.listForWorkspace("personal",includeDeleted); },
    async trashList() {return api.trash.list("personal");},
    async treeTrash(id:string) {return knowledgeTreeApi.remove(id,"subtree");},
    async treeRestore(id:string) {return api.trash.mutate("personal","restore",[id]);},
    async createOfflineFolders() {
      const root=await knowledgeTreeApi.create({parentId:null,nodeType:"folder",title:"Offline folder"});
      const child=await knowledgeTreeApi.create({parentId:root.id,nodeType:"folder",title:"Offline child"});
      const document=await knowledgeTreeApi.create({parentId:`note:${(await ids())[0]}`,nodeType:"folder",title:"Offline document child"});
      const note=await knowledgeTreeApi.create({parentId:child.id,nodeType:"markdown",title:"Offline nested note"});
      await api.updateNote(note.resourceId,{content:"folder-offline-body",contentText:"folder-offline-body"});
      return {folders:[root,child,document].map(({id,parentId})=>({id,parentId})),noteId:note.resourceId};
    },
    async noteStatus(id:string) {return {note:await api.getNote(id),receipt:await readNativeNoteSyncReceipt(db,profileId,id)};},
    // Trash hides nodes from the editor authorization tree; inspect retention only in this test entry.
    async retainedNoteStatus(id:string) {return {note:await repository.notes.get(id),receipt:await readNativeNoteSyncReceipt(db,profileId,id)};},
    async pendingMutations() {return db.query("SELECT mutationId,entityType,entityId FROM sync_outbox WHERE profileId=? ORDER BY createdAt,rowid",[profileId]);},
    async treeMove(id: string, parentId: string | null, sortOrder: number) { return knowledgeTreeApi.move(id,{parentId,sortOrder}); },
    async pendingTree() { return db.query("SELECT mutationId,status FROM sync_outbox WHERE profileId=? AND entityType='knowledge_tree_node'",[profileId]); },
    async treeConflicts() {
      const rows = await db.query<{id:string;localPayload:string;remotePayload:string}>("SELECT id,localPayload,remotePayload FROM sync_conflicts WHERE profileId=? AND entityType='knowledge_tree_node' AND status='unresolved'",[profileId]);
      return rows.map((row) => ({id:row.id,local:JSON.parse(row.localPayload),remote:JSON.parse(row.remotePayload)}));
    },
    async resolveTreeConflict(id: string) { await engine.resolveLocalConflict(id,"keep-local"); },
  };
  Object.assign(window, { acceptance, acceptanceRealtime: realtime });
  document.getElementById("status")!.textContent = "Native SQLite ready. Test account only.";
}
Object.assign(window, { initializeAcceptance: initialize });
// The driver explicitly supplies one current fixture session after each reload.
// Auto-restoring an old token before that call would bind the engine to it.

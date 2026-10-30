import { afterEach, expect, it, vi } from "vitest";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "../knowledgeTreeApi";
import { installMobileLocalKnowledgeTreeBridge } from "../mobileLocalKnowledgeTreeBridge";
import type { NativeLocalRepository } from "../nativeLocalRepository";
import type { NativeDatabase } from "../nativeDatabase";
import {api} from "../api";

let restore: (() => void) | undefined;
it("personal Native tree creation carries an explicit TXT format and empty body", async () => {
  localStorage.setItem("nowen-current-workspace", "personal");
  let saved: Record<string, unknown>;
  const create = vi.fn(async (input: Record<string, unknown>) => { saved = { ...input, userId: "u", workspaceId: null }; });
  const repository = { createPersonalTreeNote: create, notes: { get: async () => saved } } as unknown as NativeLocalRepository;
  const remote = vi.spyOn(knowledgeTreeApi, "createForWorkspace");
  restore = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: false }, {} as NativeDatabase);
  const result = await knowledgeTreeApi.create({ parentId: null, nodeType: "note", title: "TXT", contentFormat: "plaintext" });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: "TXT", contentFormat: "plaintext", content: "" }), null);
  expect(result.contentFormat).toBe("plaintext"); expect(result.nodeType).toBe("note");
  expect(remote).not.toHaveBeenCalled();
});
afterEach(() => { restore?.(); vi.restoreAllMocks(); localStorage.removeItem("nowen-current-workspace"); });
function node(id: string, parentId: string | null = null): KnowledgeTreeNode {
  return { id,resourceId:id.slice(9),resourceType:"notebook",nodeType:"folder",parentId,userId:"u",workspaceId:null,
    scopeKey:"personal:u",isDeleted:0,isPasswordProtected:0,sortOrder:0,childCount:0,isExpanded:1,createdAt:"now",updatedAt:"now",title:id,
    access:{nodeId:id,source:"owner",rolePreset:"admin",sourceNodeId:null,capabilities:{canView:true,canMove:true,canCreate:true,canDelete:true} as never} };
}
function setup() {
  localStorage.setItem("nowen-current-workspace","personal");
  const a = node("notebook:a"), b = node("notebook:b");
  const remoteMove = vi.spyOn(knowledgeTreeApi,"move").mockResolvedValue(a);
  const remoteReorder = vi.spyOn(knowledgeTreeApi,"reorder").mockResolvedValue({success:true,updated:1});
  const remoteList = vi.spyOn(knowledgeTreeApi,"listForWorkspace").mockResolvedValue({nodes:[a,b]});
  const moves = vi.fn(async () => [{...a,parentId:b.id,sortOrder:7}]);
  const overrides = vi.fn(async () => [] as Array<Record<string,unknown>>);
  const folderDrafts=vi.fn(async()=>[] as KnowledgeTreeNode[]), createFolder=vi.fn(async()=>a);
  const remoteCreate=vi.spyOn(knowledgeTreeApi,"createForWorkspace").mockResolvedValue(a);
  const remoteRemove=vi.spyOn(knowledgeTreeApi,"remove").mockResolvedValue({success:true,affectedNodeIds:[a.id],promotedNodeIds:[]});
  const remoteRestore=vi.spyOn(knowledgeTreeApi,"restore").mockResolvedValue({success:true,restoredNodeIds:[a.id]});
  const remoteTrash=vi.spyOn(api.trash,"list").mockResolvedValue({items:[]});
  const trashFolders=vi.fn(async()=>({success:true,mode:"subtree",affectedNodeIds:[a.id],promotedNodeIds:[]}));
  const restoreFolder=vi.fn(async()=>({success:true,restoredNodeIds:[a.id]}));
  const repository = {movePersonalTreeNodes:moves,listPersonalTreeOverrides:overrides,listPersonalTreeFolderDrafts:folderDrafts,createPersonalTreeFolder:createFolder,
    trashPersonalTreeFolders:trashFolders,restorePersonalTreeFolder:restoreFolder,listLocalTreeDrafts:async()=>[]} as unknown as NativeLocalRepository;
  const metadata = new Map<string,string>();
  let pending=true;
  const db = {run:async(sql:string,values:unknown[])=>{if(sql.startsWith("DELETE"))metadata.delete(String(values[0]));else metadata.set(String(values[0]),String(values[1]));return {changes:1};},
    query:async(sql:string,values:unknown[])=>sql.includes("sync_outbox")?(pending?[{id:"queued"}]:[]):metadata.has(String(values[0]))?[{value:metadata.get(String(values[0]))}]:[]} as unknown as NativeDatabase;
  restore = installMobileLocalKnowledgeTreeBridge(repository,{deviceOnly:false},db);
  return {a,b,moves,overrides,remoteMove,remoteReorder,remoteList,folderDrafts,createFolder,remoteCreate,metadata,trashFolders,restoreFolder,remoteRemove,remoteRestore,remoteTrash,ack:()=>{pending=false;}};
}
it("persists folder trash and restores it through the unified trash facade without a second online write",async()=>{
  const f=setup();
  await knowledgeTreeApi.remove(f.a.id,"subtree");expect(f.trashFolders).toHaveBeenCalledWith([f.a.id]);expect(f.remoteRemove).not.toHaveBeenCalled();
  await api.trash.mutate("personal","restore",[f.a.id]);expect(f.restoreFolder).toHaveBeenCalledWith(f.a.id);expect(f.remoteRestore).not.toHaveBeenCalled();
  f.trashFolders.mockRejectedValueOnce(new Error("Outbox failed"));
  await expect(knowledgeTreeApi.remove(f.a.id,"subtree")).rejects.toThrow("Outbox failed");expect(f.remoteRemove).not.toHaveBeenCalled();
  f.trashFolders.mockRejectedValueOnce(Object.assign(new Error("Unavailable"),{code:"NATIVE_TREE_WRITE_UNAVAILABLE"}));
  await knowledgeTreeApi.remove(f.a.id,"subtree");expect(f.remoteRemove).toHaveBeenCalledOnce();
  await knowledgeTreeApi.remove(f.a.id,"promote");expect(f.trashFolders).toHaveBeenCalledTimes(3);expect(f.remoteRemove).toHaveBeenCalledTimes(2);
});
it("projects durable pending trash into the offline bin and hides it from the active tree",async()=>{
  const f=setup();await knowledgeTreeApi.listForWorkspace("personal",true);
  f.overrides.mockResolvedValue([{...f.a,isDeleted:1,deletedAt:"now"}]);
  const active=await knowledgeTreeApi.listForWorkspace("personal");expect(active.nodes.some((node)=>node.id===f.a.id)).toBe(false);
  f.remoteTrash.mockRejectedValueOnce(new TypeError("Failed to fetch"));f.remoteList.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const bin=await api.trash.list("personal");expect(bin.items.find((item)=>item.id===f.a.id)).toMatchObject({canRestore:true,canDeletePermanently:false});
  f.overrides.mockResolvedValue([{...f.a,isDeleted:0,deletedAt:null}]);
  const restored=await knowledgeTreeApi.listForWorkspace("personal");expect(restored.nodes.some((node)=>node.id===f.a.id)).toBe(true);
  expect((await api.trash.list("personal")).items).toEqual([]);
});
it("does not treat a trash authorization rejection as an offline read",async()=>{
  const f=setup();f.remoteTrash.mockRejectedValueOnce(Object.assign(new Error("Forbidden"),{status:403}));
  await expect(api.trash.list("personal")).rejects.toThrow("Forbidden");expect(f.remoteList).not.toHaveBeenCalled();
});
it("creates personal folders through the transaction and preserves online fallback for unavailable proofs only",async()=>{
  const f=setup();
  await knowledgeTreeApi.createForWorkspace("personal",{parentId:f.b.id,nodeType:"folder",title:" Offline "});
  expect(f.createFolder).toHaveBeenCalledWith(expect.any(String),"Offline",f.b.id); expect(f.remoteCreate).not.toHaveBeenCalled();
  f.createFolder.mockRejectedValueOnce(Object.assign(new Error("Unbound"),{code:"NATIVE_TREE_WRITE_UNAVAILABLE"}));
  await knowledgeTreeApi.createForWorkspace("personal",{parentId:null,nodeType:"folder",title:"Online"});
  expect(f.remoteCreate).toHaveBeenCalledOnce();
  f.createFolder.mockRejectedValueOnce(new Error("Outbox failed"));
  await expect(knowledgeTreeApi.createForWorkspace("personal",{parentId:null,nodeType:"folder",title:"Failure"})).rejects.toThrow("Outbox failed");
  expect(f.remoteCreate).toHaveBeenCalledOnce();
  await knowledgeTreeApi.createForWorkspace("workspace-a",{parentId:null,nodeType:"folder",title:"Workspace"});
  expect(f.createFolder).toHaveBeenCalledTimes(3); expect(f.remoteCreate).toHaveBeenCalledTimes(2);
});
it("restores reverse-ordered provisional nested folders over an offline cached tree and respects new password flags",async()=>{
  const f=setup(); await knowledgeTreeApi.listForWorkspace("personal");
  f.folderDrafts.mockResolvedValue([node("notebook:child","notebook:root"),node("notebook:root",f.b.id)]);
  f.remoteList.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const tree=await knowledgeTreeApi.listForWorkspace("personal");
  expect(tree.nodes.find((n)=>n.id==="notebook:child")?.parentId).toBe("notebook:root");
  expect(tree.nodes.find((n)=>n.id==="notebook:root")?.childCount).toBe(1);
  expect(tree.nodes.find((n)=>n.id===f.b.id)?.childCount).toBe(1);
  f.remoteList.mockResolvedValue({nodes:[f.a,{...f.b,isPasswordProtected:1}]});
  expect((await knowledgeTreeApi.listForWorkspace("personal")).nodes).toHaveLength(2);
});
it("does not grant provisional owner access to an ACKed folder omitted by a live tree",async()=>{
  const f=setup(); f.folderDrafts.mockResolvedValue([node("notebook:new")]); f.ack();
  expect((await knowledgeTreeApi.listForWorkspace("personal")).nodes).toHaveLength(2);
});
it("routes personal folder move, batch move and reorder through the durable transaction without HTTP", async () => {
  const f=setup();
  expect(await knowledgeTreeApi.move(f.a.id,{parentId:f.b.id,sortOrder:7})).toMatchObject({parentId:f.b.id,sortOrder:7});
  await knowledgeTreeApi.batchMove([f.a.id],{parentId:f.b.id});
  await knowledgeTreeApi.reorder([{id:f.a.id,sortOrder:7}]);
  expect(f.moves.mock.calls).toEqual([[[{id:f.a.id,parentId:f.b.id,sortOrder:7}]],[[{id:f.a.id,parentId:f.b.id}]],[[{id:f.a.id,sortOrder:7}]]]);
  expect(f.remoteMove).not.toHaveBeenCalled(); expect(f.remoteReorder).not.toHaveBeenCalled();
});
it("shows only pending folder intentions over a complete cached owner tree after HTTP becomes unavailable", async () => {
  const f=setup(); await knowledgeTreeApi.listForWorkspace("personal");
  f.overrides.mockResolvedValue([{id:f.a.id,parentId:f.b.id,sortOrder:7}]);
  f.remoteList.mockRejectedValue(new TypeError("Failed to fetch"));
  const tree=await knowledgeTreeApi.listForWorkspace("personal");
  expect(tree.nodes.find((n)=>n.id===f.a.id)).toMatchObject({parentId:f.b.id,sortOrder:7});
  expect(tree.nodes.find((n)=>n.id===f.b.id)?.childCount).toBe(1);
});
it("retains current password metadata instead of moving protected descendants into an unprotected navigation path", async () => {
  const f=setup();
  f.remoteList.mockResolvedValue({nodes:[{...f.a,parentId:f.b.id},{...f.b,isPasswordProtected:1}]});
  f.overrides.mockResolvedValue([{id:f.a.id,parentId:null,sortOrder:7}]);
  expect((await knowledgeTreeApi.listForWorkspace("personal")).nodes.find((n)=>n.id===f.a.id)?.parentId).toBe(f.b.id);
});
it("falls back for unavailable authorization but propagates a failed local commit without issuing another write", async () => {
  const f=setup();
  f.moves.mockRejectedValueOnce(Object.assign(new Error("Online authorization required"),{code:"NATIVE_TREE_WRITE_UNAVAILABLE"}));
  await knowledgeTreeApi.move(f.a.id,{parentId:null}); expect(f.remoteMove).toHaveBeenCalledOnce();
  f.moves.mockRejectedValueOnce(new Error("Outbox storage failed"));
  await expect(knowledgeTreeApi.move(f.a.id,{parentId:null})).rejects.toThrow("Outbox storage failed");
  expect(f.remoteMove).toHaveBeenCalledOnce();
  localStorage.setItem("nowen-current-workspace","workspace-a");
  await knowledgeTreeApi.move(f.a.id,{parentId:null}); expect(f.moves).toHaveBeenCalledTimes(2);
});

it("restores a mixed selection through its folder cohort and returns no permanent-deletion ids",async()=>{
  const f=setup(),child={...f.b,parentId:f.a.id,isDeleted:1},note={...f.a,id:"note:n",resourceId:"n",resourceType:"note",nodeType:"markdown",parentId:f.b.id,isDeleted:1} as KnowledgeTreeNode;
  f.remoteList.mockResolvedValue({nodes:[{...f.a,isDeleted:1},child,note]});
  f.restoreFolder.mockResolvedValue({success:true,restoredNodeIds:[f.a.id,f.b.id,note.id]});
  const result=await api.trash.mutate("personal","restore",[note.id,f.b.id,f.a.id]);
  expect(f.restoreFolder).toHaveBeenCalledOnce();expect(f.restoreFolder).toHaveBeenCalledWith(f.a.id);
  expect(result).toEqual({succeededIds:[note.id,f.b.id,f.a.id],noteIds:[],failures:[]});expect(f.remoteRestore).not.toHaveBeenCalled();
});
it("preserves the server's hidden-path and restore permission decisions for acknowledged trash",async()=>{
  const f=setup();f.remoteList.mockResolvedValue({nodes:[{...f.a,isDeleted:1},f.b]});
  const item={id:f.a.id,resourceId:f.a.resourceId,resourceType:"notebook",title:"Folder",contentFormat:null,deletedAt:"now",
    originalParentId:null,originalPath:[] as string[],originalPathHidden:true,canRestore:false,canDeletePermanently:false,isLocked:false,restoreIncludesAncestors:true} as const;
  f.remoteTrash.mockResolvedValue({items:[item]});
  expect((await api.trash.list("personal")).items[0]).toEqual(item);
});

import type { NativeDatabase } from "./nativeDatabase";
import { applyNativePersonalTree } from "./nativeKnowledgeTreeSync";
import { newLocalId } from "./localRepository";
import { personalWriteProofs, readNativePersonalTreeNode, type NativeTreeWriteContext } from "./nativePersonalTreeWrites";

export const nativeTreeLifecycleKey=(profileId:string)=>`nativeTreeLifecycle:${profileId}:personal`;
const cohortKey=(profileId:string,id:string)=>`nativeTreeTrash:${profileId}:${id}`;
function unavailable():never {throw Object.assign(new Error("个人文件夹回收站权限或删除批次尚未确认，请使用在线操作"),{code:"NATIVE_TREE_WRITE_UNAVAILABLE"});}

export async function readNativeTreeLifecycleIntents(tx:NativeDatabase,profileId:string):Promise<Record<string,unknown>[]> {
  const conflicts=await tx.query<{payload:string}>(`SELECT localPayload AS payload FROM sync_conflicts
    WHERE profileId=? AND scopeKey='personal' AND entityType='knowledge_tree_node' AND status='unresolved'`,[profileId]);
  const queued=await tx.query<{payload:string}>(`SELECT payload FROM sync_outbox WHERE profileId=? AND scopeKey='personal'
    AND entityType='knowledge_tree_node' ORDER BY createdAt,rowid`,[profileId]);
  const rows=[...conflicts,...queued];
  return rows.map((row)=>JSON.parse(row.payload||"null")).filter((payload)=>payload?.lifecycle && Array.isArray(payload.lifecycleNodes));
}

export async function nativeTreeLifecycleOverrides(tx:NativeDatabase,profileId:string):Promise<Record<string,unknown>[]> {
  const intents=await readNativeTreeLifecycleIntents(tx,profileId);
  return [...new Map(intents.flatMap((intent)=>intent.lifecycleNodes as Record<string,unknown>[]).map((node)=>[String(node.id),node])).values()];
}

/** Lifecycle state changes never remove a body, attachment or existing mutation. */
export async function applyNativeTreeLifecycleProjection(tx:NativeDatabase,nodes:Record<string,unknown>[],userId:string):Promise<void> {
  for(const node of nodes) {
    if(node.resourceType==="notebook") await tx.run("UPDATE notebooks SET isDeleted=?,deletedAt=?,updatedAt=? WHERE scopeKey='personal' AND id=?",
      [node.isDeleted,node.deletedAt,node.updatedAt,node.resourceId]);
    else if(node.resourceType==="note") await tx.run("UPDATE notes SET isTrashed=?,trashedAt=?,updatedAt=? WHERE scopeKey='personal' AND id=?",
      [node.isDeleted,node.deletedAt,node.updatedAt,node.resourceId]);
  }
  await applyNativePersonalTree(tx,nodes.map((payload)=>({entityId:String(payload.id),payload})),userId,false);
}

export async function writeNativePersonalTreeLifecycle(tx:NativeDatabase,id:string,restoring:boolean,context:NativeTreeWriteContext) {
  const capability=(await tx.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?",[nativeTreeLifecycleKey(context.profileId)]))[0];
  if(capability?.value!=="personal-folder-v1") unavailable();
  const assertAncestry=await personalWriteProofs(tx,context,restoring), proof=assertAncestry(id);
  const root=await readNativePersonalTreeNode(tx,id);
  if(!root || root.resourceType!=="notebook" || !proof.access.capabilities.canDelete) unavailable();
  if(root.isDeleted!==(restoring?1:0)) throw new Error(restoring?"内容不在回收站":"文件夹已在回收站");
  if(root.parentId && (await readNativePersonalTreeNode(tx,String(root.parentId)))?.isDeleted) throw new Error("请先恢复上级文件夹");
  const nodes=await tx.query<Record<string,unknown>>(`WITH RECURSIVE subtree(id) AS (
    SELECT ? UNION SELECT t.id FROM native_knowledge_tree_nodes t JOIN subtree p ON t.parentId=p.id WHERE t.scopeKey='personal'
  ) SELECT t.id,t.userId,t.workspaceId,t.parentId,t.nodeType,t.resourceType,t.resourceId,t.sortOrder,
    t.isDeleted,t.deletedAt,t.createdAt,t.updatedAt FROM native_knowledge_tree_nodes t JOIN subtree s ON t.id=s.id
    WHERE t.scopeKey='personal' ORDER BY t.id`,[id]);
  const recorded=(await tx.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?",[cohortKey(context.profileId,id)]))[0];
  const cohort=restoring?JSON.parse(recorded?.value||"null") as {mutationId:string;affectedNodeIds:string[]}|null:null;
  if(restoring && (!cohort || !Array.isArray(cohort.affectedNodeIds))) unavailable();
  const affected=restoring?nodes.filter((node)=>node.isDeleted && cohort!.affectedNodeIds.includes(String(node.id))):nodes.filter((node)=>!node.isDeleted);
  if(!affected.some((node)=>node.id===id)) unavailable();
  for(const node of affected) {
    const access=assertAncestry(String(node.id));
    if(!access.access.capabilities.canDelete || !["notebook","note"].includes(String(node.resourceType))) unavailable();
    if(node.resourceType==="note") {
      const note=(await tx.query<{contentFormat:string;isLocked:number}>("SELECT contentFormat,isLocked FROM notes WHERE scopeKey='personal' AND id=?",[node.resourceId]))[0];
      if(!note || note.isLocked || !["markdown","tiptap-json","plaintext"].includes(note.contentFormat)) unavailable();
    }
  }
  const timestamp=new Date().toISOString(), mutationId=newLocalId();
  const desired:Record<string,unknown>[]=affected.map((node)=>({...node,isDeleted:restoring?0:1,deletedAt:restoring?null:timestamp,updatedAt:timestamp}));
  // The atomic command's position lives in lifecycleNodes/baseSubtree. Omit
  // the ordinary sortOrder so older servers reject it before a partial delete.
  const payload={...desired.find((node)=>node.id===id)!,sortOrder:undefined,lifecycle:restoring?"restore":"trash",
    lifecycleMutationId:mutationId,restoreOf:cohort?.mutationId,affectedNodeIds:affected.map((node)=>node.id),
    baseSubtree:nodes.map(({id,parentId,sortOrder,isDeleted})=>({id,parentId,sortOrder,isDeleted})),lifecycleNodes:desired};
  await applyNativeTreeLifecycleProjection(tx,desired,context.userId);
  await tx.run(`INSERT INTO sync_outbox (id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,payload,status,retryCount,createdAt)
    VALUES (?,?,?,?,'personal','knowledge_tree_node',?,'upsert',?,'pending',0,?)`,
    [newLocalId(),mutationId,context.profileId,context.deviceId,id,JSON.stringify(payload),timestamp]);
  if(!restoring) await tx.run(`INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`,
    [cohortKey(context.profileId,id),JSON.stringify({mutationId,affectedNodeIds:affected.map((node)=>node.id)}),timestamp]);
  return affected.map((node)=>String(node.id));
}

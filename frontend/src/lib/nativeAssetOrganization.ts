import type { NativeDatabase } from "./nativeDatabase";
import { newLocalId } from "./localRepository";
import { NATIVE_TREE_ENTITY_SET } from "./nativeKnowledgeTreeSync";

export const NATIVE_ASSET_ENTITY_SET = `${NATIVE_TREE_ENTITY_SET},attachment_organization`;
export const nativeAssetBindingKey = (profileId: string) => `assetOrganization:${profileId}:personal`;

export function sameNativeAssetOrganization(a:Record<string,unknown>,b:Record<string,unknown>):boolean {
  return ["kind","resourceId","name","parentId","folderId","deleted","trashedAt"].every(key=>(a[key]??null)===(b[key]??null));
}

function fail(message: string,code="MOBILE_SYNC_ATTACHMENT_FOLDER_UNSUPPORTED"): never {
  throw Object.assign(new Error(message),{code});
}

export function assertNativeAssetMetadata(id: string, p: Record<string,unknown>, userId: string): void {
  if ((p.kind!=="folder" && p.kind!=="file") || typeof p.resourceId!=="string" || !p.resourceId
    || p.id!==id || id!==`${p.kind}:${p.resourceId}` || p.userId!==userId
    || (p.deleted!==0 && p.deleted!==1) || !Number.isSafeInteger(p.version) || Number(p.version)<1
    || (p.kind==="folder" && (typeof p.name!=="string" || !p.name.trim() || p.name.length>100
      || !(p.parentId===null || typeof p.parentId==="string" && p.parentId && p.parentId!==p.resourceId)))
    || (p.kind==="file" && !(p.folderId===null || typeof p.folderId==="string" && p.folderId))) fail("附件目录快照无效，已保留本机数据","INVALID_PAYLOAD");
}

export async function readNativeAssetMetadata(tx: NativeDatabase, id: string, userId: string): Promise<Record<string,unknown>|null> {
  const row=(await tx.query<{payload:string;version:number}>("SELECT payload,version FROM native_asset_metadata WHERE id=? AND userId=?",[id,userId]))[0];
  return row ? {...JSON.parse(row.payload),version:row.version} : null;
}

export async function nativeAssetContext(tx: NativeDatabase,userId: string): Promise<{profileId:string;deviceId:string}> {
  const context=(await tx.query<{profileId:string;deviceId:string}>(`SELECT p.id AS profileId,d.deviceId FROM sync_profiles p
    JOIN sync_devices d ON d.profileId=p.id JOIN native_runtime_meta m ON m.key='assetOrganization:'||p.id||':personal'
    WHERE p.remoteUserId=? AND m.value=? ORDER BY p.enabled DESC,p.updatedAt DESC LIMIT 1`,[userId,NATIVE_ASSET_ENTITY_SET]))[0];
  if(!context) fail("请先连接支持附件目录同步的服务器并完成首次同步");
  return context;
}

/** Caller owns the business transaction; queue failure rolls back the user's change. */
export async function queueNativeAsset(tx:NativeDatabase,p:Record<string,unknown>,userId:string):Promise<void> {
  const context=await nativeAssetContext(tx,userId);
  await writeAssetMutation(tx,p,userId,context);
}

async function writeAssetMutation(tx:NativeDatabase,p:Record<string,unknown>,userId:string,context:{profileId:string;deviceId:string},baseVersion?:number):Promise<void> {
  const previous=await readNativeAssetMetadata(tx,String(p.id),userId);
  const base=baseVersion??Number(previous?.version??0);
  const version=base+1;
  const payload={...p,userId,version};
  assertNativeAssetMetadata(String(p.id),payload,userId);
  await tx.run(`INSERT INTO native_asset_metadata(id,userId,version,payload) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload=excluded.payload`,[p.id,userId,version,JSON.stringify(payload)]);
  await tx.run(`INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,baseVersion,payload,status,retryCount,createdAt)
    VALUES (?,?,?,?,'personal','attachment_organization',?,'upsert',?,?,'pending',0,?)`,
  [newLocalId(),newLocalId(),context.profileId,context.deviceId,p.id,base,JSON.stringify(payload),new Date().toISOString()]);
}

/** Preserve pre-existing local organization during the first negotiated Snapshot. */
export async function prepareNativeAssetBaseline(tx:NativeDatabase,remoteEntries:Record<string,unknown>[],userId:string,context:{profileId:string;deviceId:string}):Promise<void> {
  const binding=(await tx.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?",[nativeAssetBindingKey(context.profileId)]))[0]?.value;
  if(binding===NATIVE_ASSET_ENTITY_SET || binding==="pending:"+NATIVE_ASSET_ENTITY_SET) return;
  const remote=new Map(remoteEntries.map(p=>[String(p.id),p]));
  const folders=await tx.query<Record<string,unknown>>("SELECT * FROM mobile_local_attachment_folders WHERE userId=? ORDER BY rowid",[userId]);
  const files=await tx.query<Record<string,unknown>>("SELECT id,folderId FROM attachments WHERE scopeKey='personal' AND userId=? AND folderId IS NOT NULL",[userId]);
  const local=folders.map(f=>({...f,id:`folder:${f.id}`,resourceId:f.id,kind:"folder",deleted:0} as Record<string,unknown>));
  local.push(...files.map(f=>({id:`file:${f.id}`,resourceId:f.id,kind:"file",folderId:f.folderId,trashedAt:null,deleted:0})));
  for(const p of local) {
    const other=remote.get(String(p.id));
    if(other && sameNativeAssetOrganization(p,other)) continue;
    if(other) {
      const existing=await tx.query("SELECT id FROM sync_conflicts WHERE profileId=? AND entityType='attachment_organization' AND entityId=? AND status='unresolved'",[context.profileId,p.id]);
      if(!existing.length) await tx.run(`INSERT INTO sync_conflicts(id,profileId,scopeKey,entityType,entityId,localPayload,remotePayload,remoteVersion,status,createdAt)
        VALUES (?,?,'personal','attachment_organization',?,?,?,?,'unresolved',?)`,
      [newLocalId(),context.profileId,p.id,JSON.stringify({...p,userId,version:1}),JSON.stringify(other),other.version,new Date().toISOString()]);
    } else {
      const pending=await tx.query("SELECT id FROM sync_outbox WHERE profileId=? AND entityType='attachment_organization' AND entityId=?",[context.profileId,p.id]);
      if(!pending.length) await writeAssetMutation(tx,{...p,userId},userId,context,0);
    }
  }
}

/** Apply a complete graph in one transaction; organization never removes attachment bytes. */
export async function applyNativeAssetMetadata(tx:NativeDatabase,entries:Record<string,unknown>[],userId:string):Promise<void> {
  for(const p of entries) {
    assertNativeAssetMetadata(String(p.id),p,userId);
    const previous=(await tx.query<{userId:string}>("SELECT userId FROM native_asset_metadata WHERE id=?",[p.id]))[0];
    if(previous && previous.userId!==userId) fail("附件目录账号不匹配");
    await tx.run(`INSERT INTO native_asset_metadata(id,userId,version,payload) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload=excluded.payload`,[p.id,userId,p.version,JSON.stringify(p)]);
    if(p.kind==="folder") {
      if(p.deleted) await tx.run(`DELETE FROM mobile_local_attachment_folders WHERE id=? AND userId=?
        AND NOT EXISTS (SELECT 1 FROM attachments WHERE folderId=mobile_local_attachment_folders.id)
        AND NOT EXISTS (SELECT 1 FROM mobile_local_attachment_folders child WHERE child.parentId=mobile_local_attachment_folders.id)`,[p.resourceId,userId]);
      else await tx.run(`INSERT INTO mobile_local_attachment_folders(id,userId,name,parentId,createdAt,updatedAt) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,parentId=excluded.parentId,updatedAt=excluded.updatedAt`,
      [p.resourceId,userId,p.name,p.parentId,p.createdAt||new Date().toISOString(),p.updatedAt||new Date().toISOString()]);
    } else await tx.run("UPDATE attachments SET folderId=?,assetTrashedAt=? WHERE scopeKey='personal' AND id=? AND userId=?",
      [p.deleted||p.trashedAt?null:p.folderId,p.deleted?"deleted":p.trashedAt??null,p.resourceId,userId]);
  }
  while((await tx.run(`DELETE FROM mobile_local_attachment_folders WHERE userId=? AND id IN
    (SELECT json_extract(payload,'$.resourceId') FROM native_asset_metadata WHERE userId=?
      AND json_extract(payload,'$.kind')='folder' AND json_extract(payload,'$.deleted')=1)
    AND NOT EXISTS (SELECT 1 FROM attachments WHERE folderId=mobile_local_attachment_folders.id)
    AND NOT EXISTS (SELECT 1 FROM mobile_local_attachment_folders child WHERE child.parentId=mobile_local_attachment_folders.id)`,[userId,userId])).changes) { /* Children first. */ }
  const rows=await tx.query<{id:string;parentId:string|null}>("SELECT id,parentId FROM mobile_local_attachment_folders WHERE userId=?",[userId]);
  const parents=new Map(rows.map(row=>[row.id,row.parentId]));
  for(const row of rows) {
    const seen=new Set<string>();let id:string|null=row.id;
    while(id) {
      if(seen.has(id)||!parents.has(id)) fail("附件目录父节点缺失或形成循环");
      seen.add(id);id=parents.get(id)!;
    }
  }
}

import { nativeAssetContext, queueNativeAsset } from "./nativeAssetOrganization";
import type { FileDetail, FileItem, FileListResponse } from "@/types";
import { api } from "./api";
import { newLocalId } from "./localRepository";
import type { NativeDatabase } from "./nativeDatabase";

type AttachmentFolder = {
  id: string;
  userId: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  fileCount?: number;
};

function now(): string {
  return new Date().toISOString();
}

/** Native directory facade. Signed-in writes require a bound protocol and
 * commit the business row and its recoverable organization mutation together. */
export function installMobileLocalAttachmentFolderBridge(
  db: NativeDatabase,
  userId: string,
  sync?: { onCommitted: () => void; assertActive: () => void },
): () => void {
  const target = api;
  const originals = {
    attachmentFolders: { ...target.attachmentFolders },
    filesList: target.files.list,
    filesGet: target.files.get,
    filesUpload: target.files.upload,
    filesMove: target.files.move,
  };

  let schemaPromise: Promise<void> | null = null;
  const ready = () => {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await db.run(`CREATE TABLE IF NOT EXISTS mobile_local_attachment_folders (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          name TEXT NOT NULL,
          parentId TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_mobile_local_attachment_folders_parent
          ON mobile_local_attachment_folders(userId,parentId,name)`);
        const columns = await db.query<{ name: string }>("PRAGMA table_info(attachments)");
        if (!columns.some((column) => column.name === "folderId")) {
          await db.run("ALTER TABLE attachments ADD COLUMN folderId TEXT");
        }
        // 索引单独幂等创建：即使某次升级已加列但在建索引前中断，下一次也能自动修复。
        await db.run(`CREATE INDEX IF NOT EXISTS idx_native_attachments_folder
          ON attachments(scopeKey,folderId,createdAt)`);
      })();
    }
    return schemaPromise;
  };

  const readFolder = async (id: string, tx = db): Promise<AttachmentFolder> => {
    const row = (await tx.query<AttachmentFolder>(
      "SELECT * FROM mobile_local_attachment_folders WHERE id=? AND userId=? LIMIT 1",
      [id,userId],
    ))[0];
    if (!row) throw new Error("文件夹不存在");
    return row;
  };

  const assertUniqueName = async (
    name: string,
    parentId: string | null,
    excludeId?: string,
    tx = db,
  ): Promise<void> => {
    const rows = await tx.query<{ id: string }>(`
      SELECT id FROM mobile_local_attachment_folders
      WHERE userId=? AND name=?
        AND ((parentId=?) OR (parentId IS NULL AND ? IS NULL))
        ${excludeId ? "AND id<>?" : ""}
      LIMIT 1
    `, excludeId
      ? [userId,name,parentId,parentId,excludeId]
      : [userId,name,parentId,parentId]);
    if (rows.length) throw new Error("同级已存在同名文件夹");
  };

  const listFolders = async () => {
    await ready();
    sync?.assertActive();
    const folders = await db.query<AttachmentFolder>(`
      SELECT f.*,
        (SELECT COUNT(*) FROM attachments a
          WHERE a.scopeKey='personal' AND a.userId=? AND a.available=1 AND a.folderId=f.id${sync ? ' AND a.assetTrashedAt IS NULL' : ''}
        ) AS fileCount
      FROM mobile_local_attachment_folders f
      WHERE f.userId=?
      ORDER BY f.name COLLATE NOCASE
    `,[userId,userId]);
    let supported=true;
    if(sync) { try { await nativeAssetContext(db,userId); } catch(error) {
      if((error as {code?:string}).code!=="MOBILE_SYNC_ATTACHMENT_FOLDER_UNSUPPORTED") throw error;
      supported=false;
    } }
    return { supported, folders: folders.map((folder) => ({
      ...folder,
      fileCount: Number(folder.fileCount) || 0,
    })) };
  };

  const write = async <T>(work: (tx: NativeDatabase) => Promise<T>): Promise<T> => {
    await ready();
    sync?.assertActive();
    const result = await db.transaction(async tx => {
      if (sync) await nativeAssetContext(tx,userId);
      sync?.assertActive();
      return work(tx);
    });
    sync?.onCommitted();
    return result;
  };
  const captureFolder = async (tx: NativeDatabase, folder: AttachmentFolder, deleted = 0) => {
    if (sync) await queueNativeAsset(tx,{...folder,id:`folder:${folder.id}`,resourceId:folder.id,kind:"folder",deleted},userId);
  };
  const validName = (rawName: string) => {
    const name=String(rawName || "").trim();
    if (!name || name.length>100) throw new Error("请提供 1–100 字的文件夹名称");
    return name;
  };
  target.attachmentFolders.list = listFolders;
  target.attachmentFolders.create = async (rawName: string, rawParentId?: string) => write(async tx => {
    const name=validName(rawName),parentId=rawParentId || null;
    if(parentId) await readFolder(parentId,tx);
    await assertUniqueName(name,parentId,undefined,tx);
    const folder={id:newLocalId(),userId,name,parentId,createdAt:now(),updatedAt:now()};
    await tx.run(`INSERT INTO mobile_local_attachment_folders (id,userId,name,parentId,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`,
      [folder.id,userId,name,parentId,folder.createdAt,folder.updatedAt]);
    await captureFolder(tx,folder);
    return {...folder,fileCount:0};
  });
  target.attachmentFolders.rename = async (id: string, rawName: string) => write(async tx => {
    const folder=await readFolder(id,tx),name=validName(rawName);
    await assertUniqueName(name,folder.parentId,id,tx);
    const updatedAt=now();
    await tx.run("UPDATE mobile_local_attachment_folders SET name=?,updatedAt=? WHERE id=? AND userId=?",[name,updatedAt,id,userId]);
    await captureFolder(tx,{...folder,name,updatedAt});
    return {id,name,parentId:folder.parentId};
  });
  target.attachmentFolders.remove = async (id: string) => write(async tx => {
    const folder=await readFolder(id,tx);
    const files=await tx.query("SELECT id FROM attachments WHERE folderId=? LIMIT 1",[id]);
    const children=await tx.query("SELECT id FROM mobile_local_attachment_folders WHERE parentId=? LIMIT 1",[id]);
    if(files.length || children.length) throw Object.assign(new Error("文件夹非空，请先移出文件和子文件夹"),{code:"FOLDER_NOT_EMPTY"});
    await tx.run("DELETE FROM mobile_local_attachment_folders WHERE id=? AND userId=?",[id,userId]);
    await captureFolder(tx,folder,1);
    return {success:true};
  });
  target.attachmentFolders.move = async (id: string, parentId: string|null) => write(async tx => {
    const folder=await readFolder(id,tx),seen=new Set([id]);
    let ancestor=parentId;
    while(ancestor) {
      if(seen.has(ancestor)) throw Object.assign(new Error("不能移动到自身或子文件夹"),{code:"FOLDER_CYCLE"});
      seen.add(ancestor);ancestor=(await readFolder(ancestor,tx)).parentId;
    }
    await assertUniqueName(folder.name,parentId,id,tx);
    const updatedAt=now();
    await tx.run("UPDATE mobile_local_attachment_folders SET parentId=?,updatedAt=? WHERE id=? AND userId=?",[parentId,updatedAt,id,userId]);
    await captureFolder(tx,{...folder,parentId,updatedAt});
    return {id,name:folder.name,parentId};
  });

  const folderMap = async (): Promise<Map<string,AttachmentFolder>> => {
    const { folders } = await listFolders();
    return new Map<string,AttachmentFolder>(
      folders.map((folder): [string,AttachmentFolder] => [folder.id,folder]),
    );
  };

  const assignmentMap = async (): Promise<Map<string,string|null>> => {
    await ready();
    const rows = await db.query<{ id: string; folderId: string | null }>(`
      SELECT id,folderId FROM attachments
      WHERE scopeKey='personal' AND available=1
    `);
    return new Map<string,string|null>(
      rows.map((row): [string,string|null] => [row.id,row.folderId || null]),
    );
  };

  const decorateItems = async <T extends FileItem>(items: T[]): Promise<T[]> => {
    const [folders,assignments] = await Promise.all([folderMap(),assignmentMap()]);
    return items.map((item) => {
      const folderId = assignments.get(item.id) || null;
      return {
        ...item,
        folderId,
        folderName: folderId ? folders.get(folderId)?.name || null : null,
        canManage: true,
      };
    });
  };

  target.files.list = async (params: Record<string, unknown> = {}): Promise<FileListResponse> => {
    await ready();
    const result = await originals.filesList(params) as FileListResponse;
    return { ...result,items:await decorateItems(result.items) };
  };
  target.files.get = async (id: string): Promise<FileDetail> => {
    await ready();
    const item = await originals.filesGet(id) as FileDetail;
    return (await decorateItems([item]))[0] as FileDetail;
  };
  target.files.upload = async (file: File, options?: { noteId?: string; notebookId?: string; folderId?: string }) => {
    await ready();
    const folderId = options?.folderId || null;
    const folder = folderId ? await readFolder(folderId) : null;
    if(sync) { sync.assertActive(); await db.transaction(tx=>nativeAssetContext(tx,userId)); }
    const item = await originals.filesUpload(file, options);
    sync?.assertActive();
    if (folderId && !(item as FileItem & { deduplicated?: boolean }).deduplicated) {
      await target.files.move([item.id],folderId);
    }
    if ((item as FileItem & { deduplicated?: boolean }).deduplicated) return (await decorateItems([item]))[0];
    return { ...item, folderId, folderName:folder?.name || null };
  };

  target.files.move = async (rawIds: string[], folderId: string | null, expectedFolderIds?: Record<string,string|null>) => write(async tx => {
    if(!rawIds.length || rawIds.length>200 || rawIds.some(id=>typeof id!=="string" || !id)) throw new Error("请提供 1–200 个文件 ID");
    const ids=[...new Set(rawIds)],folder=folderId?await readFolder(folderId,tx):null;
    for(const id of ids) {
      const row=(await tx.query<{id:string;folderId:string|null}>(
        `SELECT id FROM attachments WHERE id=? AND scopeKey='personal' AND userId=? AND available=1${sync ? ' AND assetTrashedAt IS NULL' : ''}`,[id,userId]))[0];
      if(!row) throw new Error("文件不存在或无权移动");
      const location=expectedFolderIds ? (await tx.query<{folderId:string|null}>("SELECT folderId FROM attachments WHERE id=? AND userId=? AND scopeKey='personal'",[id,userId]))[0] : undefined;
      if(expectedFolderIds && Object.hasOwn(expectedFolderIds,id) && (location?.folderId || null)!==expectedFolderIds[id]) {
        throw Object.assign(new Error("文件位置已更改，请刷新后重试"),{code:"FILE_LOCATION_CONFLICT"});
      }
    }
    for(const id of ids) {
      await tx.run("UPDATE attachments SET folderId=?,updatedAt=? WHERE id=? AND scopeKey='personal' AND userId=?",[folderId,now(),id,userId]);
      if(sync) await queueNativeAsset(tx,{id:`file:${id}`,kind:"file",resourceId:id,folderId,trashedAt:null,deleted:0},userId);
    }
    return {success:true,moved:ids.length,folderId,folderName:folder?.name || null};
  });

  return () => {
    target.attachmentFolders = originals.attachmentFolders;
    target.files.list = originals.filesList;
    target.files.get = originals.filesGet;
    target.files.upload = originals.filesUpload;
    target.files.move = originals.filesMove;
  };
}

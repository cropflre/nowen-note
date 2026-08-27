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

/**
 * Android 设备本地模式的附件文件夹门面。
 *
 * Native v2 schema 最初没有 attachment_folders / attachments.folderId。这里采用和
 * AdvancedTaskBridge 相同的“本地运行时增量 schema”策略：只在设备本地库第一次
 * 使用文件夹能力时补表/补列，不触碰 Server Sync 的实体注册表。
 */
export function installMobileLocalAttachmentFolderBridge(
  db: NativeDatabase,
  userId: string,
): () => void {
  const target = api as any;
  const originals = {
    attachmentFolders: { ...target.attachmentFolders },
    filesList: target.files.list,
    filesGet: target.files.get,
    filesUpload: target.files.upload,
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
          await db.run(`CREATE INDEX IF NOT EXISTS idx_native_attachments_folder
            ON attachments(scopeKey,folderId,createdAt)`);
        }
      })();
    }
    return schemaPromise;
  };

  const readFolder = async (id: string): Promise<AttachmentFolder> => {
    await ready();
    const row = (await db.query<AttachmentFolder>(
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
  ): Promise<void> => {
    const rows = await db.query<{ id: string }>(`
      SELECT id FROM mobile_local_attachment_folders
      WHERE userId=? AND name=?
        AND ((parentId=? ) OR (parentId IS NULL AND ? IS NULL))
        ${excludeId ? "AND id<>?" : ""}
      LIMIT 1
    `, excludeId
      ? [userId,name,parentId,parentId,excludeId]
      : [userId,name,parentId,parentId]);
    if (rows.length) throw new Error("同级已存在同名文件夹");
  };

  const listFolders = async () => {
    await ready();
    const folders = await db.query<AttachmentFolder>(`
      SELECT f.*,
        (SELECT COUNT(*) FROM attachments a
          WHERE a.scopeKey='personal' AND a.userId=? AND a.available=1 AND a.folderId=f.id
        ) AS fileCount
      FROM mobile_local_attachment_folders f
      WHERE f.userId=?
      ORDER BY f.name COLLATE NOCASE
    `,[userId,userId]);
    return { folders: folders.map((folder) => ({
      ...folder,
      fileCount: Number(folder.fileCount) || 0,
    })) };
  };

  target.attachmentFolders.list = listFolders;
  target.attachmentFolders.create = async (rawName: string, rawParentId?: string) => {
    await ready();
    const name = String(rawName || "").trim();
    const parentId = rawParentId || null;
    if (!name) throw new Error("文件夹名称不能为空");
    if (name.length > 100) throw new Error("文件夹名称过长");
    if (parentId) await readFolder(parentId);
    await assertUniqueName(name,parentId);
    const id = newLocalId();
    const timestamp = now();
    await db.run(`INSERT INTO mobile_local_attachment_folders
      (id,userId,name,parentId,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`,[
      id,userId,name,parentId,timestamp,timestamp,
    ]);
    return { id,name,parentId,fileCount:0 };
  };
  target.attachmentFolders.rename = async (id: string, rawName: string) => {
    const folder = await readFolder(id);
    const name = String(rawName || "").trim();
    if (!name) throw new Error("文件夹名称不能为空");
    if (name.length > 100) throw new Error("文件夹名称过长");
    await assertUniqueName(name,folder.parentId,id);
    await db.run("UPDATE mobile_local_attachment_folders SET name=?,updatedAt=? WHERE id=? AND userId=?",[
      name,now(),id,userId,
    ]);
    return { id,name,parentId:folder.parentId };
  };
  target.attachmentFolders.remove = async (id: string) => {
    await readFolder(id);
    await db.transaction(async (tx) => {
      await tx.run("UPDATE attachments SET folderId=NULL,updatedAt=? WHERE scopeKey='personal' AND userId=? AND folderId=?",[
        now(),userId,id,
      ]);
      // 后端目前没有文件夹移动 API；若未来 UI 创建了子文件夹，删除父级后把子级提升到根，
      // 避免留下不可达 parentId。
      await tx.run("UPDATE mobile_local_attachment_folders SET parentId=NULL,updatedAt=? WHERE userId=? AND parentId=?",[
        now(),userId,id,
      ]);
      await tx.run("DELETE FROM mobile_local_attachment_folders WHERE id=? AND userId=?",[id,userId]);
    });
    return { success:true };
  };

  const folderMap = async () => {
    const { folders } = await listFolders();
    return new Map<string,AttachmentFolder>(folders.map((folder: AttachmentFolder) => [folder.id,folder]));
  };

  const assignmentMap = async () => {
    await ready();
    const rows = await db.query<{ id: string; folderId: string | null }>(`
      SELECT id,folderId FROM attachments
      WHERE scopeKey='personal' AND available=1
    `);
    return new Map(rows.map((row) => [row.id,row.folderId || null]));
  };

  const decorateItems = async <T extends FileItem>(items: T[]): Promise<T[]> => {
    const [folders,assignments] = await Promise.all([folderMap(),assignmentMap()]);
    return items.map((item) => {
      const folderId = assignments.get(item.id) || null;
      return {
        ...item,
        folderId,
        folderName: folderId ? folders.get(folderId)?.name || null : null,
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
  target.files.upload = async (file: File, options?: { folderId?: string }) => {
    await ready();
    const folderId = options?.folderId || null;
    const folder = folderId ? await readFolder(folderId) : null;
    const item = await originals.filesUpload(file, options);
    if (folderId) {
      await db.run("UPDATE attachments SET folderId=?,updatedAt=? WHERE scopeKey='personal' AND id=?",[
        folderId,now(),item.id,
      ]);
    }
    return {
      ...item,
      folderId,
      folderName:folder?.name || null,
    };
  };

  return () => {
    target.attachmentFolders = originals.attachmentFolders;
    target.files.list = originals.filesList;
    target.files.get = originals.filesGet;
    target.files.upload = originals.filesUpload;
  };
}

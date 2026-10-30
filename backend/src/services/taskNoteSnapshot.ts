import { createHash } from "node:crypto";
import { getDb } from "../db/schema.js";
import { getUserWorkspaceRole, hasPermission, resolveNotebookPermission, resolveNotePermission } from "../middleware/acl.js";
import { createKnowledgeChild, KnowledgeTreeError } from "./knowledgeTree.js";
import { copyStoredAttachmentObjects, copyReferencedNoteAttachments, cleanupCopiedAttachmentObjects,
  rewriteSourceAttachmentUrl, NoteAttachmentCopyError, type CopiedAttachmentObject } from "./noteAttachmentCopy.js";
import { syncNoteBlocks } from "../lib/noteBlocks.js";
import { syncReferences } from "../lib/attachmentRefs.js";
import { syncNoteLinks } from "../lib/noteLinks.js";
import { rebuildBlockAuthorityStore } from "../lib/blockAuthorityStore.js";
import { rebuildYjsSubdocumentsIfEnabled } from "./yjs-subdocuments.js";
import { stabilizePersistedNoteContent, TransientPersistedImageSourceError } from "../lib/noteContentAttachmentIdentity.js";

export class TaskSnapshotError extends Error {
  constructor(public code: string, public status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

export async function saveTaskNoteSnapshot(userId: string, taskId: string, body: any) {
  if (!body || typeof body.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.requestId)
    || typeof body.notebookId !== "string" || typeof body.title !== "string" || !body.title.trim()
    || typeof body.description !== "string" || body.description.length > 1_000_000) {
    throw new TaskSnapshotError("INVALID_PAYLOAD", 400, "保存内容或位置无效");
  }
  const db = getDb();
  const validateAccess = () => {
    const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as any;
    if (!task) throw new TaskSnapshotError("TASK_NOT_FOUND", 404, "任务不存在");
    // Optional MCP precondition; checked both before copying attachments and
    // inside the final transaction so a concurrent task edit cannot silently
    // create a stale note snapshot.
    if ((body.expectedTaskUpdatedAt !== undefined && body.expectedTaskUpdatedAt !== task.updatedAt)
        || (body.expectedTaskTitle !== undefined && body.expectedTaskTitle !== task.title)
        || (body.expectedTaskDescription !== undefined
          && body.expectedTaskDescription !== (task.description || ""))) {
      throw new TaskSnapshotError("TASK_SNAPSHOT_STALE", 409, "任务详情已变化，请重新预览");
    }
    if (task.workspaceId ? !getUserWorkspaceRole(task.workspaceId, userId) : task.userId !== userId) {
      throw new TaskSnapshotError("FORBIDDEN", 403, "无权读取任务");
    }
    const notebook = db.prepare("SELECT workspaceId,isDeleted FROM notebooks WHERE id=?").get(body.notebookId) as any;
    if (!notebook || notebook.isDeleted) throw new TaskSnapshotError("NOTEBOOK_NOT_FOUND", 404, "保存位置不存在");
    if (notebook.workspaceId !== task.workspaceId) throw new TaskSnapshotError("SCOPE_MISMATCH", 403, "请保存到任务所属空间");
    if (!hasPermission(resolveNotebookPermission(body.notebookId, userId).permission, "write")) {
      throw new TaskSnapshotError("FORBIDDEN", 403, "无权在此处创建笔记");
    }
    const parent = db.prepare("SELECT id FROM knowledge_tree_nodes WHERE resourceType='notebook' AND resourceId=? AND isDeleted=0").get(body.notebookId) as { id: string } | undefined;
    if (!parent) throw new TaskSnapshotError("NOTEBOOK_NOT_FOUND", 409, "保存位置尚未初始化，请刷新后重试");
    return { task, parentId: parent.id };
  };
  const source = validateAccess();
  let description: string;
  try { description = stabilizePersistedNoteContent(body.description,"markdown"); }
  catch (error) {
    if (error instanceof TransientPersistedImageSourceError) throw new TaskSnapshotError("TRANSIENT_IMAGE_SOURCE",409,"附件仍是临时地址，请等待上传完成后重试");
    throw error;
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([taskId,body.notebookId,body.title,body.description])).digest("hex");
  const readExisting = () => {
    const receipt = db.prepare("SELECT * FROM task_note_snapshots WHERE requestId=?").get(body.requestId) as any;
    if (!receipt) return null;
    if (receipt.userId !== userId || receipt.fingerprint !== fingerprint) throw new TaskSnapshotError("REQUEST_CONFLICT", 409, "保存请求已用于其他内容，请重新发起");
    const note = db.prepare("SELECT * FROM notes WHERE id=? AND isTrashed=0").get(receipt.noteId) as any;
    if (!note) throw new TaskSnapshotError("SNAPSHOT_REMOVED", 409, "之前生成的笔记已删除，请重新发起保存");
    if (!hasPermission(resolveNotePermission(note.id,userId).permission,"read")) throw new TaskSnapshotError("FORBIDDEN",403,"无权访问之前生成的笔记");
    return note;
  };
  const existing = readExisting();
  if (existing) return existing;
  const taskAttachments = db.prepare("SELECT id,filename,mimeType,size,path,NULL AS hash FROM task_attachments WHERE taskId=?").all(taskId) as any[];
  const referencedIds = Array.from(description.matchAll(/\/api\/task-attachments\/([A-Za-z0-9_-]+)/g), (match) => match[1]);
  if (referencedIds.some((id) => !taskAttachments.some((item) => item.id === id))) {
    throw new TaskSnapshotError("ATTACHMENT_UNAVAILABLE", 409, "详情中有不属于此任务或已丢失的附件");
  }
  let copied: CopiedAttachmentObject[] = [];
  try {
    copied = await copyStoredAttachmentObjects(taskAttachments);
    copied.push(...await copyReferencedNoteAttachments({ db, userId, noteId: "", content: description }));
    let content = description;
    for (const item of copied) {
      const url = `/api/attachments/${item.id}`;
      if (taskAttachments.some((attachment) => attachment.id === item.sourceId)) {
        const pattern = new RegExp(`(?:https?:\\/\\/[^/\\s"'<>]+)?/api/task-attachments/${item.sourceId}(?:\\?[^\\s"'<>)]*)?`, "g");
        const referenced = referencedIds.includes(item.sourceId);
        content = content.replace(pattern, url);
        if (!referenced) content += `\n\n[${item.filename.replace(/[\\[\]]/g, "\\$&")}](${url})`;
      } else content = rewriteSourceAttachmentUrl(content, item.sourceId, url);
    }
    let usedCopies = false;
    const note = db.transaction(() => {
      const current = validateAccess();
      if (current.task.workspaceId !== source.task.workspaceId) throw new TaskSnapshotError("SCOPE_MISMATCH", 409, "任务已移动，请重新保存");
      const duplicate = readExisting();
      if (duplicate) return duplicate;
      for (const attachment of taskAttachments) {
        if (!db.prepare("SELECT 1 FROM task_attachments WHERE id=? AND taskId=? AND path=?").get(attachment.id,taskId,attachment.path)) {
          throw new TaskSnapshotError("ATTACHMENT_UNAVAILABLE", 409, "附件已变化，请重新保存");
        }
      }
      const node = createKnowledgeChild({ actorUserId: userId, workspaceId: current.task.workspaceId,
        parentId: current.parentId, nodeType: "markdown", title: body.title, db });
      for (const attachment of copied) db.prepare(`INSERT INTO attachments
        (id,noteId,userId,workspaceId,filename,mimeType,size,path,hash,uploadSource) VALUES (?,?,?,?,?,?,?,?,?,'task_snapshot')`)
        .run(attachment.id,node.resourceId,userId,current.task.workspaceId,attachment.filename,attachment.mimeType,attachment.size,attachment.path,attachment.hash);
      const synced = syncNoteBlocks(db,node.resourceId,content,"markdown");
      db.prepare("UPDATE notes SET content=?,contentText=?,contentFormat='markdown' WHERE id=?").run(synced.content,synced.contentText,node.resourceId);
      syncReferences(db,node.resourceId,synced.content);
      syncNoteLinks(db,userId,node.resourceId,synced.content);
      rebuildBlockAuthorityStore(db,node.resourceId,synced.content,"markdown",{ noteVersion: 1, operationType: "create" });
      rebuildYjsSubdocumentsIfEnabled(db,node.resourceId,synced.content,"markdown");
      db.prepare("INSERT INTO task_note_snapshots VALUES (?,?,?,?,?)").run(body.requestId,userId,taskId,node.resourceId,fingerprint);
      usedCopies = true;
      return db.prepare("SELECT * FROM notes WHERE id=?").get(node.resourceId);
    })();
    if (!usedCopies) await cleanupCopiedAttachmentObjects(copied);
    return note;
  } catch (error) {
    await cleanupCopiedAttachmentObjects(copied);
    if (error instanceof NoteAttachmentCopyError || error instanceof KnowledgeTreeError) {
      throw new TaskSnapshotError(error.code, error.status as 403 | 409, error.message);
    }
    throw error;
  }
}

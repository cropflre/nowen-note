import { getCurrentWorkspace } from "./api";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "./knowledgeTreeApi";
import {
  KNOWLEDGE_TREE_PASSWORD_NOTES_LOCKED_EVENT,
  KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT,
  loadUnlockedFolderIds,
  createNoteFolderPasswordResolver,
} from "./knowledgeTreePassword";

type LocalNote = { id: string; notebookId: string; workspaceId?: string | null };

/** Native 同步库没有 notebook_passwords，读取必须依据服务端树或其离线快照。 */
export function createMobileLocalNotePasswordGuard(authorizeRemote: (id: string) => Promise<unknown>) {
  const protectedReads = new Map<string, string[]>();
  const onSessionChanged = () => {
    const unlocked = loadUnlockedFolderIds();
    const noteIds = [...protectedReads]
      .filter(([, folderIds]) => folderIds.some((id) => !unlocked.has(id)))
      .map(([noteId]) => noteId);
    if (noteIds.length) window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_PASSWORD_NOTES_LOCKED_EVENT, {
      detail: { noteIds },
    }));
  };
  window.addEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, onSessionChanged);
  const readTree = async (workspaceId: string): Promise<KnowledgeTreeNode[]> =>
    (await knowledgeTreeApi.listForWorkspace(workspaceId, true)).nodes;

  const lockedError = () => Object.assign(new Error("请先在目录中解锁笔记所在的密码文件夹"), {
    status: 403, code: "FOLDER_UNLOCK_REQUIRED",
  });

  const assertReadable = async (note: LocalNote): Promise<void> => {
    const nodes = await readTree(note.workspaceId || "personal");
    const folderIds = createNoteFolderPasswordResolver(nodes)(note);
    if (!folderIds) throw new Error("目录密码状态无法确认，请联网刷新目录后重试");
    if (!folderIds.length) { protectedReads.delete(note.id); return; }
    protectedReads.set(note.id, folderIds);
    const unlocked = loadUnlockedFolderIds();
    if (folderIds.some((id) => !unlocked.has(id))) throw lockedError();
    // 密码版本/绑定改变后旧令牌必须由服务器拒绝。
    await authorizeRemote(note.id);
    const current = loadUnlockedFolderIds();
    if (folderIds.some((id) => !current.has(id))) throw lockedError();
  };

  const filterReadable = async <T extends LocalNote>(notes: T[], workspaceId = getCurrentWorkspace()): Promise<T[]> => {
    if (!notes.length) return notes;
    const nodes = await readTree(workspaceId);
    const resolveFolders = createNoteFolderPasswordResolver(nodes);
    const visible = await Promise.all(notes.map(async (note) => {
      const folderIds = resolveFolders(note);
      if (!folderIds) return false;
      if (!folderIds.length) { protectedReads.delete(note.id); return true; }
      protectedReads.set(note.id, folderIds);
      const unlocked = loadUnlockedFolderIds();
      if (folderIds.some((id) => !unlocked.has(id))) return false;
      try {
        await authorizeRemote(note.id);
        const current = loadUnlockedFolderIds();
        return folderIds.every((id) => current.has(id));
      } catch {
        // 列表不显示无法确认访问权的正文预览；普通笔记仍可离线使用。
        return false;
      }
    }));
    return notes.filter((_note, index) => visible[index]);
  };

  return {
    assertReadable,
    filterReadable,
    dispose: () => window.removeEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, onSessionChanged),
  };
}

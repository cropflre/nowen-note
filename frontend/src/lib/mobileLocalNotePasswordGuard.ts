import { getCurrentWorkspace } from "./api";
import { knowledgeTreeApi, type KnowledgeTreeResponse } from "./knowledgeTreeApi";
import type { NativeDatabase } from "./nativeDatabase";
import { unsentLocalNoteKey } from "./nativeLocalNoteOrigin";
import {
  KNOWLEDGE_TREE_PASSWORD_NOTES_LOCKED_EVENT,
  KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT,
  loadUnlockedFolderIds,
  createNoteFolderPasswordResolver,
} from "./knowledgeTreePassword";

type LocalNote = { id: string; notebookId: string; workspaceId?: string | null };

/** Native 同步库没有 notebook_passwords，读取必须依据服务端树或其离线快照。 */
export function createMobileLocalNotePasswordGuard(authorizeRemote: (id: string) => Promise<unknown>, db: NativeDatabase) {
  const protectedReads = new Map<string, string[]>();
  let sessionRevision = 0;
  const onSessionChanged = () => {
    sessionRevision++;
    const unlocked = loadUnlockedFolderIds();
    const noteIds = [...protectedReads]
      .filter(([, folderIds]) => folderIds.some((id) => !unlocked.has(id)))
      .map(([noteId]) => noteId);
    if (noteIds.length) window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_PASSWORD_NOTES_LOCKED_EVENT, {
      detail: { noteIds },
    }));
  };
  window.addEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, onSessionChanged);
  const readTree = (workspaceId: string) => knowledgeTreeApi.listForWorkspace(workspaceId, true);
  const resolveNoteFolders = async (note: LocalNote, resolve: ReturnType<typeof createNoteFolderPasswordResolver>) => {
    const folderIds = resolve(note);
    if (folderIds !== null) return folderIds;
    const scopeKey = note.workspaceId ? `workspace:${note.workspaceId}` : "personal";
    const marker = (await db.query<{ value: string }>("SELECT value FROM native_runtime_meta WHERE key=?", [unsentLocalNoteKey(scopeKey, note.id)]))[0];
    return marker?.value === "1" ? resolve(note, true) : null;
  };
  const treeAccess = (tree: KnowledgeTreeResponse) => {
    const resolveFolders = createNoteFolderPasswordResolver(tree.nodes);
    const liveNotes = new Map(tree.nodes.filter((node) => node.resourceType === "note")
      .map((node) => [node.resourceId, node]));
    // 字段缺失表示旧服务端/离线快照；字段非法则拒绝本次在线授权。
    const proof = tree.passwordAuthorizedNotes;
    const verified = "passwordAuthorizedNotes" in tree
      ? new Map(Array.isArray(proof) && proof.every((item) => item && typeof item.noteId === "string"
        && Array.isArray(item.folderIds) && item.folderIds.every((id) => typeof id === "string"))
        ? proof.filter((item) => {
          const node = liveNotes.get(item.noteId);
          return node?.isDeleted === 0 && node.access?.capabilities.canView === true;
        }).map((item) => [item.noteId, item.folderIds]) : [])
      : null;
    return {
      verified,
      folders: (note: LocalNote) => {
        const node = liveNotes.get(note.id);
        // 在线授权携带真实保护链，不能依赖导航树提升共享节点后的父链。
        if (verified && node) return Promise.resolve(resolveFolders(note) === null ? null : verified.get(note.id) ?? null);
        return resolveNoteFolders(note, resolveFolders);
      },
    };
  };

  const lockedError = () => Object.assign(new Error("请先在目录中解锁笔记所在的密码文件夹"), {
    status: 403, code: "FOLDER_UNLOCK_REQUIRED",
  });

  const assertReadable = async (note: LocalNote): Promise<void> => {
    const revision = sessionRevision;
    const tree = await readTree(note.workspaceId || "personal");
    const folderIds = await treeAccess(tree).folders(note);
    if (!folderIds) throw new Error("目录密码状态无法确认，请联网刷新目录后重试");
    if (!folderIds.length) { protectedReads.delete(note.id); return; }
    protectedReads.set(note.id, folderIds);
    const unlocked = loadUnlockedFolderIds();
    if (revision !== sessionRevision || folderIds.some((id) => !unlocked.has(id))) throw lockedError();
    // 密码版本/绑定改变后旧令牌必须由服务器拒绝。
    await authorizeRemote(note.id);
    const current = loadUnlockedFolderIds();
    if (revision !== sessionRevision || folderIds.some((id) => !current.has(id))) throw lockedError();
  };

  const filterReadable = async <T extends LocalNote>(notes: T[], workspaceId = getCurrentWorkspace()): Promise<T[]> => {
    if (!notes.length) return notes;
    const revision = sessionRevision;
    const tree = await readTree(workspaceId);
    const access = treeAccess(tree);
    const requiredFolders = new Map<string, string[]>();
    const check = async (note: T) => {
      const folderIds = await access.folders(note);
      if (!folderIds) return false;
      if (!folderIds.length) { protectedReads.delete(note.id); return true; }
      protectedReads.set(note.id, folderIds);
      requiredFolders.set(note.id, folderIds);
      const unlocked = loadUnlockedFolderIds();
      if (revision !== sessionRevision || folderIds.some((id) => !unlocked.has(id))) return false;
      if (access.verified) return access.verified.has(note.id);
      try {
        await authorizeRemote(note.id);
        const current = loadUnlockedFolderIds();
        return revision === sessionRevision && folderIds.every((id) => current.has(id));
      } catch {
        // 列表不显示无法确认访问权的正文预览；普通笔记仍可离线使用。
        return false;
      }
    };
    const visible = new Array<boolean>(notes.length);
    let nextIndex = 0;
    // 兼容旧服务端，避免 Promise.all 对大量笔记同时发起授权请求。
    await Promise.all(Array.from({ length: Math.min(4, notes.length) }, async () => {
      while (nextIndex < notes.length) {
        const index = nextIndex++;
        visible[index] = await check(notes[index]);
      }
    }));
    const current = loadUnlockedFolderIds();
    return notes.filter((note, index) => {
      const folderIds = requiredFolders.get(note.id);
      return visible[index] && (!folderIds
        || (revision === sessionRevision && folderIds.every((id) => current.has(id))));
    });
  };

  return {
    assertReadable,
    filterReadable,
    dispose: () => window.removeEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, onSessionChanged),
  };
}

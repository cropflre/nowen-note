import { api } from "./api";
import { newLocalId } from "./localRepository";
import type { NativeLocalRepository } from "./nativeLocalRepository";
import type { Note, Notebook, Tag, Workspace } from "@/types";
import { getMobileLocalUser, isMobileLocalMode } from "./mobileLocalMode";
import { installMobileLocalKnowledgeTreeBridge } from "./mobileLocalKnowledgeTreeBridge";
import { installMobileLocalModuleBridge } from "./mobileLocalModuleBridge";
import { installMobileLocalAdvancedTaskBridge } from "./mobileLocalAdvancedTaskBridge";
import { installMobileLocalAttachmentFolderBridge } from "./mobileLocalAttachmentFolderBridge";
import { installMobileLocalNoteRelationsBridge } from "./mobileLocalNoteRelationsBridge";
import type { NativeDatabase } from "./nativeDatabase";

let installed = false;

/**
 * 将 Android Native 的核心业务门面切到 Native Repository。
 *
 * 注意：该 Bridge 在“设备本地模式”和“已登录服务器的 Local-first 模式”都会安装。
 * 只有纯设备本地模式才能覆盖 getMe / 版本 / 站点设置等服务端只读信息；登录模式
 * 必须保留真实账号与真实服务器信息。
 */
export function installMobileLocalFirstBridge(
  repository: NativeLocalRepository,
  db: NativeDatabase,
  userId: string,
): () => void {
  if (installed) return () => undefined;
  installed = true;

  const target = api as any;
  // 必须在任何子 Bridge 安装前保存服务器原始门面。历史实现先装 ModuleBridge 再快照，
  // teardown 时会把 ModuleBridge 的本地 attachment 函数误当成“原始函数”重新装回去，
  // 导致退出 Native Runtime 后仍残留本地实现。
  const originals = {
    getMe: target.getMe,
    getVersion: target.getVersion,
    getLatestRelease: target.getLatestRelease,
    getSiteSettings: target.getSiteSettings,
    getFonts: target.getFonts,
    getFontsPublic: target.getFontsPublic,
    getWorkspaces: target.getWorkspaces,
    getNotebooks: target.getNotebooks,
    createNotebook: target.createNotebook,
    updateNotebook: target.updateNotebook,
    deleteNotebook: target.deleteNotebook,
    reorderNotebooks: target.reorderNotebooks,
    moveNotebook: target.moveNotebook,
    getNotes: target.getNotes,
    getNote: target.getNote,
    getNoteSlim: target.getNoteSlim,
    createNote: target.createNote,
    createNoteConfirmed: target.createNoteConfirmed,
    updateNote: target.updateNote,
    updateNoteConfirmed: target.updateNoteConfirmed,
    deleteNote: target.deleteNote,
    duplicateNote: target.duplicateNote,
    reorderNotes: target.reorderNotes,
    getTrashSummary: target.getTrashSummary,
    emptyTrash: target.emptyTrash,
    getTags: target.getTags,
    createTag: target.createTag,
    updateTag: target.updateTag,
    deleteTag: target.deleteTag,
    addTagToNote: target.addTagToNote,
    removeTagFromNote: target.removeTagFromNote,
    getNotesWithTag: target.getNotesWithTag,
    getNotesWithTags: target.getNotesWithTags,
    search: target.search,
    searchNotes: target.searchNotes,
    attachmentUpload: target.attachments.upload,
    attachmentUrlFor: target.attachments.urlFor,
    attachmentRemove: target.attachments.remove,
  };

  const deviceOnlyMode = isMobileLocalMode();
  const restoreKnowledgeTreeBridge = installMobileLocalKnowledgeTreeBridge(repository, { deviceOnly: deviceOnlyMode });
  const restoreModuleBridge = installMobileLocalModuleBridge(repository, db, userId);
  // ModuleBridge 为历史兼容会给项目/模板/依赖/习惯返回空数据。
  // 纯设备模式再由持久化 Bridge 覆盖这些空实现；登录模式保留服务端高级任务能力，
  // 直到这些实体完整进入 Mobile Sync V2 的同步注册表。
  const restoreAdvancedTaskBridge = deviceOnlyMode
    ? installMobileLocalAdvancedTaskBridge(db, userId)
    : () => undefined;
  // 附件文件夹目前不是 Sync V2 实体；只在纯设备模式使用本地增量 schema，
  // 避免登录态产生“本地 folderId 成功、远端没有对应文件夹”的数据分叉。
  const restoreAttachmentFolderBridge = deviceOnlyMode
    ? installMobileLocalAttachmentFolderBridge(db, userId)
    : () => undefined;
  // 块索引 / 反链 / 关系图都是 notes.content 的派生数据。纯设备模式直接从本地权威
  // 内容计算，彻底阻断编辑器侧栏对 /blocks、/backlinks、Yjs release-room 的请求。
  const restoreNoteRelationsBridge = deviceOnlyMode
    ? installMobileLocalNoteRelationsBridge(db)
    : () => undefined;

  if (deviceOnlyMode) {
    target.getMe = async () => getMobileLocalUser();
    target.getVersion = async () => ({
      appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0",
      frontendBuildId: undefined,
      minClientVersion: undefined,
    });
    target.getLatestRelease = async () => ({ available: false, reason: "mobile_local_mode" });
    target.getSiteSettings = async () => ({ web_ui_enabled: "false" });
    // 打开设置页不再为了字体列表触发服务器请求。设备本地模式只支持内置字体，
    // SiteSettingsProvider 会把自定义字体 id 自动降级为默认字体。
    target.getFonts = async () => [];
    target.getFontsPublic = async () => [];
  }

  target.getWorkspaces = async (): Promise<Workspace[]> => repository.listWorkspaces();

  target.getNotebooks = async (workspaceId?: string): Promise<Notebook[]> =>
    repository.listNotebooksForWorkspace(workspaceId);
  target.createNotebook = async (data: Partial<Notebook>): Promise<Notebook> => {
    const id = data.id || newLocalId();
    await repository.notebooks.create({ ...data, id });
    return (await repository.notebooks.get(id))!;
  };
  target.updateNotebook = async (id: string, data: Partial<Notebook>): Promise<Notebook> => {
    await repository.notebooks.update(id, data);
    return (await repository.notebooks.get(id))!;
  };
  target.deleteNotebook = async (id: string) => {
    await repository.notebooks.remove(id);
    return { success: true };
  };
  target.reorderNotebooks = async (items: Array<{ id: string; sortOrder: number }>) => {
    await repository.reorderNotebooks(items);
    return { success: true };
  };
  target.moveNotebook = async (id: string, data: { parentId?: string | null; sortOrder?: number }) => {
    await repository.notebooks.update(id, data);
    return (await repository.notebooks.get(id))!;
  };

  target.getNotes = async (params: Record<string, string> = {}) => repository.listNotesForWorkspace(params.workspaceId, {
    notebookId: params.notebookId,
    tagId: params.tagId,
    keyword: params.q || params.keyword,
    favoriteOnly: params.isFavorite === "1" || params.isFavorite === "true",
    trashedOnly: params.isTrashed === "1" || params.isTrashed === "true",
    includeTrashed: params.includeTrashed === "true" || params.isTrashed === "true",
    includeArchived: params.includeArchived === "true",
    limit: params.limit ? Number(params.limit) : undefined,
    offset: params.offset ? Number(params.offset) : undefined,
  });
  target.getNote = async (id: string): Promise<Note> => {
    const note = await repository.notes.get(id);
    if (!note) throw new Error("笔记不存在");
    return note;
  };
  target.getNoteSlim = target.getNote;
  target.createNote = async (data: Partial<Note>): Promise<Note> => {
    const id = data.id || newLocalId();
    await repository.notes.create({ ...data, id });
    return (await repository.notes.get(id))!;
  };
  target.updateNote = async (id: string, data: Partial<Note>): Promise<Note> => {
    await repository.notes.update(id, data);
    return (await repository.notes.get(id))!;
  };
  target.deleteNote = async (id: string) => {
    await repository.notes.remove(id);
    return { success: true };
  };
  target.createNoteConfirmed = target.createNote;
  target.updateNoteConfirmed = target.updateNote;
  target.duplicateNote = async (id: string) => repository.duplicateNote(id);
  target.reorderNotes = async (items: Array<{ id: string; sortOrder: number }>) => {
    await repository.reorderNotes(items);
    return { success: true };
  };
  target.getTrashSummary = async () => repository.trashSummary();
  target.emptyTrash = async () => repository.emptyTrash();

  target.getTags = async (workspaceId?: string): Promise<Tag[]> => repository.listTagsForWorkspace(workspaceId);
  target.createTag = async (data: Partial<Tag>): Promise<Tag> => {
    const id = data.id || newLocalId();
    await repository.tags.create({ ...data, id });
    return (await repository.tags.list()).find((tag) => tag.id === id)!;
  };
  target.updateTag = async (id: string, data: Partial<Tag>): Promise<Tag> => {
    await repository.tags.update(id, data);
    return (await repository.tags.list()).find((tag) => tag.id === id)!;
  };
  target.deleteTag = async (id: string) => {
    await repository.tags.remove(id);
    return { success: true };
  };
  target.addTagToNote = async (noteId: string, tagId: string) => {
    await repository.tags.attach(noteId, tagId);
    return { success: true };
  };
  target.removeTagFromNote = async (noteId: string, tagId: string) => {
    await repository.tags.detach(noteId, tagId);
    return { success: true };
  };
  target.getNotesWithTag = async (tagId: string, params: Record<string, string> = {}) =>
    repository.listNotesForWorkspace(params.workspaceId, { tagId, limit: params.limit ? Number(params.limit) : undefined });
  target.getNotesWithTags = async (tagIds: string[], params: Record<string, string> = {}) =>
    repository.listNotesWithTags(tagIds, params.workspaceId, params.limit ? Number(params.limit) : undefined);
  target.search = async (query: string) => repository.searchNotes(query);
  target.searchNotes = async (query: string, limit = 10) => (await repository.searchNotes(query, limit))
    .map(({ id, title, notebookId, updatedAt }) => ({ id, title, notebookId, updatedAt }));

  target.attachments.upload = async (noteId: string, file: File) => {
    const id = newLocalId();
    const record = await repository.attachments.save({
      id,
      noteId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      blob: file,
    });
    const url = await repository.attachments.resolveUrl(id);
    return {
      ...record,
      url: url || (isMobileLocalMode() ? "about:blank" : `/api/attachments/${id}`),
      category: record.mimeType.startsWith("image/") ? "image" : "file",
    };
  };
  target.attachments.urlFor = (id: string) =>
    repository.getCachedAttachmentUrl(id) || (isMobileLocalMode() ? "about:blank" : originals.attachmentUrlFor(id));
  target.attachments.remove = async (id: string) => {
    await repository.attachments.remove(id);
    return { success: true };
  };

  return () => {
    // 子 Bridge 按安装的逆序恢复，避免 wrapper 恢复到另一个 wrapper 上。
    restoreNoteRelationsBridge();
    restoreAttachmentFolderBridge();
    restoreAdvancedTaskBridge();
    restoreModuleBridge();
    restoreKnowledgeTreeBridge();
    Object.assign(target, {
      getMe: originals.getMe,
      getVersion: originals.getVersion,
      getLatestRelease: originals.getLatestRelease,
      getSiteSettings: originals.getSiteSettings,
      getFonts: originals.getFonts,
      getFontsPublic: originals.getFontsPublic,
      getWorkspaces: originals.getWorkspaces,
      getNotebooks: originals.getNotebooks,
      createNotebook: originals.createNotebook,
      updateNotebook: originals.updateNotebook,
      deleteNotebook: originals.deleteNotebook,
      reorderNotebooks: originals.reorderNotebooks,
      moveNotebook: originals.moveNotebook,
      getNotes: originals.getNotes,
      getNote: originals.getNote,
      getNoteSlim: originals.getNoteSlim,
      createNote: originals.createNote,
      createNoteConfirmed: originals.createNoteConfirmed,
      updateNote: originals.updateNote,
      updateNoteConfirmed: originals.updateNoteConfirmed,
      deleteNote: originals.deleteNote,
      duplicateNote: originals.duplicateNote,
      reorderNotes: originals.reorderNotes,
      getTrashSummary: originals.getTrashSummary,
      emptyTrash: originals.emptyTrash,
      getTags: originals.getTags,
      createTag: originals.createTag,
      updateTag: originals.updateTag,
      deleteTag: originals.deleteTag,
      addTagToNote: originals.addTagToNote,
      removeTagFromNote: originals.removeTagFromNote,
      getNotesWithTag: originals.getNotesWithTag,
      getNotesWithTags: originals.getNotesWithTags,
      search: originals.search,
      searchNotes: originals.searchNotes,
    });
    target.attachments.upload = originals.attachmentUpload;
    target.attachments.urlFor = originals.attachmentUrlFor;
    target.attachments.remove = originals.attachmentRemove;
    installed = false;
  };
}

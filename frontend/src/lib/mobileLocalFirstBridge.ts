import { api } from "./api";
import { newLocalId } from "./localRepository";
import type { NativeLocalRepository } from "./nativeLocalRepository";
import type { Note, Notebook, Tag, Workspace } from "@/types";
import { getMobileLocalUser, isMobileLocalMode } from "./mobileLocalMode";
import { installMobileLocalKnowledgeTreeBridge } from "./mobileLocalKnowledgeTreeBridge";
import { installMobileLocalModuleBridge } from "./mobileLocalModuleBridge";
import type { NativeDatabase } from "./nativeDatabase";

let installed = false;

/**
 * 将 Android 设备本地模式的业务门面切到 Native Repository。
 *
 * 除笔记核心 CRUD 外，同时接管启动期/设置期常见的只读服务 API，避免组件为了
 * 获取“当前用户 / 站点开关 / 版本”又落回 Server-first 请求链路。
 */
export function installMobileLocalFirstBridge(
  repository: NativeLocalRepository,
  db: NativeDatabase,
  userId: string,
): () => void {
  if (installed) return () => undefined;
  installed = true;
  const restoreKnowledgeTreeBridge = installMobileLocalKnowledgeTreeBridge(repository);
  const restoreModuleBridge = installMobileLocalModuleBridge(repository, db, userId);
  const target = api as any;
  const originals = {
    getMe: target.getMe,
    getVersion: target.getVersion,
    getLatestRelease: target.getLatestRelease,
    getSiteSettings: target.getSiteSettings,
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

  target.getMe = async () => getMobileLocalUser();
  target.getVersion = async () => ({
    appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0",
    frontendBuildId: undefined,
    minClientVersion: undefined,
  });
  target.getLatestRelease = async () => ({ available: false, reason: "mobile_local_mode" });
  target.getSiteSettings = async () => ({ web_ui_enabled: "false" });

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
    restoreModuleBridge();
    restoreKnowledgeTreeBridge();
    Object.assign(target, {
      getMe: originals.getMe,
      getVersion: originals.getVersion,
      getLatestRelease: originals.getLatestRelease,
      getSiteSettings: originals.getSiteSettings,
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

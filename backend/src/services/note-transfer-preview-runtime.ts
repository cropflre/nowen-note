import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import {
  createNoteTransferPreviewRepository,
  type NoteTransferPermission,
  type NoteTransferPreviewAttachmentRow,
  type NoteTransferPreviewNoteRow,
} from "../repositories/noteTransferPreviewRepository";
import { checkAttachmentObjectExists } from "./attachment-storage";

export type NoteTransferRuntimeMode = "copy" | "move";

export interface NoteTransferPreviewRuntimeRequest {
  actorUserId: string;
  sourceNoteIds: string[];
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  mode: NoteTransferRuntimeMode;
  includeAttachments?: boolean;
  includeTags?: boolean;
  expectedVersions?: Record<string, number>;
}

export interface NoteTransferPreviewRuntimeResult {
  canExecute: boolean;
  mode: NoteTransferRuntimeMode;
  sourceWorkspaceId: string | null;
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  noteCount: number;
  attachmentCount: number;
  attachmentBytes: number;
  missingAttachmentCount: number;
  tagCount: number;
  internalNoteLinkCount: number;
  externalNoteLinkCount: number;
  sourceVersions: Record<string, number>;
  blockers: Array<{ code: string; message: string; noteId?: string }>;
  warnings: string[];
  omitted: string[];
  notes: Array<{
    id: string;
    title: string;
    version: number;
    isLocked: boolean;
    attachmentCount: number;
  }>;
}

const OMITTED_FEATURES = [
  "分享链接与公开发布配置",
  "评论与协作会话",
  "版本历史与恢复记录",
  "任务、提醒及其它业务资源",
  "笔记级 ACL 与成员权限覆写",
];

const UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const NOTE_REFERENCE_RE = new RegExp(
  `(?:note:\\/\\/|note:|\\/api\\/notes\\/|\\/notes\\/)(${UUID_RE})`,
  "gi",
);

const PERMISSION_LEVEL: Record<Exclude<NoteTransferPermission, null>, number> = {
  read: 1,
  comment: 2,
  write: 3,
  manage: 4,
};

const ROLE_LEVEL: Record<string, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  admin: 4,
  owner: 5,
};

export class NoteTransferPreviewRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 404 | 409 | 503 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NoteTransferPreviewRuntimeError";
  }
}

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function normalizeIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => String(id || "").trim()).filter(Boolean)));
}

function toBoolean(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

function toNumber(value: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function hasPermission(actual: NoteTransferPermission, required: Exclude<NoteTransferPermission, null>): boolean {
  return Boolean(actual && PERMISSION_LEVEL[actual] >= PERMISSION_LEVEL[required]);
}

function hasRole(actual: string | null, required: string): boolean {
  return Boolean(actual && (ROLE_LEVEL[actual] || 0) >= (ROLE_LEVEL[required] || Number.MAX_SAFE_INTEGER));
}

function addBlocker(
  blockers: NoteTransferPreviewRuntimeResult["blockers"],
  code: string,
  message: string,
  noteId?: string,
): void {
  blockers.push({ code, message, ...(noteId ? { noteId } : {}) });
}

function validateDirection(sourceWorkspaceId: string | null, targetWorkspaceId: string | null): void {
  if (sourceWorkspaceId === targetWorkspaceId) {
    throw new NoteTransferPreviewRuntimeError(
      "SAME_WORKSPACE_TRANSFER_FORBIDDEN",
      "跨空间转移仅用于个人空间与团队空间之间；同一空间请使用普通移动功能",
    );
  }
  if (sourceWorkspaceId !== null && targetWorkspaceId !== null) {
    throw new NoteTransferPreviewRuntimeError(
      "TEAM_TO_TEAM_TRANSFER_UNSUPPORTED",
      "当前仅支持个人空间与团队空间之间复制或移动",
    );
  }
}

function countLinks(content: string, selectedNoteIds: Set<string>): {
  internal: number;
  external: number;
} {
  let internal = 0;
  let external = 0;
  const matcher = new RegExp(NOTE_REFERENCE_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(content || "")) !== null) {
    if (selectedNoteIds.has(match[1].toLowerCase())) internal += 1;
    else external += 1;
  }
  return { internal, external };
}

function attachmentCounts(rows: NoteTransferPreviewAttachmentRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.noteId, (counts.get(row.noteId) || 0) + 1);
  return counts;
}

function sourceWorkspaceIdOf(notes: NoteTransferPreviewNoteRow[]): string | null {
  const values = new Set(notes.map((note) => note.workspaceId || null));
  if (values.size !== 1) {
    throw new NoteTransferPreviewRuntimeError(
      "MIXED_SOURCE_WORKSPACES",
      "批量转移的笔记必须来自同一个空间",
    );
  }
  return notes[0]?.workspaceId || null;
}

export function createNoteTransferPreviewRuntime(adapter?: DatabaseAdapter) {
  const repository = createNoteTransferPreviewRepository(resolveAdapter(adapter));

  return {
    async preview(input: NoteTransferPreviewRuntimeRequest): Promise<NoteTransferPreviewRuntimeResult> {
      const noteIds = normalizeIds(input.sourceNoteIds);
      if (!input.actorUserId) {
        throw new NoteTransferPreviewRuntimeError("UNAUTHENTICATED", "未登录", 401);
      }
      if (noteIds.length === 0) {
        throw new NoteTransferPreviewRuntimeError("SOURCE_NOTES_REQUIRED", "请至少选择一篇笔记");
      }
      if (noteIds.length > 100) {
        throw new NoteTransferPreviewRuntimeError(
          "TRANSFER_BATCH_TOO_LARGE",
          "单次最多转移 100 篇笔记",
        );
      }
      if (!input.targetNotebookId) {
        throw new NoteTransferPreviewRuntimeError(
          "TARGET_NOTEBOOK_REQUIRED",
          "请选择目标笔记本",
        );
      }
      if (input.mode !== "copy" && input.mode !== "move") {
        throw new NoteTransferPreviewRuntimeError(
          "INVALID_TRANSFER_MODE",
          "mode 必须是 copy 或 move",
        );
      }
      if (input.mode === "move" && input.includeAttachments === false) {
        throw new NoteTransferPreviewRuntimeError(
          "MOVE_REQUIRES_ATTACHMENTS",
          "安全移动必须复制附件；如需保留源附件，请改用复制模式",
        );
      }

      const notes = await repository.loadNotes({ noteIds, actorUserId: input.actorUserId });
      if (notes.length !== noteIds.length) {
        const found = new Set(notes.map((note) => note.id));
        throw new NoteTransferPreviewRuntimeError(
          "SOURCE_NOTE_NOT_FOUND",
          "部分源笔记不存在",
          404,
          { missing: noteIds.filter((id) => !found.has(id)) },
        );
      }
      const byId = new Map(notes.map((note) => [note.id, note]));
      const orderedNotes = noteIds.map((id) => byId.get(id)!);
      const sourceWorkspaceId = sourceWorkspaceIdOf(orderedNotes);
      const targetWorkspaceId = input.targetWorkspaceId || null;
      validateDirection(sourceWorkspaceId, targetWorkspaceId);

      const targetNotebook = await repository.loadTargetNotebook({
        notebookId: input.targetNotebookId,
        actorUserId: input.actorUserId,
      });
      if (!targetNotebook || toBoolean(targetNotebook.isDeleted)) {
        throw new NoteTransferPreviewRuntimeError(
          "TARGET_NOTEBOOK_NOT_FOUND",
          "目标笔记本不存在或已删除",
          404,
        );
      }
      if ((targetNotebook.workspaceId || null) !== targetWorkspaceId) {
        throw new NoteTransferPreviewRuntimeError(
          "TARGET_NOTEBOOK_WORKSPACE_MISMATCH",
          "目标笔记本不属于所选目标空间",
        );
      }

      const blockers: NoteTransferPreviewRuntimeResult["blockers"] = [];
      const warnings: string[] = [];

      if (targetWorkspaceId === null) {
        if (targetNotebook.userId !== input.actorUserId) {
          addBlocker(blockers, "TARGET_PERSONAL_FORBIDDEN", "只能转入自己的个人空间");
        }
      } else {
        if (!hasRole(targetNotebook.effectiveWorkspaceRole, "editor")) {
          addBlocker(blockers, "TARGET_WORKSPACE_FORBIDDEN", "目标团队空间需要编辑者或更高权限");
        }
        if (!hasPermission(targetNotebook.effectiveNotebookPermission, "write")) {
          addBlocker(blockers, "TARGET_NOTEBOOK_FORBIDDEN", "无权写入目标笔记本");
        }
      }

      for (const note of orderedNotes) {
        if (toBoolean(note.isTrashed)) {
          addBlocker(blockers, "SOURCE_NOTE_TRASHED", "回收站中的笔记不能跨空间转移", note.id);
          continue;
        }
        if (!hasPermission(note.effectivePermission, "manage")) {
          addBlocker(blockers, "SOURCE_NOTE_FORBIDDEN", "需要源笔记的管理权限", note.id);
        }
        if (sourceWorkspaceId === null && note.userId !== input.actorUserId) {
          addBlocker(blockers, "SOURCE_PERSONAL_FORBIDDEN", "只能转移自己个人空间中的笔记", note.id);
        }
        if (input.mode === "move" && toBoolean(note.isLocked)) {
          addBlocker(blockers, "SOURCE_NOTE_LOCKED", "锁定笔记不能移动，请先解锁", note.id);
        }
        const expectedVersion = input.expectedVersions?.[note.id];
        if (typeof expectedVersion === "number" && expectedVersion !== toNumber(note.version)) {
          addBlocker(blockers, "SOURCE_VERSION_CONFLICT", "源笔记已更新，请重新预检", note.id);
        }
      }

      if (
        sourceWorkspaceId !== null
        && !orderedNotes.some((note) => hasRole(note.workspaceRole, "admin"))
        && !orderedNotes.every((note) => hasPermission(note.effectivePermission, "manage"))
      ) {
        addBlocker(
          blockers,
          "SOURCE_TEAM_MANAGE_REQUIRED",
          "团队空间转出需要空间所有者/管理员或源目录管理权限",
        );
      }

      const attachments = await repository.loadAttachments(noteIds);
      const tags = input.includeTags === false ? [] : await repository.loadTags(noteIds);
      const counts = attachmentCounts(attachments);
      const selectedIds = new Set(noteIds.map((id) => id.toLowerCase()));
      let internalNoteLinkCount = 0;
      let externalNoteLinkCount = 0;
      for (const note of orderedNotes) {
        const links = countLinks(note.content || "", selectedIds);
        internalNoteLinkCount += links.internal;
        externalNoteLinkCount += links.external;
      }
      if (externalNoteLinkCount > 0) {
        warnings.push(`检测到 ${externalNoteLinkCount} 个指向本批次外笔记的链接，目标中将保留原链接`);
      }
      if (input.includeAttachments === false && attachments.length > 0) {
        warnings.push(`未选择复制附件，${attachments.length} 个附件引用可能在目标空间不可用`);
      }
      warnings.push("分享、评论、历史版本、ACL、任务和提醒不会随笔记转移");

      let missingAttachmentCount = 0;
      if (input.includeAttachments !== false && attachments.length > 0) {
        const checks = await Promise.all(
          attachments.map(async (attachment) => ({
            attachment,
            exists: (await checkAttachmentObjectExists(attachment.path)).exists,
          })),
        );
        missingAttachmentCount = checks.filter((check) => !check.exists).length;
        if (missingAttachmentCount > 0) {
          if (input.mode === "move") {
            addBlocker(
              blockers,
              "ATTACHMENT_FILE_MISSING",
              `有 ${missingAttachmentCount} 个附件文件缺失或不可读取；为避免数据丢失，移动已阻止`,
            );
          } else {
            warnings.unshift(
              `有 ${missingAttachmentCount} 个附件文件缺失或不可读取，复制时将跳过并在结果中报告`,
            );
          }
        }
      }

      return {
        canExecute: blockers.length === 0,
        mode: input.mode,
        sourceWorkspaceId,
        targetWorkspaceId,
        targetNotebookId: targetNotebook.id,
        noteCount: orderedNotes.length,
        attachmentCount: input.includeAttachments === false ? 0 : attachments.length,
        attachmentBytes: input.includeAttachments === false
          ? 0
          : attachments.reduce((sum, row) => sum + Math.max(0, toNumber(row.size)), 0),
        missingAttachmentCount,
        tagCount: tags.length,
        internalNoteLinkCount,
        externalNoteLinkCount,
        sourceVersions: Object.fromEntries(
          orderedNotes.map((note) => [note.id, toNumber(note.version)]),
        ),
        blockers,
        warnings,
        omitted: OMITTED_FEATURES,
        notes: orderedNotes.map((note) => ({
          id: note.id,
          title: note.title,
          version: toNumber(note.version),
          isLocked: toBoolean(note.isLocked),
          attachmentCount: counts.get(note.id) || 0,
        })),
      };
    },
  };
}

export const noteTransferPreviewRuntime = createNoteTransferPreviewRuntime();

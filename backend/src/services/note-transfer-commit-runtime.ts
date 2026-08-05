import type { DatabaseAdapter } from "../db/adapters/types";
import { buildNoteBlockIndexPlan } from "../lib/noteBlocksRuntime";
import { extractNoteLinksFromContent } from "../lib/noteContentReferences";
import {
  createNoteTransferCommitRepository,
  deterministicTransferUuid,
  type NoteTransferCommitResponse,
  type NoteTransferCommitTargetNote,
  type NoteTransferCommitTargetTag,
} from "../repositories/noteTransferCommitRepository";
import {
  createNoteTransferOperationRepository,
  NoteTransferOperationError,
  type PreparedNoteTransferOperation,
} from "../repositories/noteTransferOperationRepository";

const UUID_RE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ATTACHMENT_URL_RE = new RegExp(
  `\\/api\\/attachments\\/(${UUID_RE})(\\?[^"'\\s)<>\\]]*)?`,
  "gi",
);
const NOTE_SCHEME_RE = new RegExp(`note:\\/\\/(${UUID_RE})`, "gi");
const NOTE_URI_RE = new RegExp(`note:(${UUID_RE})`, "gi");
const NOTE_PATH_RE = new RegExp(
  `\\/notes\\/(${UUID_RE})(\\?[^"'\\s)<>\\]]*)?`,
  "gi",
);
const NOTE_API_RE = new RegExp(
  `\\/api\\/notes\\/(${UUID_RE})(\\?[^"'\\s)<>\\]]*)?`,
  "gi",
);

type CommitRepository = ReturnType<typeof createNoteTransferCommitRepository>;
type OperationRepository = ReturnType<typeof createNoteTransferOperationRepository>;
type BlockPlan = NonNullable<ReturnType<typeof buildNoteBlockIndexPlan>>;

function rewriteAttachmentUrls(content: string, idMap: Map<string, string>): string {
  if (!content) return content;
  return content.replace(
    ATTACHMENT_URL_RE,
    (match, id: string, query: string = "") => {
      const next = idMap.get(id.toLowerCase());
      return next ? `/api/attachments/${next}${query}` : match;
    },
  );
}

function rewriteInternalNoteLinks(
  content: string,
  noteIdMap: Map<string, string>,
): { content: string; externalNoteLinkCount: number } {
  if (!content) return { content, externalNoteLinkCount: 0 };
  const external = new Set<string>();
  const targetIds = new Set(
    Array.from(noteIdMap.values(), (id) => id.toLowerCase()),
  );
  const rewrite = (prefix: string, id: string, suffix = "") => {
    const normalizedId = id.toLowerCase();
    const next = noteIdMap.get(normalizedId);
    if (next) return `${prefix}${next}${suffix}`;
    // A target ID may be encountered again by an overlapping regex after its
    // source ID was already rewritten. It is internal, not a preserved external link.
    if (targetIds.has(normalizedId)) return `${prefix}${id}${suffix}`;
    external.add(normalizedId);
    return `${prefix}${id}${suffix}`;
  };

  let output = content.replace(NOTE_SCHEME_RE, (_match, id: string) =>
    rewrite("note://", id),
  );
  output = output.replace(NOTE_URI_RE, (_match, id: string) =>
    rewrite("note:", id),
  );
  output = output.replace(
    NOTE_PATH_RE,
    (_match, id: string, query: string = "") => rewrite("/notes/", id, query),
  );
  output = output.replace(
    NOTE_API_RE,
    (_match, id: string, query: string = "") => rewrite("/api/notes/", id, query),
  );
  return { content: output, externalNoteLinkCount: external.size };
}

function ensureCommitReady(operation: PreparedNoteTransferOperation): void {
  if (operation.status !== "staging") {
    throw new NoteTransferOperationError(
      "NOTE_TRANSFER_STATE_CONFLICT",
      `当前状态 ${operation.status} 无法提交目标笔记`,
      409,
      { operationId: operation.id, status: operation.status },
    );
  }

  const staged = operation.stagedAttachments.filter((attachment) =>
    attachment.status === "staged"
    && attachment.verifiedSize === attachment.size
    && Boolean(attachment.verifiedHash),
  ).length;
  if (staged !== operation.plan.attachmentCount) {
    throw new NoteTransferOperationError(
      "NOTE_TRANSFER_ATTACHMENTS_NOT_STAGED",
      "所有附件完成物理 staging 后才能提交目标笔记",
      409,
      {
        operationId: operation.id,
        expected: operation.plan.attachmentCount,
        staged,
      },
    );
  }
}

function assertPreparedSourceSnapshot(
  operation: PreparedNoteTransferOperation,
  snapshot: Awaited<ReturnType<CommitRepository["loadSourceSnapshot"]>>,
): void {
  if (snapshot.notes.length !== operation.sourceNoteCount) {
    throw new NoteTransferOperationError(
      "NOTE_TRANSFER_COMMIT_STALE",
      "源笔记数量已变化，请重新预检",
      409,
      { operationId: operation.id },
    );
  }
  for (const note of snapshot.notes) {
    const expectedVersion = operation.sourceVersions[note.id];
    if (
      note.version !== expectedVersion
      || note.workspaceId !== operation.sourceWorkspaceId
    ) {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_COMMIT_STALE",
        "源笔记版本或空间已变化，请重新预检",
        409,
        {
          operationId: operation.id,
          sourceNoteId: note.id,
          expectedVersion,
          actualVersion: note.version,
          expectedWorkspaceId: operation.sourceWorkspaceId,
          actualWorkspaceId: note.workspaceId,
        },
      );
    }
  }
}

function dedupeLinks<T extends { targetNoteId: string }>(links: T[]): T[] {
  // The current note_links schema has a unique source/target note index even for
  // block links. Mirror the persisted constraint so result.noteLinkCount remains
  // equal to the number of rows actually committed.
  const seen = new Set<string>();
  const output: T[] = [];
  for (const link of links) {
    if (seen.has(link.targetNoteId)) continue;
    seen.add(link.targetNoteId);
    output.push(link);
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceMaterializesBlockId(content: string, blockId: string): boolean {
  const escaped = escapeRegExp(blockId);
  return new RegExp(
    `(?:"blockId"\\s*:\\s*"${escaped}"|\\^${escaped}(?=\\s|$))`,
    "m",
  ).test(content);
}

function stabilizeGeneratedBlockIds(input: {
  operationId: string;
  sourceContent: string;
  targetNoteId: string;
  plan: BlockPlan;
}): BlockPlan {
  const replacements = new Map<string, string>();
  for (const row of input.plan.rows) {
    if (sourceMaterializesBlockId(input.sourceContent, row.blockId)) continue;
    replacements.set(
      row.blockId,
      `blk_${deterministicTransferUuid(
        `${input.operationId}:block:${input.targetNoteId}:${row.blockOrder}:${row.blockType}:${row.contentHash}`,
      )}`,
    );
  }
  if (replacements.size === 0) return input.plan;

  let content = input.plan.content;
  for (const [generated, stable] of replacements) {
    content = content.split(generated).join(stable);
  }
  return {
    ...input.plan,
    content,
    rows: input.plan.rows.map((row) => ({
      ...row,
      blockId: replacements.get(row.blockId) || row.blockId,
      parentBlockId: row.parentBlockId
        ? replacements.get(row.parentBlockId) || row.parentBlockId
        : null,
    })),
  };
}

export function createNoteTransferCommitRuntime(
  adapter?: DatabaseAdapter,
  options: {
    operations?: OperationRepository;
    commits?: CommitRepository;
  } = {},
) {
  const operations = options.operations || createNoteTransferOperationRepository(adapter);
  const commits = options.commits || createNoteTransferCommitRepository(adapter);

  return {
    async commit(input: {
      actorUserId: string;
      idempotencyKey: string;
    }): Promise<NoteTransferCommitResponse> {
      const operation = await operations.getPrepared(input);
      if (!operation) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_PLAN_NOT_FOUND",
          "转移计划不存在",
          404,
        );
      }

      if (
        operation.status === "completed"
        || (operation.mode === "move"
          && ["target_committed", "source_deleting"].includes(operation.status))
      ) {
        const result = await commits.loadCompleted(input);
        if (!result) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_RESULT_MISSING",
            "转移已完成但结果快照缺失",
            409,
            { operationId: operation.id },
          );
        }
        return { operation, result, reused: true };
      }

      ensureCommitReady(operation);
      const snapshot = await commits.loadSourceSnapshot(operation);
      assertPreparedSourceSnapshot(operation, snapshot);
      const noteIdMap = new Map(
        Object.entries(operation.plan.targetNoteIds).map(([source, target]) => [
          source.toLowerCase(),
          target,
        ]),
      );
      const attachmentIdMap = new Map(
        operation.stagedAttachments.map((attachment) => [
          attachment.sourceAttachmentId.toLowerCase(),
          attachment.targetAttachmentId,
        ]),
      );
      const warnings: string[] = [];
      let externalNoteLinkCount = 0;

      const targetNotes: NoteTransferCommitTargetNote[] = snapshot.notes.map((sourceNote) => {
        const targetNoteId = noteIdMap.get(sourceNote.id.toLowerCase());
        if (!targetNoteId) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_PLAN_STALE",
            "源笔记缺少目标 ID 映射",
            409,
            { sourceNoteId: sourceNote.id },
          );
        }

        let content = sourceNote.content;
        let contentText = sourceNote.contentText;
        if (operation.includeAttachments) {
          content = rewriteAttachmentUrls(content, attachmentIdMap);
          contentText = rewriteAttachmentUrls(contentText, attachmentIdMap);
        }
        const rewrittenContent = rewriteInternalNoteLinks(content, noteIdMap);
        const rewrittenText = rewriteInternalNoteLinks(contentText, noteIdMap);
        content = rewrittenContent.content;
        contentText = rewrittenText.content;
        externalNoteLinkCount += rewrittenContent.externalNoteLinkCount;

        const generatedPlan = buildNoteBlockIndexPlan(
          targetNoteId,
          content,
          sourceNote.contentFormat,
        );
        const blockPlan = generatedPlan
          ? stabilizeGeneratedBlockIds({
            operationId: operation.id,
            sourceContent: sourceNote.content,
            targetNoteId,
            plan: generatedPlan,
          })
          : null;
        if (blockPlan) {
          content = blockPlan.content;
          contentText = blockPlan.contentText;
          if (blockPlan.changed) warnings.push(`block_ids_materialized:${sourceNote.id}`);
        }

        const extracted = dedupeLinks(extractNoteLinksFromContent(content));
        const links = extracted.map((link, index) => ({
          ...link,
          id: deterministicTransferUuid(
            `${operation.id}:link:${targetNoteId}:${index}:${link.targetNoteId}:${link.targetBlockId || ""}`,
          ),
        }));

        return {
          sourceNoteId: sourceNote.id,
          targetNoteId,
          title: sourceNote.title,
          content,
          contentText,
          contentFormat: sourceNote.contentFormat,
          isPinned: sourceNote.isPinned,
          sortOrder: sourceNote.sortOrder,
          blocks: blockPlan?.rows || [],
          links,
        };
      });

      if (externalNoteLinkCount > 0) {
        warnings.push(`external_note_links_preserved:${externalNoteLinkCount}`);
      }

      const targetTags: NoteTransferCommitTargetTag[] = snapshot.tags.map((tag) => {
        const targetNoteId = noteIdMap.get(tag.sourceNoteId.toLowerCase());
        if (!targetNoteId) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_PLAN_STALE",
            "标签对应的目标笔记映射不存在",
            409,
            { sourceNoteId: tag.sourceNoteId, sourceTagId: tag.sourceTagId },
          );
        }
        const scope = operation.targetWorkspaceId || `personal:${input.actorUserId}`;
        return {
          ...tag,
          targetNoteId,
          targetTagId: deterministicTransferUuid(
            `${operation.id}:tag:${scope}:${tag.name.trim().toLowerCase()}`,
          ),
        };
      });

      const uniqueTagNames = new Set(targetTags.map((tag) => tag.name.trim().toLowerCase()));
      const noteLinkCount = targetNotes.reduce((sum, note) => sum + note.links.length, 0);
      const blockCount = targetNotes.reduce((sum, note) => sum + note.blocks.length, 0);
      const result = {
        operationId: operation.id,
        mode: operation.mode,
        sourceNoteCount: operation.sourceNoteCount,
        targetWorkspaceId: operation.targetWorkspaceId,
        targetNotebookId: operation.targetNotebookId,
        targetNoteIds: operation.plan.targetNoteIds,
        attachmentCount: operation.plan.attachmentCount,
        tagCount: uniqueTagNames.size,
        noteLinkCount,
        blockCount,
        warnings,
      };

      const committed = await commits.commitCopy({
        ...input,
        operation,
        sourceNotes: snapshot.notes,
        targetNotes,
        targetTags,
        result,
      });
      const completedOperation = await operations.getPrepared(input);
      const persisted = completedOperation && (
        operation.mode === "copy"
          ? completedOperation.status === "completed"
          : ["target_committed", "source_deleting", "completed"].includes(completedOperation.status)
      );
      if (!persisted) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_COMMIT_PERSIST_FAILED",
          "目标数据已提交但操作状态读取失败",
          409,
          { operationId: operation.id },
        );
      }
      return {
        operation: completedOperation,
        result: committed.result,
        reused: committed.reused,
      };
    },
  };
}

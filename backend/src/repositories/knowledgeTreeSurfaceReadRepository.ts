import type { DatabaseAdapter } from "../db/adapters/types";
import { convertSql, type DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import { KnowledgeTreeMutationError } from "./knowledgeTreeMutationRepository";
import {
  createKnowledgeTreeNodeAccessRepository,
} from "./knowledgeTreeNodeAccessRepository";
import type { KnowledgeTreeReadNode } from "./knowledgeTreeReadRepository";

const ROOT_DOCUMENT_NOTEBOOK_PREFIX = "__nowen_root_documents__:";
const ROOT_DOCUMENT_NODE_PREFIX = `notebook:${ROOT_DOCUMENT_NOTEBOOK_PREFIX}`;

type DatabaseScalar = boolean | number | string | Date | null;

export type SharedKnowledgeTreeReadNode = KnowledgeTreeReadNode & {
  sharedRootId: string;
  sharedDepth: number;
};

export type KnowledgeTreeHistoryRow = {
  id: string;
  nodeId: string;
  action: string;
  actorUserId: string;
  actorUsername: string | null;
  fromParentId: string | null;
  toParentId: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  metadata: unknown;
  createdAt: string;
};

type SharedCandidateRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  nodeType: KnowledgeTreeReadNode["nodeType"];
  resourceType: KnowledgeTreeReadNode["resourceType"];
  resourceId: string;
  sortOrder: DatabaseScalar;
  isExpanded: DatabaseScalar;
  isDeleted: DatabaseScalar;
  createdAt: DatabaseScalar;
  updatedAt: DatabaseScalar;
  title: string;
  icon: string | null;
  isPinned: DatabaseScalar;
  isFavorite: DatabaseScalar;
  isLocked: DatabaseScalar;
  isPasswordProtected: DatabaseScalar;
  contentFormat: string | null;
  sharedRootId: string;
  sharedDepth: DatabaseScalar;
  rootWeight: DatabaseScalar;
  sourcePriority: DatabaseScalar;
};

type RawHistoryRow = {
  id: string;
  nodeId: string;
  action: string;
  actorUserId: string;
  actorUsername: string | null;
  fromParentId: string | null;
  toParentId: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  metadata: unknown;
  createdAt: DatabaseScalar;
};

const TITLE_EXPRESSION = `CASE
  WHEN node.resourceType = 'notebook' THEN COALESCE(nb.name, '未命名文件夹')
  WHEN node.resourceType = 'note' THEN COALESCE(note.title, '无标题笔记')
  WHEN node.resourceType = 'mindmap' THEN COALESCE(mm.title, node.resourceId)
  WHEN node.resourceType = 'file' THEN COALESCE(file.filename, node.resourceId)
  ELSE node.resourceId
END`;

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function resolveDialect(dialect?: DatabaseDialect): DatabaseDialect {
  if (dialect) return dialect;
  try {
    return getDatabaseDialect();
  } catch {
    return "sqlite";
  }
}

function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

function toBoolean(value: DatabaseScalar): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

function toNumber(value: DatabaseScalar): number {
  if (value === null) return 0;
  if (value === true) return 1;
  if (value === false) return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toTimestamp(value: DatabaseScalar): string {
  if (value instanceof Date) return value.toISOString();
  return value === null ? "" : String(value);
}

function parseMetadata(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isPreferredCandidate(next: SharedCandidateRow, current: SharedCandidateRow): boolean {
  const nextWeight = toNumber(next.rootWeight);
  const currentWeight = toNumber(current.rootWeight);
  if (nextWeight !== currentWeight) return nextWeight > currentWeight;

  const nextDepth = toNumber(next.sharedDepth);
  const currentDepth = toNumber(current.sharedDepth);
  if (nextDepth !== currentDepth) return nextDepth < currentDepth;

  const nextPriority = toNumber(next.sourcePriority);
  const currentPriority = toNumber(current.sourcePriority);
  if (nextPriority !== currentPriority) return nextPriority < currentPriority;
  return next.sharedRootId.localeCompare(current.sharedRootId) < 0;
}

function sharedSql(): string {
  return `
    WITH RECURSIVE
    direct_roots(sharedRootId, rootWeight, sourcePriority) AS (
      SELECT
        acl.nodeId,
        CASE acl.rolePreset
          WHEN 'admin' THEN 4
          WHEN 'maintainer' THEN 3
          WHEN 'editor' THEN 2
          ELSE 1
        END,
        0
      FROM knowledge_tree_acl acl
      JOIN knowledge_tree_nodes root ON root.id = acl.nodeId
      WHERE acl.userId = ?
        AND acl.canView
        AND NOT root.isDeleted
        AND root.scopeKey <> ?

      UNION ALL

      SELECT
        root.id,
        CASE member.role
          WHEN 'owner' THEN 4
          WHEN 'admin' THEN 4
          WHEN 'manage' THEN 4
          WHEN 'editor' THEN 2
          WHEN 'write' THEN 2
          ELSE 1
        END,
        1
      FROM notebook_members member
      JOIN notebooks nb ON nb.id = member.notebookId
      JOIN knowledge_tree_nodes root
        ON root.resourceType = 'notebook'
       AND root.resourceId = nb.id
       AND NOT root.isDeleted
      WHERE member.userId = ?
        AND member.status = 'active'
        AND nb.userId <> ?
        AND NOT nb.isDeleted
        AND root.scopeKey <> ?
    ),
    unique_roots(sharedRootId, rootWeight, sourcePriority) AS (
      SELECT sharedRootId, MAX(rootWeight), MIN(sourcePriority)
      FROM direct_roots
      GROUP BY sharedRootId
    ),
    shared_tree(sharedRootId, descendantId, sharedDepth, rootWeight, sourcePriority) AS (
      SELECT sharedRootId, sharedRootId, 0, rootWeight, sourcePriority
      FROM unique_roots
      UNION ALL
      SELECT tree.sharedRootId, child.id, tree.sharedDepth + 1,
             tree.rootWeight, tree.sourcePriority
      FROM shared_tree tree
      JOIN knowledge_tree_nodes child ON child.parentId = tree.descendantId
      WHERE NOT child.isDeleted
    )
    SELECT
      node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
      node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
      node.isExpanded, node.isDeleted, node.createdAt, node.updatedAt,
      ${TITLE_EXPRESSION} AS title,
      CASE WHEN node.resourceType = 'notebook' THEN nb.icon ELSE NULL END AS icon,
      CASE WHEN node.resourceType = 'note' THEN COALESCE(note.isPinned, false) ELSE false END AS isPinned,
      CASE WHEN node.resourceType = 'note' AND EXISTS(
        SELECT 1 FROM favorites favorite
        WHERE favorite.noteId = note.id AND favorite.userId = ?
      ) THEN true ELSE false END AS isFavorite,
      CASE WHEN node.resourceType = 'note' THEN COALESCE(note.isLocked, false) ELSE false END AS isLocked,
      CASE WHEN node.resourceType = 'notebook' AND notebook_password.notebookId IS NOT NULL
        THEN true ELSE false END AS isPasswordProtected,
      CASE WHEN node.resourceType = 'note' THEN note.contentFormat ELSE NULL END AS contentFormat,
      shared_tree.sharedRootId, shared_tree.sharedDepth,
      shared_tree.rootWeight, shared_tree.sourcePriority
    FROM shared_tree
    JOIN knowledge_tree_nodes node ON node.id = shared_tree.descendantId
    LEFT JOIN notebooks nb
      ON node.resourceType = 'notebook' AND nb.id = node.resourceId
    LEFT JOIN notebook_passwords notebook_password
      ON node.resourceType = 'notebook' AND notebook_password.notebookId = node.resourceId
    LEFT JOIN notes note
      ON node.resourceType = 'note' AND note.id = node.resourceId
    LEFT JOIN mindmaps mm
      ON node.resourceType = 'mindmap' AND mm.id = node.resourceId
    LEFT JOIN files file
      ON node.resourceType = 'file' AND file.id = node.resourceId
    WHERE NOT node.isDeleted
    ORDER BY shared_tree.sharedRootId, shared_tree.sharedDepth, node.sortOrder,
             lower(${TITLE_EXPRESSION}), node.id
  `;
}

export function createKnowledgeTreeSurfaceReadRepository(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getDialect = () => resolveDialect(dialect);
  const accessRepository = createKnowledgeTreeNodeAccessRepository(adapter, dialect);

  return {
    async listSharedWithMe(input: {
      userId: string;
      workspaceId: string | null;
    }): Promise<SharedKnowledgeTreeReadNode[]> {
      const currentScopeKey = scopeKey(input.userId, input.workspaceId);
      const candidates = await getAdapter().queryMany<SharedCandidateRow>(
        convertSql(sharedSql(), getDialect()),
        [
          input.userId,
          currentScopeKey,
          input.userId,
          input.userId,
          currentScopeKey,
          input.userId,
        ],
      );

      const visibleCandidates = candidates.filter((candidate) => !(
        candidate.resourceType === "notebook"
        && candidate.resourceId.startsWith(ROOT_DOCUMENT_NOTEBOOK_PREFIX)
      ));
      const resolved = await accessRepository.resolveMany({
        nodeIds: visibleCandidates.map((candidate) => candidate.id),
        userId: input.userId,
      });
      const accessById = new Map(resolved.map((entry) => [entry.node.id, entry.access]));

      const selectedById = new Map<string, SharedCandidateRow>();
      for (const candidate of visibleCandidates) {
        const access = accessById.get(candidate.id);
        if (!access?.capabilities.canView) continue;
        const current = selectedById.get(candidate.id);
        if (!current || isPreferredCandidate(candidate, current)) {
          selectedById.set(candidate.id, candidate);
        }
      }

      const normalized = Array.from(selectedById.values()).map((candidate) => {
        const parent = candidate.parentId ? selectedById.get(candidate.parentId) : undefined;
        const parentId = parent && parent.sharedRootId === candidate.sharedRootId
          ? parent.id
          : null;
        return { candidate, parentId };
      });
      const childCounts = new Map<string, number>();
      for (const entry of normalized) {
        if (entry.parentId) {
          childCounts.set(entry.parentId, (childCounts.get(entry.parentId) || 0) + 1);
        }
      }

      return normalized
        .map(({ candidate, parentId }): SharedKnowledgeTreeReadNode => ({
          id: candidate.id,
          userId: candidate.userId,
          workspaceId: candidate.workspaceId,
          scopeKey: candidate.scopeKey,
          parentId: parentId?.startsWith(ROOT_DOCUMENT_NODE_PREFIX) ? null : parentId,
          nodeType: candidate.nodeType,
          resourceType: candidate.resourceType,
          resourceId: candidate.resourceId,
          title: candidate.title,
          icon: candidate.icon,
          isPinned: toNumber(candidate.isPinned),
          isFavorite: toNumber(candidate.isFavorite),
          isLocked: toNumber(candidate.isLocked),
          isPasswordProtected: toNumber(candidate.isPasswordProtected),
          contentFormat: candidate.contentFormat,
          sortOrder: toNumber(candidate.sortOrder),
          isExpanded: toNumber(candidate.isExpanded),
          isDeleted: toNumber(candidate.isDeleted),
          childCount: childCounts.get(candidate.id) || 0,
          createdAt: toTimestamp(candidate.createdAt),
          updatedAt: toTimestamp(candidate.updatedAt),
          access: accessById.get(candidate.id)!,
          sharedRootId: candidate.sharedRootId,
          sharedDepth: toNumber(candidate.sharedDepth),
        }))
        .sort((left, right) => (
          left.sharedRootId.localeCompare(right.sharedRootId)
          || left.sharedDepth - right.sharedDepth
          || left.sortOrder - right.sortOrder
          || left.title.localeCompare(right.title)
          || left.id.localeCompare(right.id)
        ));
    },

    async listHistory(input: {
      actorUserId: string;
      nodeId: string;
    }): Promise<KnowledgeTreeHistoryRow[]> {
      const resolved = await accessRepository.resolveOne({
        nodeId: input.nodeId,
        userId: input.actorUserId,
      });
      if (!resolved) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_NODE_NOT_FOUND",
          404,
          "内容节点不存在",
        );
      }
      if (!resolved.access.capabilities.canView) {
        throw new KnowledgeTreeMutationError(
          "KNOWLEDGE_CAPABILITY_FORBIDDEN",
          403,
          "没有查看权限",
          { required: "canView", source: resolved.access.source },
        );
      }

      const rows = await getAdapter().queryMany<RawHistoryRow>(
        convertSql(
          `SELECT history.id, history.nodeId, history.action,
                  history.actorUserId, actor.username AS actorUsername,
                  history.fromParentId, history.toParentId,
                  history.targetUserId, target.username AS targetUsername,
                  history.metadata, history.createdAt
             FROM knowledge_tree_history history
             LEFT JOIN users actor ON actor.id = history.actorUserId
             LEFT JOIN users target ON target.id = history.targetUserId
            WHERE history.nodeId = ?
            ORDER BY history.createdAt DESC, history.id DESC
            LIMIT 200`,
          getDialect(),
        ),
        [input.nodeId],
      );

      return rows.map((row) => ({
        ...row,
        metadata: parseMetadata(row.metadata),
        createdAt: toTimestamp(row.createdAt),
      }));
    },
  };
}

export const knowledgeTreeSurfaceReadRepository = createKnowledgeTreeSurfaceReadRepository();

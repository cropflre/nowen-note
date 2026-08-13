import type { DatabaseAdapter } from "../db/adapters/types";
import { convertSql, type DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import type {
  EffectiveKnowledgeAccess,
  KnowledgeCapabilities,
  KnowledgeRolePreset,
} from "../services/knowledgeCapabilitiesCore";
import type { KnowledgeTreeNode } from "../services/knowledgeTreeCore";

const ROOT_DOCUMENT_NOTEBOOK_PREFIX = "__nowen_root_documents__:";
const ROOT_DOCUMENT_NODE_PREFIX = `notebook:${ROOT_DOCUMENT_NOTEBOOK_PREFIX}`;

type DatabaseScalar = boolean | number | string | Date | null;

type ListedNodeRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  nodeType: KnowledgeTreeNode["nodeType"];
  resourceType: KnowledgeTreeNode["resourceType"];
  resourceId: string;
  sortOrder: DatabaseScalar;
  isExpanded: DatabaseScalar;
  isDeleted: DatabaseScalar;
  deletedAt: DatabaseScalar;
  createdAt: DatabaseScalar;
  updatedAt: DatabaseScalar;
  title: string;
  icon: string | null;
  isPinned: DatabaseScalar;
  isFavorite: DatabaseScalar;
  isLocked: DatabaseScalar;
  isPasswordProtected: DatabaseScalar;
  contentFormat: string | null;
  childCount: DatabaseScalar;
  aclNodeId: string | null;
  aclRolePreset: KnowledgeRolePreset | null;
  aclCanView: DatabaseScalar;
  aclCanComment: DatabaseScalar;
  aclCanCreate: DatabaseScalar;
  aclCanEdit: DatabaseScalar;
  aclCanDelete: DatabaseScalar;
  aclCanMove: DatabaseScalar;
  aclCanDownload: DatabaseScalar;
  aclCanReshare: DatabaseScalar;
  aclCanManageMembers: DatabaseScalar;
  aclDepth: DatabaseScalar;
  workspaceOwnerId: string | null;
  workspaceRole: string | null;
  notebookRole: string | null;
  noteNotebookRole: string | null;
  notePermission: string | null;
};

export type KnowledgeTreeReadNode = KnowledgeTreeNode & {
  deletedAt?: string | null;
};

const NONE: KnowledgeCapabilities = {
  canView: false,
  canComment: false,
  canCreate: false,
  canEdit: false,
  canDelete: false,
  canMove: false,
  canDownload: false,
  canReshare: false,
  canManageMembers: false,
};

const ROLE_PRESETS: Record<KnowledgeRolePreset, KnowledgeCapabilities> = {
  readonly: {
    ...NONE,
    canView: true,
    canDownload: true,
  },
  editor: {
    ...NONE,
    canView: true,
    canComment: true,
    canCreate: true,
    canEdit: true,
    canDownload: true,
  },
  maintainer: {
    ...NONE,
    canView: true,
    canComment: true,
    canCreate: true,
    canEdit: true,
    canDelete: true,
    canMove: true,
    canDownload: true,
  },
  admin: {
    canView: true,
    canComment: true,
    canCreate: true,
    canEdit: true,
    canDelete: true,
    canMove: true,
    canDownload: true,
    canReshare: true,
    canManageMembers: true,
  },
};

const TITLE_EXPRESSION = `CASE
  WHEN node.resourceType = 'notebook' THEN COALESCE(nb.name, '未命名文件夹')
  WHEN node.resourceType = 'note' THEN COALESCE(note.title, '无标题笔记')
  WHEN node.resourceType = 'mindmap' THEN COALESCE(mm.title, node.resourceId)
  WHEN node.resourceType = 'file' THEN COALESCE(file.filename, node.resourceId)
  ELSE node.resourceId
END`;

function cloneCapabilities(capabilities: KnowledgeCapabilities): KnowledgeCapabilities {
  return { ...capabilities };
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

function toOptionalTimestamp(value: DatabaseScalar): string | null {
  if (value === null) return null;
  return toTimestamp(value);
}

function legacyPermission(role: string | null): Pick<EffectiveKnowledgeAccess, "rolePreset" | "capabilities"> {
  if (role === "manage" || role === "admin" || role === "owner") {
    return { rolePreset: "admin", capabilities: cloneCapabilities(ROLE_PRESETS.admin) };
  }
  if (role === "write" || role === "editor") {
    return { rolePreset: "editor", capabilities: cloneCapabilities(ROLE_PRESETS.editor) };
  }
  if (role === "comment" || role === "commenter") {
    return {
      rolePreset: "commenter",
      capabilities: { ...ROLE_PRESETS.readonly, canComment: true },
    };
  }
  if (role === "read" || role === "viewer") {
    return { rolePreset: "readonly", capabilities: cloneCapabilities(ROLE_PRESETS.readonly) };
  }
  return { rolePreset: "none", capabilities: cloneCapabilities(NONE) };
}

function explicitCapabilities(row: ListedNodeRow): KnowledgeCapabilities {
  return {
    canView: toBoolean(row.aclCanView),
    canComment: toBoolean(row.aclCanComment),
    canCreate: toBoolean(row.aclCanCreate),
    canEdit: toBoolean(row.aclCanEdit),
    canDelete: toBoolean(row.aclCanDelete),
    canMove: toBoolean(row.aclCanMove),
    canDownload: toBoolean(row.aclCanDownload),
    canReshare: toBoolean(row.aclCanReshare),
    canManageMembers: toBoolean(row.aclCanManageMembers),
  };
}

function resolveAccess(row: ListedNodeRow, userId: string): EffectiveKnowledgeAccess {
  const ownsPersonalNode = !row.workspaceId && row.userId === userId;
  const ownsWorkspace = Boolean(row.workspaceId && row.workspaceOwnerId === userId);
  if (ownsPersonalNode || ownsWorkspace) {
    return {
      nodeId: row.id,
      rolePreset: "admin",
      capabilities: cloneCapabilities(ROLE_PRESETS.admin),
      source: "owner",
      sourceNodeId: row.id,
    };
  }

  if (row.aclNodeId && row.aclRolePreset) {
    return {
      nodeId: row.id,
      rolePreset: row.aclRolePreset,
      capabilities: explicitCapabilities(row),
      source: toNumber(row.aclDepth) === 0 ? "direct" : "inherited",
      sourceNodeId: row.aclNodeId,
    };
  }

  let role: string | null = null;
  if (row.resourceType === "notebook") {
    role = row.notebookRole;
  } else if (row.resourceType === "note") {
    role = row.noteNotebookRole || row.notePermission;
  }
  role ||= row.workspaceRole;

  const legacy = legacyPermission(role);
  return {
    nodeId: row.id,
    ...legacy,
    source: legacy.rolePreset === "none" ? "none" : "legacy",
    sourceNodeId: null,
  };
}

function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

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

function listSql(includeDeleted: boolean): string {
  return `
    WITH RECURSIVE
    viewer(userId) AS (SELECT ?),
    scope_nodes AS (
      SELECT node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
             node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
             node.isExpanded, node.isDeleted, node.deletedAt, node.createdAt, node.updatedAt
      FROM knowledge_tree_nodes node
      WHERE node.scopeKey = ? ${includeDeleted ? "" : "AND node.isDeleted = 0"}
    ),
    ancestors(nodeId, ancestorId, parentId, depth) AS (
      SELECT node.id, node.id, node.parentId, 0
      FROM scope_nodes node
      UNION ALL
      SELECT ancestors.nodeId, parent.id, parent.parentId, ancestors.depth + 1
      FROM ancestors
      JOIN knowledge_tree_nodes parent ON parent.id = ancestors.parentId
      WHERE ancestors.parentId IS NOT NULL
    ),
    ranked_acl AS (
      SELECT ancestors.nodeId,
             acl.nodeId AS aclNodeId,
             acl.rolePreset AS aclRolePreset,
             acl.canView AS aclCanView,
             acl.canComment AS aclCanComment,
             acl.canCreate AS aclCanCreate,
             acl.canEdit AS aclCanEdit,
             acl.canDelete AS aclCanDelete,
             acl.canMove AS aclCanMove,
             acl.canDownload AS aclCanDownload,
             acl.canReshare AS aclCanReshare,
             acl.canManageMembers AS aclCanManageMembers,
             ancestors.depth AS aclDepth,
             ROW_NUMBER() OVER (
               PARTITION BY ancestors.nodeId
               ORDER BY ancestors.depth ASC
             ) AS rn
      FROM ancestors
      JOIN knowledge_tree_acl acl ON acl.nodeId = ancestors.ancestorId
      CROSS JOIN viewer
      WHERE acl.userId = viewer.userId
    )
    SELECT node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
           node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
           node.isExpanded, node.isDeleted, node.deletedAt, node.createdAt, node.updatedAt,
           ${TITLE_EXPRESSION} AS title,
           CASE WHEN node.resourceType = 'notebook' THEN nb.icon ELSE NULL END AS icon,
           CASE WHEN node.resourceType = 'note' AND note.isPinned THEN 1 ELSE 0 END AS isPinned,
           CASE WHEN favorite.noteId IS NOT NULL THEN 1 ELSE 0 END AS isFavorite,
           CASE WHEN node.resourceType = 'note' AND note.isLocked THEN 1 ELSE 0 END AS isLocked,
           CASE WHEN notebook_password.notebookId IS NOT NULL THEN 1 ELSE 0 END AS isPasswordProtected,
           CASE WHEN node.resourceType = 'note' THEN note.contentFormat ELSE NULL END AS contentFormat,
           (
             SELECT COUNT(*)
             FROM knowledge_tree_nodes child
             WHERE child.parentId = node.id AND child.isDeleted = 0
           ) AS childCount,
           explicit.aclNodeId, explicit.aclRolePreset,
           explicit.aclCanView, explicit.aclCanComment, explicit.aclCanCreate,
           explicit.aclCanEdit, explicit.aclCanDelete, explicit.aclCanMove,
           explicit.aclCanDownload, explicit.aclCanReshare, explicit.aclCanManageMembers,
           explicit.aclDepth,
           workspace.ownerId AS workspaceOwnerId,
           workspace_member.role AS workspaceRole,
           notebook_member.role AS notebookRole,
           note_notebook_member.role AS noteNotebookRole,
           note_acl.permission AS notePermission
    FROM scope_nodes node
    CROSS JOIN viewer
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
    LEFT JOIN favorites favorite
      ON node.resourceType = 'note'
     AND favorite.noteId = node.resourceId
     AND favorite.userId = viewer.userId
    LEFT JOIN ranked_acl explicit
      ON explicit.nodeId = node.id AND explicit.rn = 1
    LEFT JOIN workspaces workspace
      ON workspace.id = node.workspaceId
    LEFT JOIN workspace_members workspace_member
      ON workspace_member.workspaceId = node.workspaceId
     AND workspace_member.userId = viewer.userId
    LEFT JOIN notebook_members notebook_member
      ON node.resourceType = 'notebook'
     AND notebook_member.notebookId = node.resourceId
     AND notebook_member.userId = viewer.userId
     AND notebook_member.status != 'removed'
    LEFT JOIN notebook_members note_notebook_member
      ON node.resourceType = 'note'
     AND note_notebook_member.notebookId = note.notebookId
     AND note_notebook_member.userId = viewer.userId
     AND note_notebook_member.status != 'removed'
    LEFT JOIN note_acl note_acl
      ON node.resourceType = 'note'
     AND note_acl.noteId = node.resourceId
     AND note_acl.userId = viewer.userId
    ORDER BY
      CASE WHEN node.parentId IS NULL THEN 0 ELSE 1 END,
      node.parentId,
      node.sortOrder,
      lower(${TITLE_EXPRESSION}),
      node.id
  `;
}

export function createKnowledgeTreeReadRepository(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getDialect = () => resolveDialect(dialect);

  return {
    async list(input: {
      userId: string;
      workspaceId: string | null;
      includeDeleted?: boolean;
    }): Promise<KnowledgeTreeReadNode[]> {
      const rows = await getAdapter().queryMany<ListedNodeRow>(
        convertSql(listSql(Boolean(input.includeDeleted)), getDialect()),
        [input.userId, scopeKey(input.userId, input.workspaceId)],
      );

      return rows
        .filter((row) => !(
          row.resourceType === "notebook"
          && row.resourceId.startsWith(ROOT_DOCUMENT_NOTEBOOK_PREFIX)
        ))
        .map((row): KnowledgeTreeReadNode => {
          const access = resolveAccess(row, input.userId);
          return {
            id: row.id,
            userId: row.userId,
            workspaceId: row.workspaceId,
            scopeKey: row.scopeKey,
            parentId: row.parentId?.startsWith(ROOT_DOCUMENT_NODE_PREFIX) ? null : row.parentId,
            nodeType: row.nodeType,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            title: row.title,
            icon: row.icon,
            isPinned: toNumber(row.isPinned),
            isFavorite: toNumber(row.isFavorite),
            isLocked: toNumber(row.isLocked),
            isPasswordProtected: toNumber(row.isPasswordProtected),
            contentFormat: row.contentFormat,
            sortOrder: toNumber(row.sortOrder),
            isExpanded: toNumber(row.isExpanded),
            isDeleted: toNumber(row.isDeleted),
            childCount: toNumber(row.childCount),
            deletedAt: toOptionalTimestamp(row.deletedAt),
            createdAt: toTimestamp(row.createdAt),
            updatedAt: toTimestamp(row.updatedAt),
            access,
          };
        })
        .filter((row) => row.access.capabilities.canView);
    },
  };
}

export const knowledgeTreeReadRepository = createKnowledgeTreeReadRepository();

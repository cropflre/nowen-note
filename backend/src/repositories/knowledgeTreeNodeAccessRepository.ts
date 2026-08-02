import type { DatabaseAdapter } from "../db/adapters/types";
import { convertSql, type DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import type {
  EffectiveKnowledgeAccess,
  KnowledgeCapabilities,
  KnowledgeRolePreset,
} from "../services/knowledgeCapabilitiesCore";

export type KnowledgeTreeAccessNode = {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  nodeType: "folder" | "note" | "markdown" | "word" | "mindmap" | "file";
  resourceType: "notebook" | "note" | "mindmap" | "file";
  resourceId: string;
  sortOrder: number;
  isDeleted: boolean;
};

export type ResolvedKnowledgeTreeNodeAccess = {
  node: KnowledgeTreeAccessNode;
  access: EffectiveKnowledgeAccess;
};

type DatabaseScalar = boolean | number | string | Date | null;

type AccessRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  nodeType: KnowledgeTreeAccessNode["nodeType"];
  resourceType: KnowledgeTreeAccessNode["resourceType"];
  resourceId: string;
  sortOrder: DatabaseScalar;
  isDeleted: DatabaseScalar;
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

function cloneCapabilities(value: KnowledgeCapabilities): KnowledgeCapabilities {
  return { ...value };
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

function explicitCapabilities(row: AccessRow): KnowledgeCapabilities {
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

function noneAccess(nodeId: string): EffectiveKnowledgeAccess {
  return {
    nodeId,
    rolePreset: "none",
    capabilities: cloneCapabilities(NONE),
    source: "none",
    sourceNodeId: null,
  };
}

function resolveAccess(row: AccessRow, userId: string): EffectiveKnowledgeAccess {
  if (toBoolean(row.isDeleted)) return noneAccess(row.id);

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

function accessSql(nodeCount: number): string {
  const requestedValues = Array.from({ length: nodeCount }, () => "(?)").join(", ");
  return `
    WITH RECURSIVE
    requested(id) AS (VALUES ${requestedValues}),
    viewer(userId) AS (SELECT ?),
    ancestors(nodeId, ancestorId, parentId, depth) AS (
      SELECT node.id, node.id, node.parentId, 0
      FROM knowledge_tree_nodes node
      JOIN requested ON requested.id = node.id
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
           node.nodeType, node.resourceType, node.resourceId, node.sortOrder, node.isDeleted,
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
    FROM requested
    JOIN knowledge_tree_nodes node ON node.id = requested.id
    CROSS JOIN viewer
    LEFT JOIN ranked_acl explicit
      ON explicit.nodeId = node.id AND explicit.rn = 1
    LEFT JOIN workspaces workspace
      ON workspace.id = node.workspaceId
    LEFT JOIN workspace_members workspace_member
      ON workspace_member.workspaceId = node.workspaceId
     AND workspace_member.userId = viewer.userId
    LEFT JOIN notebooks notebook
      ON node.resourceType = 'notebook' AND notebook.id = node.resourceId
    LEFT JOIN notebook_members notebook_member
      ON node.resourceType = 'notebook'
     AND notebook_member.notebookId = node.resourceId
     AND notebook_member.userId = viewer.userId
     AND notebook_member.status != 'removed'
    LEFT JOIN notes note
      ON node.resourceType = 'note' AND note.id = node.resourceId
    LEFT JOIN notebook_members note_notebook_member
      ON node.resourceType = 'note'
     AND note_notebook_member.notebookId = note.notebookId
     AND note_notebook_member.userId = viewer.userId
     AND note_notebook_member.status != 'removed'
    LEFT JOIN note_acl note_acl
      ON node.resourceType = 'note'
     AND note_acl.noteId = node.resourceId
     AND note_acl.userId = viewer.userId
  `;
}

export function createKnowledgeTreeNodeAccessRepository(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getDialect = () => resolveDialect(dialect);

  async function resolveMany(input: {
    nodeIds: string[];
    userId: string;
    includeDeleted?: boolean;
  }): Promise<ResolvedKnowledgeTreeNodeAccess[]> {
    const nodeIds = Array.from(new Set(input.nodeIds.filter(Boolean)));
    if (nodeIds.length === 0) return [];
    if (nodeIds.length > 2_000) {
      throw new Error("knowledge tree access batch exceeds 2000 nodes");
    }

    const rows = await getAdapter().queryMany<AccessRow>(
      convertSql(accessSql(nodeIds.length), getDialect()),
      [...nodeIds, input.userId],
    );

    return rows
      .map((row): ResolvedKnowledgeTreeNodeAccess => ({
        node: {
          id: row.id,
          userId: row.userId,
          workspaceId: row.workspaceId,
          scopeKey: row.scopeKey,
          parentId: row.parentId,
          nodeType: row.nodeType,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          sortOrder: toNumber(row.sortOrder),
          isDeleted: toBoolean(row.isDeleted),
        },
        access: resolveAccess(row, input.userId),
      }))
      .filter((entry) => input.includeDeleted || !entry.node.isDeleted);
  }

  return {
    resolveMany,

    async resolveOne(input: {
      nodeId: string;
      userId: string;
      includeDeleted?: boolean;
    }): Promise<ResolvedKnowledgeTreeNodeAccess | null> {
      const rows = await resolveMany({
        nodeIds: [input.nodeId],
        userId: input.userId,
        includeDeleted: input.includeDeleted,
      });
      return rows[0] || null;
    },
  };
}

export const knowledgeTreeNodeAccessRepository = createKnowledgeTreeNodeAccessRepository();

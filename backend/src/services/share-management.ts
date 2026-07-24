import { ensureNotebookAclOverridesTable } from "../queries/memberQueryService";

export type ShareEffectiveStatus = "active" | "disabled" | "expired" | "exhausted";

export interface ShareManagementQuery {
  q?: string;
  status?: ShareEffectiveStatus;
  permission?: "view" | "comment" | "edit" | "edit_auth";
  hasPassword?: boolean;
  sort?: "createdAt" | "updatedAt" | "expiresAt" | "noteTitle";
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface ShareManagementRawRow {
  id: string;
  noteId: string;
  ownerId: string;
  shareToken: string;
  shareType: string;
  permission: string;
  password: string | null;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
  isActive: number;
  createdAt: string;
  updatedAt: string;
  noteTitle: string | null;
  noteOwnerId: string | null;
  notebookId: string | null;
  notebookName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  noteIsTrashed: number | null;
}

export interface ShareManagementAccessContext {
  notebookRoleById: Map<string, string>;
  notePermissionById: Map<string, string>;
  workspaceRoleById: Map<string, string>;
}

const STATUS_VALUES = new Set<ShareEffectiveStatus>(["active", "disabled", "expired", "exhausted"]);
const PERMISSION_VALUES = new Set(["view", "comment", "edit", "edit_auth"]);
const SORT_VALUES = new Set(["createdAt", "updatedAt", "expiresAt", "noteTitle"]);

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function parseShareManagementQuery(input: Record<string, string | undefined>): ShareManagementQuery {
  const status = STATUS_VALUES.has(input.status as ShareEffectiveStatus)
    ? input.status as ShareEffectiveStatus
    : undefined;
  const permission = PERMISSION_VALUES.has(input.permission || "")
    ? input.permission as ShareManagementQuery["permission"]
    : undefined;
  const hasPassword = input.hasPassword === "1" || input.hasPassword === "true"
    ? true
    : input.hasPassword === "0" || input.hasPassword === "false"
      ? false
      : undefined;
  const sort = SORT_VALUES.has(input.sort || "")
    ? input.sort as ShareManagementQuery["sort"]
    : "updatedAt";
  return {
    q: input.q?.trim() || undefined,
    status,
    permission,
    hasPassword,
    sort,
    order: input.order === "asc" ? "asc" : "desc",
    page: positiveInt(input.page, 1, 1_000_000),
    pageSize: positiveInt(input.pageSize, 20, 100),
  };
}

export function resolveShareEffectiveStatus(
  share: Pick<ShareManagementRawRow, "isActive" | "expiresAt" | "maxViews" | "viewCount">,
  nowMs = Date.now(),
): ShareEffectiveStatus {
  if (!Number(share.isActive)) return "disabled";
  if (share.expiresAt) {
    const expiresAt = Date.parse(share.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return "expired";
  }
  if (share.maxViews !== null && Number(share.viewCount || 0) >= Number(share.maxViews)) {
    return "exhausted";
  }
  return "active";
}

function canManageShare(
  row: ShareManagementRawRow,
  userId: string,
  access: ShareManagementAccessContext,
): boolean {
  if (row.ownerId === userId) return true;
  if (!row.noteOwnerId) return false;
  if (row.noteOwnerId === userId) return true;

  if (row.notebookId && access.notebookRoleById.has(row.notebookId)) {
    const role = access.notebookRoleById.get(row.notebookId);
    return role === "owner" || role === "admin" || role === "manage";
  }

  if (!row.workspaceId) return false;
  if (access.notePermissionById.has(row.noteId)) {
    return access.notePermissionById.get(row.noteId) === "manage";
  }
  const workspaceRole = access.workspaceRoleById.get(row.workspaceId);
  return workspaceRole === "owner" || workspaceRole === "admin";
}

function compareNullableDate(a: string | null, b: string | null, direction: number): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return (Date.parse(a) - Date.parse(b)) * direction;
}

export function buildShareManagementResult(
  rows: ShareManagementRawRow[],
  userId: string,
  access: ShareManagementAccessContext,
  query: ShareManagementQuery,
  nowMs = Date.now(),
) {
  const manageable = rows
    .filter((row) => canManageShare(row, userId, access))
    .map((row) => ({ ...row, effectiveStatus: resolveShareEffectiveStatus(row, nowMs) }));

  const stats = manageable.reduce(
    (acc, row) => {
      acc.total += 1;
      acc[row.effectiveStatus] += 1;
      return acc;
    },
    { total: 0, active: 0, disabled: 0, expired: 0, exhausted: 0 },
  );

  const normalizedQuery = query.q?.toLocaleLowerCase() || "";
  const filtered = manageable.filter((row) => {
    if (query.status && row.effectiveStatus !== query.status) return false;
    if (query.permission && row.permission !== query.permission) return false;
    if (query.hasPassword !== undefined && Boolean(row.password) !== query.hasPassword) return false;
    if (!normalizedQuery) return true;
    return [row.noteTitle, row.shareToken, row.notebookName, row.workspaceName]
      .some((value) => String(value || "").toLocaleLowerCase().includes(normalizedQuery));
  });

  const direction = query.order === "asc" ? 1 : -1;
  const sort = query.sort || "updatedAt";
  filtered.sort((a, b) => {
    if (sort === "noteTitle") {
      return String(a.noteTitle || "").localeCompare(String(b.noteTitle || ""), "zh-CN") * direction;
    }
    if (sort === "expiresAt") return compareNullableDate(a.expiresAt, b.expiresAt, direction);
    const result = (Date.parse(a[sort]) - Date.parse(b[sort])) * direction;
    return result || a.id.localeCompare(b.id);
  });

  const page = Math.max(1, query.page || 1);
  const pageSize = Math.max(1, Math.min(100, query.pageSize || 20));
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize).map((row) => {
    const { password, noteOwnerId, ...safe } = row;
    return {
      ...safe,
      hasPassword: Boolean(password),
      noteMissing: !noteOwnerId,
      noteIsTrashed: Boolean(row.noteIsTrashed),
    };
  });

  return { items, total, page, pageSize, stats };
}

export function queryShareManagement(
  db: any,
  userId: string,
  query: ShareManagementQuery,
  nowMs = Date.now(),
) {
  ensureNotebookAclOverridesTable();

  const rows = db.prepare(`
    SELECT
      s.*,
      n.title AS noteTitle,
      n.userId AS noteOwnerId,
      n.notebookId AS notebookId,
      n.workspaceId AS workspaceId,
      n.isTrashed AS noteIsTrashed,
      nb.name AS notebookName,
      w.name AS workspaceName
    FROM shares s
    LEFT JOIN notes n ON n.id = s.noteId
    LEFT JOIN notebooks nb ON nb.id = n.notebookId
    LEFT JOIN workspaces w ON w.id = n.workspaceId
  `).all() as ShareManagementRawRow[];

  const notebookRoles = db.prepare(`
    WITH RECURSIVE ancestors(targetNotebookId, id, parentId, depth) AS (
      SELECT id, id, parentId, 0
      FROM notebooks
      WHERE isDeleted = 0
      UNION ALL
      SELECT ancestors.targetNotebookId, parent.id, parent.parentId, ancestors.depth + 1
      FROM ancestors
      JOIN notebooks parent ON parent.id = ancestors.parentId
      WHERE parent.isDeleted = 0
    ), candidates AS (
      SELECT ancestors.targetNotebookId, acl.permission AS role, ancestors.depth, 0 AS sourcePriority
      FROM ancestors
      JOIN notebook_acl_overrides acl
        ON acl.notebookId = ancestors.id AND acl.userId = ?
      UNION ALL
      SELECT ancestors.targetNotebookId, nm.role AS role, ancestors.depth, 1 AS sourcePriority
      FROM ancestors
      JOIN notebook_members nm
        ON nm.notebookId = ancestors.id
       AND nm.userId = ?
       AND nm.status = 'active'
    ), ranked AS (
      SELECT targetNotebookId, role,
        ROW_NUMBER() OVER (PARTITION BY targetNotebookId ORDER BY depth ASC, sourcePriority ASC) AS rowNumber
      FROM candidates
    )
    SELECT targetNotebookId, role FROM ranked WHERE rowNumber = 1
  `).all(userId, userId) as Array<{ targetNotebookId: string; role: string }>;

  const notePermissions = db.prepare(
    "SELECT noteId, permission FROM note_acl WHERE userId = ?",
  ).all(userId) as Array<{ noteId: string; permission: string }>;
  const workspaceRoles = db.prepare(
    "SELECT workspaceId, role FROM workspace_members WHERE userId = ?",
  ).all(userId) as Array<{ workspaceId: string; role: string }>;

  return buildShareManagementResult(
    rows,
    userId,
    {
      notebookRoleById: new Map(notebookRoles.map((row) => [row.targetNotebookId, row.role])),
      notePermissionById: new Map(notePermissions.map((row) => [row.noteId, row.permission])),
      workspaceRoleById: new Map(workspaceRoles.map((row) => [row.workspaceId, row.role])),
    },
    query,
    nowMs,
  );
}

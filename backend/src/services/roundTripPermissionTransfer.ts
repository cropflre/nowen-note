import crypto from "crypto";
import JSZip from "jszip";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole, hasRole, isSystemAdmin } from "../middleware/acl";

export const ROUND_TRIP_PERMISSION_FORMAT = "nowen-workspace-permissions" as const;
export const ROUND_TRIP_PERMISSION_VERSION = 2 as const;

export type RoundTripPermissionMappings = Record<string, string>;

export interface RoundTripPermissionImportOptions {
  userId: string;
  workspaceId?: string | null;
  applyPermissions?: boolean;
  permissionMappings?: RoundTripPermissionMappings;
}

type WorkspaceRole = "owner" | "admin" | "editor" | "commenter" | "viewer";
type NotebookRole = "owner" | "editor" | "viewer";

interface PackageManifest {
  format?: string;
  formatVersion?: number;
  app?: string;
  packageKind?: string;
  sourceInstanceId?: string | null;
  exportedAt?: string;
  permissions?: Record<string, unknown>;
}

export interface PermissionPrincipal {
  sourceUserId: string;
  username: string;
  displayName: string | null;
  email: string | null;
}

export interface PermissionWorkspaceMember {
  sourceUserId: string;
  role: WorkspaceRole;
  joinedAt?: string | null;
}

export interface PermissionNotebookMember {
  sourceNotebookId: string;
  sourceUserId: string;
  role: NotebookRole;
  allowDownload: boolean;
  allowReshare: boolean;
}

export interface RoundTripPermissionsManifestV2 {
  format: typeof ROUND_TRIP_PERMISSION_FORMAT;
  version: typeof ROUND_TRIP_PERMISSION_VERSION;
  exportedAt: string;
  sourceWorkspace: {
    id: string;
    name: string;
  };
  principals: PermissionPrincipal[];
  workspaceMembers: PermissionWorkspaceMember[];
  notebookMembers: PermissionNotebookMember[];
}

interface PublicTargetUser {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface RoundTripPermissionInspection {
  included: boolean;
  valid: boolean;
  canApply: boolean;
  version: number | null;
  reason: string | null;
  counts: {
    principals: number;
    workspaceMembers: number;
    notebookMembers: number;
  };
  principals: Array<PermissionPrincipal & {
    workspaceRole: WorkspaceRole | null;
    suggestedTarget: PublicTargetUser | null;
    match: "email" | "username" | "ambiguous" | "none";
  }>;
  issues: string[];
}

export interface PermissionUndoRow {
  table: "workspace_members" | "notebook_members";
  key: Record<string, string>;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  afterHash: string;
}

export interface PermissionUndoState {
  version: 2;
  workspaceId: string;
  rows: PermissionUndoRow[];
}

interface ParsedPermissionPackage {
  manifest: PackageManifest | null;
  permissions: RoundTripPermissionsManifestV2 | null;
  included: boolean;
  version: number | null;
  issues: string[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, stableValue(source[key])]));
  }
  return value;
}

function hashRow(row: Record<string, unknown> | null): string {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(row))).digest("hex");
}

function normalizedEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function normalizedUsername(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function workspaceScope(workspaceId: string | null | undefined): string {
  return workspaceId || "personal";
}

export function canManageRoundTripPermissions(userId: string, workspaceId: string | null | undefined): boolean {
  if (!workspaceId) return false;
  if (isSystemAdmin(userId)) return true;
  return hasRole(getUserWorkspaceRole(workspaceId, userId), "admin");
}

function workspaceRoleRank(role: string | null | undefined): number {
  switch (role) {
    case "owner": return 5;
    case "admin": return 4;
    case "editor": return 3;
    case "commenter": return 2;
    case "viewer": return 1;
    default: return 0;
  }
}

function notebookRoleRank(role: string | null | undefined): number {
  switch (role) {
    case "owner": return 3;
    case "editor": return 2;
    case "viewer": return 1;
    default: return 0;
  }
}

function parseWorkspaceRole(value: unknown): WorkspaceRole | null {
  return value === "owner" || value === "admin" || value === "editor" || value === "commenter" || value === "viewer"
    ? value
    : null;
}

function parseNotebookRole(value: unknown): NotebookRole | null {
  return value === "owner" || value === "editor" || value === "viewer" ? value : null;
}

async function readJsonEntry<T>(zip: JSZip, filename: string): Promise<{
  present: boolean;
  value: T | null;
  error: string | null;
}> {
  const entry = zip.file(filename);
  if (!entry) return { present: false, value: null, error: null };
  try {
    return { present: true, value: JSON.parse(await entry.async("string")) as T, error: null };
  } catch {
    return { present: true, value: null, error: `${filename} 不是有效 JSON` };
  }
}

function normalizeV2Manifest(raw: Record<string, unknown>, issues: string[]): RoundTripPermissionsManifestV2 | null {
  const sourceWorkspaceRaw = raw.sourceWorkspace && typeof raw.sourceWorkspace === "object"
    ? raw.sourceWorkspace as Record<string, unknown>
    : {};
  const principalRows = Array.isArray(raw.principals) ? raw.principals : [];
  const workspaceRows = Array.isArray(raw.workspaceMembers) ? raw.workspaceMembers : [];
  const notebookRows = Array.isArray(raw.notebookMembers) ? raw.notebookMembers : [];
  const principals: PermissionPrincipal[] = [];
  const principalIds = new Set<string>();

  for (const item of principalRows) {
    if (!item || typeof item !== "object") {
      issues.push("权限成员身份清单包含无效项");
      continue;
    }
    const row = item as Record<string, unknown>;
    const sourceUserId = String(row.sourceUserId || "").trim();
    const username = String(row.username || "").trim();
    if (!sourceUserId || !username || principalIds.has(sourceUserId)) {
      issues.push("权限成员身份清单存在缺失或重复项");
      continue;
    }
    principalIds.add(sourceUserId);
    principals.push({
      sourceUserId,
      username,
      displayName: row.displayName == null ? null : String(row.displayName),
      email: row.email == null ? null : String(row.email),
    });
  }

  const workspaceMembers: PermissionWorkspaceMember[] = [];
  const workspaceKeys = new Set<string>();
  for (const item of workspaceRows) {
    if (!item || typeof item !== "object") {
      issues.push("工作区成员授权包含无效项");
      continue;
    }
    const row = item as Record<string, unknown>;
    const sourceUserId = String(row.sourceUserId || "").trim();
    const role = parseWorkspaceRole(row.role);
    if (!sourceUserId || !role || !principalIds.has(sourceUserId) || workspaceKeys.has(sourceUserId)) {
      issues.push("工作区成员授权引用了无效、缺失或重复成员");
      continue;
    }
    workspaceKeys.add(sourceUserId);
    workspaceMembers.push({ sourceUserId, role, joinedAt: row.joinedAt == null ? null : String(row.joinedAt) });
  }

  const notebookMembers: PermissionNotebookMember[] = [];
  const notebookKeys = new Set<string>();
  for (const item of notebookRows) {
    if (!item || typeof item !== "object") {
      issues.push("笔记本成员授权包含无效项");
      continue;
    }
    const row = item as Record<string, unknown>;
    const sourceNotebookId = String(row.sourceNotebookId || "").trim();
    const sourceUserId = String(row.sourceUserId || "").trim();
    const role = parseNotebookRole(row.role);
    const key = `${sourceNotebookId}\u0000${sourceUserId}`;
    if (!sourceNotebookId || !sourceUserId || !role || !principalIds.has(sourceUserId) || notebookKeys.has(key)) {
      issues.push("笔记本成员授权引用了无效、缺失或重复对象");
      continue;
    }
    notebookKeys.add(key);
    notebookMembers.push({
      sourceNotebookId,
      sourceUserId,
      role,
      allowDownload: row.allowDownload !== false && Number(row.allowDownload) !== 0,
      allowReshare: row.allowReshare === true || Number(row.allowReshare) === 1,
    });
  }

  const sourceWorkspaceId = String(sourceWorkspaceRaw.id || "").trim();
  if (!sourceWorkspaceId) issues.push("权限清单缺少来源工作区标识");

  return {
    format: ROUND_TRIP_PERMISSION_FORMAT,
    version: ROUND_TRIP_PERMISSION_VERSION,
    exportedAt: String(raw.exportedAt || new Date().toISOString()),
    sourceWorkspace: {
      id: sourceWorkspaceId,
      name: String(sourceWorkspaceRaw.name || "工作区"),
    },
    principals,
    workspaceMembers,
    notebookMembers,
  };
}

function normalizeLegacyV1(raw: Record<string, unknown>, issues: string[]): RoundTripPermissionsManifestV2 | null {
  const sourceWorkspaceRaw = raw.sourceWorkspace && typeof raw.sourceWorkspace === "object"
    ? raw.sourceWorkspace as Record<string, unknown>
    : {};
  if (!Array.isArray(raw.members)) {
    issues.push("v1 权限清单缺少 members");
    return null;
  }
  const principals: PermissionPrincipal[] = [];
  const workspaceMembers: PermissionWorkspaceMember[] = [];
  const seen = new Set<string>();
  for (const item of raw.members) {
    if (!item || typeof item !== "object") {
      issues.push("v1 权限成员包含无效项");
      continue;
    }
    const row = item as Record<string, unknown>;
    const sourceUserId = String(row.sourceUserId || "").trim();
    const username = String(row.username || "").trim();
    const role = parseWorkspaceRole(row.role);
    if (!sourceUserId || !username || !role || seen.has(sourceUserId)) {
      issues.push("v1 权限成员存在缺失、重复或无效角色");
      continue;
    }
    seen.add(sourceUserId);
    principals.push({
      sourceUserId,
      username,
      displayName: row.displayName == null ? null : String(row.displayName),
      email: row.email == null ? null : String(row.email),
    });
    workspaceMembers.push({ sourceUserId, role });
  }
  const sourceWorkspaceId = String(sourceWorkspaceRaw.id || "").trim();
  if (!sourceWorkspaceId) issues.push("v1 权限清单缺少来源工作区标识");
  return {
    format: ROUND_TRIP_PERMISSION_FORMAT,
    version: ROUND_TRIP_PERMISSION_VERSION,
    exportedAt: String(raw.exportedAt || new Date().toISOString()),
    sourceWorkspace: {
      id: sourceWorkspaceId,
      name: String(sourceWorkspaceRaw.name || "工作区"),
    },
    principals,
    workspaceMembers,
    notebookMembers: [],
  };
}

function normalizeDraftV1(raw: Record<string, unknown>, issues: string[]): RoundTripPermissionsManifestV2 | null {
  const workspace = raw.workspace && typeof raw.workspace === "object"
    ? raw.workspace as Record<string, unknown>
    : {};
  return normalizeV2Manifest({
    ...raw,
    sourceWorkspace: {
      id: String(workspace.sourceWorkspaceId || ""),
      name: String(workspace.name || "工作区"),
    },
  }, issues);
}

async function readPermissionPackage(zipBuffer: Buffer): Promise<ParsedPermissionPackage> {
  const issues: string[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch {
    return { manifest: null, permissions: null, included: false, version: null, issues: ["无法解析数据包"] };
  }

  const mainEntry = await readJsonEntry<PackageManifest>(zip, "manifest.json");
  if (mainEntry.error) issues.push(mainEntry.error);
  const manifest = mainEntry.value;
  if (!manifest || manifest.format !== "nowen-package" || manifest.app !== "nowen-note") {
    issues.push("数据包 manifest 无效");
  }

  const permissionEntry = await readJsonEntry<Record<string, unknown>>(zip, "permissions.json");
  if (!permissionEntry.present) {
    return { manifest, permissions: null, included: false, version: null, issues };
  }
  if (permissionEntry.error || !permissionEntry.value) {
    issues.push(permissionEntry.error || "permissions.json 无法解析");
    return { manifest, permissions: null, included: true, version: null, issues };
  }

  const raw = permissionEntry.value;
  const version = Number(raw.version);
  let permissions: RoundTripPermissionsManifestV2 | null = null;
  if (raw.format === ROUND_TRIP_PERMISSION_FORMAT && version === 2) {
    permissions = normalizeV2Manifest(raw, issues);
  } else if (raw.format === ROUND_TRIP_PERMISSION_FORMAT && version === 1) {
    permissions = normalizeLegacyV1(raw, issues);
  } else if (version === 1 && (Array.isArray(raw.principals) || Array.isArray(raw.workspaceMembers))) {
    permissions = normalizeDraftV1(raw, issues);
  } else {
    issues.push("permissions.json 格式或版本不受支持");
  }

  return { manifest, permissions, included: true, version: Number.isFinite(version) ? version : null, issues };
}

function targetUserByExactEmail(email: string): PublicTargetUser[] {
  if (!email) return [];
  return getDb().prepare(`
    SELECT id, username, displayName, avatarUrl
      FROM users
     WHERE COALESCE(isDisabled, 0) = 0 AND LOWER(COALESCE(email, '')) = ?
     ORDER BY username
  `).all(email) as PublicTargetUser[];
}

function targetUserByExactUsername(username: string): PublicTargetUser[] {
  if (!username) return [];
  return getDb().prepare(`
    SELECT id, username, displayName, avatarUrl
      FROM users
     WHERE COALESCE(isDisabled, 0) = 0 AND LOWER(username) = ?
     ORDER BY username
  `).all(username) as PublicTargetUser[];
}

export async function inspectRoundTripPermissions(
  zipBuffer: Buffer,
  options: Pick<RoundTripPermissionImportOptions, "userId" | "workspaceId">,
): Promise<RoundTripPermissionInspection> {
  const parsed = await readPermissionPackage(zipBuffer);
  if (!parsed.included) {
    return {
      included: false,
      valid: parsed.issues.length === 0,
      canApply: false,
      version: null,
      reason: null,
      counts: { principals: 0, workspaceMembers: 0, notebookMembers: 0 },
      principals: [],
      issues: parsed.issues,
    };
  }

  const workspaceId = options.workspaceId || null;
  const issues = [...parsed.issues];
  if (parsed.manifest?.packageKind === "markdown") issues.push("Markdown 往返包不支持成员与权限恢复");
  if (!workspaceId) issues.push("成员与权限只能恢复到工作区，不能恢复到个人空间");
  if (!parsed.permissions) issues.push("权限清单无效，不能应用");

  const canApply = !!workspaceId
    && !!parsed.permissions
    && canManageRoundTripPermissions(options.userId, workspaceId)
    && issues.length === 0;
  const roleBySource = new Map(parsed.permissions?.workspaceMembers.map((item) => [item.sourceUserId, item.role]) || []);
  const principals = (parsed.permissions?.principals || []).map((principal) => {
    const emailMatches = targetUserByExactEmail(normalizedEmail(principal.email));
    if (emailMatches.length === 1) {
      return { ...principal, workspaceRole: roleBySource.get(principal.sourceUserId) || null, suggestedTarget: emailMatches[0], match: "email" as const };
    }
    if (emailMatches.length > 1) {
      return { ...principal, workspaceRole: roleBySource.get(principal.sourceUserId) || null, suggestedTarget: null, match: "ambiguous" as const };
    }
    const usernameMatches = targetUserByExactUsername(normalizedUsername(principal.username));
    if (usernameMatches.length === 1) {
      return { ...principal, workspaceRole: roleBySource.get(principal.sourceUserId) || null, suggestedTarget: usernameMatches[0], match: "username" as const };
    }
    return {
      ...principal,
      workspaceRole: roleBySource.get(principal.sourceUserId) || null,
      suggestedTarget: null,
      match: usernameMatches.length > 1 ? "ambiguous" as const : "none" as const,
    };
  });

  return {
    included: true,
    valid: !!parsed.permissions && issues.length === 0,
    canApply,
    version: parsed.version,
    reason: !workspaceId
      ? "请选择目标工作区"
      : !canManageRoundTripPermissions(options.userId, workspaceId)
        ? "只有目标工作区 owner/admin 可以恢复成员与权限"
        : issues[0] || null,
    counts: {
      principals: parsed.permissions?.principals.length || 0,
      workspaceMembers: parsed.permissions?.workspaceMembers.length || 0,
      notebookMembers: parsed.permissions?.notebookMembers.length || 0,
    },
    principals,
    issues,
  };
}

function withPermissionInspection(result: any, inspection: RoundTripPermissionInspection): any {
  return {
    ...result,
    package: {
      ...(result?.package || {}),
      permissions: inspection,
    },
  };
}

export async function augmentRoundTripPermissionPreview(
  zipBuffer: Buffer,
  options: Pick<RoundTripPermissionImportOptions, "userId" | "workspaceId">,
  result: any,
): Promise<any> {
  return withPermissionInspection(result, await inspectRoundTripPermissions(zipBuffer, options));
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function insertDynamic(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  getDb().prepare(`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((column) => row[column]));
}

function currentWorkspaceMember(workspaceId: string, userId: string): Record<string, unknown> | null {
  return getDb().prepare("SELECT * FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(workspaceId, userId) as Record<string, unknown> | undefined || null;
}

function currentNotebookMember(notebookId: string, userId: string): Record<string, unknown> | null {
  return getDb().prepare("SELECT * FROM notebook_members WHERE notebookId = ? AND userId = ?")
    .get(notebookId, userId) as Record<string, unknown> | undefined || null;
}

function mappedTargetNotebooks(userId: string, workspaceId: string, sourceInstanceId: string): Map<string, string> {
  const rows = getDb().prepare(`
    SELECT sourceResourceId, targetResourceId
      FROM roundtrip_import_links
     WHERE userId = ? AND workspaceScope = ? AND sourceInstanceId = ? AND resourceType = 'notebook'
  `).all(userId, workspaceScope(workspaceId), sourceInstanceId) as Array<{ sourceResourceId: string; targetResourceId: string }>;
  return new Map(rows.map((row) => [row.sourceResourceId, row.targetResourceId]));
}

function activeTargetUsers(ids: string[]): Map<string, { id: string; username: string }> {
  if (!ids.length) return new Map();
  const rows = getDb().prepare(`SELECT id, username FROM users WHERE COALESCE(isDisabled, 0) = 0 AND id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as Array<{ id: string; username: string }>;
  return new Map(rows.map((row) => [row.id, row]));
}

function mergeResultWarnings(result: any, messages: string[]): any {
  if (!messages.length) return result;
  return {
    ...result,
    warnings: [
      ...(Array.isArray(result?.warnings) ? result.warnings : []),
      ...messages.map((message) => ({ type: "permission_import", message })),
    ],
  };
}

function updateBatchReports(
  userId: string,
  batchId: string,
  result: any,
  inspection: RoundTripPermissionInspection,
): void {
  const batch = getDb().prepare("SELECT previewJson FROM roundtrip_import_batches WHERE id = ? AND userId = ?")
    .get(batchId, userId) as { previewJson: string } | undefined;
  if (!batch) return;
  let preview: any = {};
  try { preview = JSON.parse(batch.previewJson || "{}"); } catch { preview = {}; }
  preview = withPermissionInspection(preview, inspection);
  getDb().prepare("UPDATE roundtrip_import_batches SET previewJson = ?, resultJson = ? WHERE id = ? AND userId = ?")
    .run(JSON.stringify(preview), JSON.stringify(result || {}), batchId, userId);
}

export async function applyRoundTripPermissions(
  zipBuffer: Buffer,
  options: RoundTripPermissionImportOptions,
  result: any,
  batchId?: string,
): Promise<any> {
  const inspection = await inspectRoundTripPermissions(zipBuffer, options);
  let finalResult = withPermissionInspection(result, inspection);
  const parsed = await readPermissionPackage(zipBuffer);
  const requested = options.applyPermissions === true;
  const baseReport = {
    included: inspection.included,
    requested,
    applied: false,
    counts: {
      mappedPrincipals: 0,
      workspaceAdded: 0,
      workspaceUpgraded: 0,
      workspacePreserved: 0,
      notebookAdded: 0,
      notebookUpgraded: 0,
      notebookPreserved: 0,
      skipped: 0,
    },
    issues: [] as string[],
  };

  if (!inspection.included || !requested) {
    finalResult = { ...finalResult, permissionImport: baseReport };
    if (batchId) updateBatchReports(options.userId, batchId, finalResult, inspection);
    return finalResult;
  }

  const workspaceId = options.workspaceId || null;
  if (!parsed.permissions || !parsed.manifest || !workspaceId || !inspection.canApply) {
    baseReport.issues.push(inspection.reason || inspection.issues[0] || "权限清单不可应用");
    baseReport.counts.skipped = inspection.counts.workspaceMembers + inspection.counts.notebookMembers;
    finalResult = mergeResultWarnings({ ...finalResult, permissionImport: baseReport }, baseReport.issues);
    if (batchId) updateBatchReports(options.userId, batchId, finalResult, inspection);
    return finalResult;
  }
  if (!batchId) {
    baseReport.issues.push("导入批次不存在，为保证可撤销性，未应用成员与权限");
    finalResult = mergeResultWarnings({ ...finalResult, permissionImport: baseReport }, baseReport.issues);
    return finalResult;
  }
  if (result?.importBatch?.undoAvailable === false) {
    baseReport.issues.push(result.importBatch?.reason || "本次导入没有安全撤销点，未应用成员与权限");
    baseReport.counts.skipped = inspection.counts.workspaceMembers + inspection.counts.notebookMembers;
    finalResult = mergeResultWarnings({ ...finalResult, permissionImport: baseReport }, baseReport.issues);
    updateBatchReports(options.userId, batchId, finalResult, inspection);
    return finalResult;
  }

  const mappings = Object.fromEntries(Object.entries(options.permissionMappings || {})
    .map(([source, target]) => [String(source || "").trim(), String(target || "").trim()])
    .filter(([source, target]) => source && target)) as RoundTripPermissionMappings;
  const sourceIds = new Set(parsed.permissions.principals.map((item) => item.sourceUserId));
  const duplicateTargets = new Set<string>();
  const seenTargets = new Set<string>();
  for (const [sourceId, targetId] of Object.entries(mappings)) {
    if (!sourceIds.has(sourceId)) {
      delete mappings[sourceId];
      baseReport.issues.push(`忽略未知来源成员映射：${sourceId}`);
      continue;
    }
    if (seenTargets.has(targetId)) duplicateTargets.add(targetId);
    seenTargets.add(targetId);
  }
  if (duplicateTargets.size) {
    baseReport.issues.push("一个目标账号不能同时映射多个来源成员，请调整映射后重试");
    baseReport.counts.skipped = inspection.counts.workspaceMembers + inspection.counts.notebookMembers;
    finalResult = mergeResultWarnings({ ...finalResult, permissionImport: baseReport }, baseReport.issues);
    updateBatchReports(options.userId, batchId, finalResult, inspection);
    return finalResult;
  }

  const targets = activeTargetUsers(Object.values(mappings));
  for (const [sourceId, targetId] of Object.entries(mappings)) {
    if (!targets.has(targetId)) {
      delete mappings[sourceId];
      baseReport.issues.push(`目标账号不存在或已停用，已跳过来源成员：${sourceId}`);
    }
  }
  baseReport.counts.mappedPrincipals = Object.keys(mappings).length;

  const sourceInstanceId = String(parsed.manifest.sourceInstanceId || "").trim();
  const notebookMap = sourceInstanceId
    ? mappedTargetNotebooks(options.userId, workspaceId, sourceInstanceId)
    : new Map<string, string>();
  if (parsed.permissions.notebookMembers.length && !notebookMap.size) {
    baseReport.issues.push("未找到来源目录到目标目录的稳定映射，笔记本直接授权将被跳过");
  }

  const undoRows: PermissionUndoRow[] = [];
  const tx = getDb().transaction(() => {
    for (const member of parsed.permissions!.workspaceMembers) {
      const targetUserId = mappings[member.sourceUserId];
      if (!targetUserId) {
        baseReport.counts.skipped += 1;
        continue;
      }
      const before = currentWorkspaceMember(workspaceId, targetUserId);
      const desired: WorkspaceRole = member.role === "owner" ? "admin" : member.role;
      if (!before) {
        getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
          .run(workspaceId, targetUserId, desired);
        baseReport.counts.workspaceAdded += 1;
      } else if (String(before.role) === "owner" || workspaceRoleRank(String(before.role)) >= workspaceRoleRank(desired)) {
        baseReport.counts.workspacePreserved += 1;
        continue;
      } else {
        getDb().prepare("UPDATE workspace_members SET role = ? WHERE workspaceId = ? AND userId = ?")
          .run(desired, workspaceId, targetUserId);
        baseReport.counts.workspaceUpgraded += 1;
      }
      const after = currentWorkspaceMember(workspaceId, targetUserId)!;
      undoRows.push({
        table: "workspace_members",
        key: { workspaceId, userId: targetUserId },
        before,
        after,
        afterHash: hashRow(after),
      });
    }

    for (const member of parsed.permissions!.notebookMembers) {
      const targetUserId = mappings[member.sourceUserId];
      const targetNotebookId = notebookMap.get(member.sourceNotebookId);
      if (!targetUserId || !targetNotebookId) {
        baseReport.counts.skipped += 1;
        continue;
      }
      const targetNotebook = getDb().prepare("SELECT id, workspaceId FROM notebooks WHERE id = ?")
        .get(targetNotebookId) as { id: string; workspaceId: string | null } | undefined;
      if (!targetNotebook || targetNotebook.workspaceId !== workspaceId) {
        baseReport.counts.skipped += 1;
        baseReport.issues.push(`目标目录映射无效，已跳过授权：${member.sourceNotebookId}`);
        continue;
      }

      const before = currentNotebookMember(targetNotebookId, targetUserId);
      const desired: "editor" | "viewer" = member.role === "viewer" ? "viewer" : "editor";
      if (!before || String(before.status) === "removed") {
        if (before) {
          getDb().prepare(`
            UPDATE notebook_members
               SET role = ?, status = 'active', allowDownload = ?, allowReshare = ?, source = 'manual', sourceId = NULL,
                   invitedBy = ?, updatedAt = datetime('now')
             WHERE notebookId = ? AND userId = ?
          `).run(desired, member.allowDownload ? 1 : 0, member.allowReshare ? 1 : 0, options.userId, targetNotebookId, targetUserId);
        } else {
          getDb().prepare(`
            INSERT INTO notebook_members (
              id, notebookId, userId, role, status, allowDownload, allowReshare, source, sourceId, invitedBy
            ) VALUES (?, ?, ?, ?, 'active', ?, ?, 'manual', NULL, ?)
          `).run(uuid(), targetNotebookId, targetUserId, desired, member.allowDownload ? 1 : 0, member.allowReshare ? 1 : 0, options.userId);
        }
        baseReport.counts.notebookAdded += 1;
      } else if (String(before.role) === "owner") {
        baseReport.counts.notebookPreserved += 1;
        continue;
      } else {
        const nextRole = notebookRoleRank(String(before.role)) >= notebookRoleRank(desired) ? String(before.role) : desired;
        const nextDownload = Number(before.allowDownload) === 1 || member.allowDownload ? 1 : 0;
        const nextReshare = Number(before.allowReshare) === 1 || member.allowReshare ? 1 : 0;
        if (
          nextRole === String(before.role)
          && nextDownload === Number(before.allowDownload)
          && nextReshare === Number(before.allowReshare)
        ) {
          baseReport.counts.notebookPreserved += 1;
          continue;
        }
        getDb().prepare(`
          UPDATE notebook_members
             SET role = ?, allowDownload = ?, allowReshare = ?, updatedAt = datetime('now')
           WHERE notebookId = ? AND userId = ?
        `).run(nextRole, nextDownload, nextReshare, targetNotebookId, targetUserId);
        baseReport.counts.notebookUpgraded += 1;
      }
      const after = currentNotebookMember(targetNotebookId, targetUserId)!;
      undoRows.push({
        table: "notebook_members",
        key: { notebookId: targetNotebookId, userId: targetUserId },
        before,
        after,
        afterHash: hashRow(after),
      });
    }

    baseReport.applied = undoRows.length > 0;
    const batch = getDb().prepare("SELECT undoStateJson, previewJson FROM roundtrip_import_batches WHERE id = ? AND userId = ?")
      .get(batchId, options.userId) as { undoStateJson: string; previewJson: string } | undefined;
    if (!batch) throw new Error("导入批次不存在，无法保存权限撤销点");
    let undoState: Record<string, unknown> = {};
    let previewState: any = {};
    try { undoState = JSON.parse(batch.undoStateJson || "{}"); } catch { undoState = {}; }
    try { previewState = JSON.parse(batch.previewJson || "{}"); } catch { previewState = {}; }
    (undoState as any).permissionMembers = {
      version: 2,
      workspaceId,
      rows: undoRows,
    } satisfies PermissionUndoState;
    finalResult = { ...finalResult, permissionImport: baseReport };
    finalResult = mergeResultWarnings(finalResult, baseReport.issues);
    previewState = withPermissionInspection(previewState, inspection);
    getDb().prepare(`
      UPDATE roundtrip_import_batches
         SET undoStateJson = ?, previewJson = ?, resultJson = ?
       WHERE id = ? AND userId = ?
    `).run(JSON.stringify(undoState), JSON.stringify(previewState), JSON.stringify(finalResult), batchId, options.userId);
  });

  try {
    tx();
  } catch (error) {
    baseReport.applied = false;
    baseReport.issues.push(`成员与权限恢复失败，内容已保留且权限变更已回滚：${error instanceof Error ? error.message : String(error)}`);
    finalResult = mergeResultWarnings({ ...withPermissionInspection(result, inspection), permissionImport: baseReport }, baseReport.issues);
    updateBatchReports(options.userId, batchId, finalResult, inspection);
  }
  return finalResult;
}

function rowForUndo(item: PermissionUndoRow): Record<string, unknown> | null {
  return item.table === "workspace_members"
    ? currentWorkspaceMember(item.key.workspaceId, item.key.userId)
    : currentNotebookMember(item.key.notebookId, item.key.userId);
}

export function readPermissionUndoState(userId: string, batchId: string): PermissionUndoState | null {
  const row = getDb().prepare("SELECT undoStateJson FROM roundtrip_import_batches WHERE id = ? AND userId = ?")
    .get(batchId, userId) as { undoStateJson: string } | undefined;
  if (!row) return null;
  try {
    const state = JSON.parse(row.undoStateJson || "{}") as { permissionMembers?: PermissionUndoState };
    return state.permissionMembers?.version === 2 ? state.permissionMembers : null;
  } catch {
    return null;
  }
}

export function validatePermissionUndoState(state: PermissionUndoState): string[] {
  const conflicts: string[] = [];
  for (const item of state.rows) {
    const current = rowForUndo(item);
    if (hashRow(current) !== item.afterHash) {
      const target = item.table === "workspace_members"
        ? `工作区成员 ${item.key.userId}`
        : `笔记本成员 ${item.key.notebookId}/${item.key.userId}`;
      conflicts.push(`${target} 已在导入后发生变化`);
    }
  }
  return conflicts;
}

function replacePermissionRows(state: PermissionUndoState, direction: "before" | "after"): void {
  const rows = direction === "before" ? state.rows.slice().reverse() : state.rows;
  const tx = getDb().transaction(() => {
    for (const item of rows) {
      if (item.table === "workspace_members") {
        getDb().prepare("DELETE FROM workspace_members WHERE workspaceId = ? AND userId = ?")
          .run(item.key.workspaceId, item.key.userId);
      } else {
        getDb().prepare("DELETE FROM notebook_members WHERE notebookId = ? AND userId = ?")
          .run(item.key.notebookId, item.key.userId);
      }
      const row = direction === "before" ? item.before : item.after;
      if (row) insertDynamic(item.table, row);
    }
  });
  tx();
}

export function restorePermissionUndoState(state: PermissionUndoState): void {
  replacePermissionRows(state, "before");
}

export function restorePermissionAppliedState(state: PermissionUndoState): void {
  replacePermissionRows(state, "after");
}

export async function addPermissionsToNowenPackageExport<TStats extends object>(args: {
  result: { buffer: Buffer; filename: string; stats: TStats };
  userId: string;
  workspaceId: string;
}): Promise<{
  buffer: Buffer;
  filename: string;
  stats: TStats & {
    permissionPrincipals: number;
    workspaceMembers: number;
    notebookMembers: number;
  };
}> {
  if (!canManageRoundTripPermissions(args.userId, args.workspaceId)) {
    throw new Error("只有工作区 owner/admin 可以导出成员与权限清单");
  }
  const zip = await JSZip.loadAsync(args.result.buffer);
  const manifestEntry = await readJsonEntry<Record<string, unknown>>(zip, "manifest.json");
  const manifest = manifestEntry.value;
  if (!manifest || manifest.packageKind === "markdown") throw new Error("只有 Nowen 无损包支持权限导出");
  const treeEntry = await readJsonEntry<{ nodes?: Array<{ sourceId?: string }> }>(zip, "tree.json");
  const notebookIds = (treeEntry.value?.nodes || []).map((item) => String(item.sourceId || "")).filter(Boolean);
  const workspace = getDb().prepare("SELECT id, name FROM workspaces WHERE id = ?").get(args.workspaceId) as
    | { id: string; name: string }
    | undefined;
  if (!workspace) throw new Error("工作区不存在");

  const workspaceMembers = getDb().prepare(`
    SELECT m.userId AS sourceUserId, m.role, m.joinedAt
      FROM workspace_members m
      JOIN users u ON u.id = m.userId
     WHERE m.workspaceId = ?
     ORDER BY m.joinedAt, m.userId
  `).all(args.workspaceId) as Array<{ sourceUserId: string; role: WorkspaceRole; joinedAt: string }>;
  const notebookMembers = notebookIds.length
    ? getDb().prepare(`
        SELECT nm.notebookId AS sourceNotebookId, nm.userId AS sourceUserId, nm.role,
               nm.allowDownload, nm.allowReshare
          FROM notebook_members nm
          JOIN users u ON u.id = nm.userId
         WHERE nm.status != 'removed' AND nm.notebookId IN (${notebookIds.map(() => "?").join(",")})
         ORDER BY nm.notebookId, nm.userId
      `).all(...notebookIds) as Array<{
        sourceNotebookId: string;
        sourceUserId: string;
        role: NotebookRole;
        allowDownload: number;
        allowReshare: number;
      }>
    : [];
  const principalIds = [...new Set([
    ...workspaceMembers.map((item) => item.sourceUserId),
    ...notebookMembers.map((item) => item.sourceUserId),
  ])];
  const principals = principalIds.length
    ? getDb().prepare(`
        SELECT id AS sourceUserId, username, displayName, email
          FROM users
         WHERE id IN (${principalIds.map(() => "?").join(",")})
         ORDER BY username
      `).all(...principalIds) as PermissionPrincipal[]
    : [];

  const permissions: RoundTripPermissionsManifestV2 = {
    format: ROUND_TRIP_PERMISSION_FORMAT,
    version: ROUND_TRIP_PERMISSION_VERSION,
    exportedAt: new Date().toISOString(),
    sourceWorkspace: { id: workspace.id, name: workspace.name },
    principals,
    workspaceMembers: workspaceMembers.map((item) => ({
      sourceUserId: item.sourceUserId,
      role: item.role,
      joinedAt: item.joinedAt,
    })),
    notebookMembers: notebookMembers.map((item) => ({
      sourceNotebookId: item.sourceNotebookId,
      sourceUserId: item.sourceUserId,
      role: item.role,
      allowDownload: item.allowDownload !== 0,
      allowReshare: item.allowReshare === 1,
    })),
  };
  zip.file("permissions.json", JSON.stringify(permissions, null, 2));
  manifest.permissions = {
    included: true,
    file: "permissions.json",
    format: ROUND_TRIP_PERMISSION_FORMAT,
    version: ROUND_TRIP_PERMISSION_VERSION,
    principals: principals.length,
    workspaceMembers: workspaceMembers.length,
    notebookMembers: notebookMembers.length,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  return {
    ...args.result,
    buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }),
    stats: {
      ...args.result.stats,
      permissionPrincipals: principals.length,
      workspaceMembers: workspaceMembers.length,
      notebookMembers: notebookMembers.length,
    },
  };
}

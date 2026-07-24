import JSZip from "jszip";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole, hasRole, isSystemAdmin } from "../middleware/acl";
import { createStableNowenPackageExport } from "./nowenPackageExportStable";

export const ROUND_TRIP_PERMISSIONS_VERSION = 1;

export type ExportedWorkspaceRole = "owner" | "admin" | "editor" | "viewer";

export interface RoundTripPermissionMember {
  sourceUserId: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: ExportedWorkspaceRole;
}

export interface RoundTripPermissionsManifest {
  format: "nowen-workspace-permissions";
  version: 1;
  exportedAt: string;
  sourceWorkspace: {
    id: string;
    name: string;
  };
  members: RoundTripPermissionMember[];
}

export interface PermissionMappingSuggestion {
  sourceUserId: string;
  username: string;
  email: string | null;
  sourceRole: ExportedWorkspaceRole;
  suggestedTargetUserId: string | null;
  suggestedTargetUsername: string | null;
  match: "email" | "username" | "none" | "ambiguous";
  appliedRole: Exclude<ExportedWorkspaceRole, "owner">;
  warning?: string;
}

export interface PermissionMappingInput {
  sourceUserId: string;
  targetUserId: string;
  role?: Exclude<ExportedWorkspaceRole, "owner">;
}

function assertWorkspaceManager(userId: string, workspaceId: string): void {
  if (isSystemAdmin(userId)) return;
  if (!hasRole(getUserWorkspaceRole(workspaceId, userId), "admin")) {
    const error = new Error("仅目标工作区所有者、管理员或系统管理员可迁移成员权限");
    (error as Error & { code?: string; status?: number }).code = "WORKSPACE_ADMIN_REQUIRED";
    (error as Error & { code?: string; status?: number }).status = 403;
    throw error;
  }
}

function normalizeRole(role: unknown): ExportedWorkspaceRole {
  return role === "owner" || role === "admin" || role === "editor" || role === "viewer"
    ? role
    : "viewer";
}

function roleForApply(role: ExportedWorkspaceRole): Exclude<ExportedWorkspaceRole, "owner"> {
  return role === "owner" ? "admin" : role;
}

function roleRank(role: string | null | undefined): number {
  switch (role) {
    case "owner": return 4;
    case "admin": return 3;
    case "editor": return 2;
    case "viewer": return 1;
    default: return 0;
  }
}

export function buildRoundTripPermissionsManifest(userId: string, workspaceId: string): RoundTripPermissionsManifest {
  assertWorkspaceManager(userId, workspaceId);
  const db = getDb();
  const workspace = db.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(workspaceId) as
    | { id: string; name: string }
    | undefined;
  if (!workspace) {
    const error = new Error("工作区不存在");
    (error as Error & { code?: string; status?: number }).code = "WORKSPACE_NOT_FOUND";
    (error as Error & { code?: string; status?: number }).status = 404;
    throw error;
  }

  const rows = db.prepare(`
    SELECT m.userId AS sourceUserId, m.role, u.username, u.email, u.displayName
      FROM workspace_members m
      JOIN users u ON u.id = m.userId
     WHERE m.workspaceId = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
              lower(u.username), u.id
  `).all(workspaceId) as Array<{
    sourceUserId: string;
    role: string;
    username: string;
    email: string | null;
    displayName: string | null;
  }>;

  return {
    format: "nowen-workspace-permissions",
    version: ROUND_TRIP_PERMISSIONS_VERSION,
    exportedAt: new Date().toISOString(),
    sourceWorkspace: workspace,
    members: rows.map((row) => ({
      sourceUserId: row.sourceUserId,
      username: row.username,
      email: row.email || null,
      displayName: row.displayName || null,
      role: normalizeRole(row.role),
    })),
  };
}

export function validateRoundTripPermissionsManifest(value: unknown): RoundTripPermissionsManifest {
  const manifest = value as Partial<RoundTripPermissionsManifest> | null;
  if (!manifest || manifest.format !== "nowen-workspace-permissions" || manifest.version !== 1) {
    const error = new Error("权限清单格式或版本不受支持");
    (error as Error & { code?: string; status?: number }).code = "INVALID_PERMISSION_MANIFEST";
    (error as Error & { code?: string; status?: number }).status = 400;
    throw error;
  }
  if (!manifest.sourceWorkspace?.id || !Array.isArray(manifest.members)) {
    const error = new Error("权限清单缺少工作区或成员信息");
    (error as Error & { code?: string; status?: number }).code = "INVALID_PERMISSION_MANIFEST";
    (error as Error & { code?: string; status?: number }).status = 400;
    throw error;
  }
  const seen = new Set<string>();
  const members = manifest.members.map((member) => {
    if (!member?.sourceUserId || !member.username || seen.has(String(member.sourceUserId))) {
      const error = new Error("权限清单包含无效或重复成员");
      (error as Error & { code?: string; status?: number }).code = "INVALID_PERMISSION_MEMBER";
      (error as Error & { code?: string; status?: number }).status = 400;
      throw error;
    }
    seen.add(String(member.sourceUserId));
    return {
      sourceUserId: String(member.sourceUserId),
      username: String(member.username),
      email: member.email ? String(member.email) : null,
      displayName: member.displayName ? String(member.displayName) : null,
      role: normalizeRole(member.role),
    };
  });
  return {
    format: "nowen-workspace-permissions",
    version: 1,
    exportedAt: String(manifest.exportedAt || ""),
    sourceWorkspace: {
      id: String(manifest.sourceWorkspace.id),
      name: String(manifest.sourceWorkspace.name || ""),
    },
    members,
  };
}

export async function createNowenPackageWithPermissions(params: {
  userId: string;
  workspaceId: string;
  notebookId?: string;
  includeSubNotebooks?: boolean;
  includeTrashed?: boolean;
}): Promise<Awaited<ReturnType<typeof createStableNowenPackageExport>>> {
  const manifest = buildRoundTripPermissionsManifest(params.userId, params.workspaceId);
  const result = await createStableNowenPackageExport(params);
  const zip = await JSZip.loadAsync(result.buffer);
  zip.file("permissions.json", JSON.stringify(manifest, null, 2));
  const mainManifest = zip.file("manifest.json");
  if (mainManifest) {
    const parsed = JSON.parse(await mainManifest.async("string")) as Record<string, unknown>;
    parsed.permissions = {
      included: true,
      file: "permissions.json",
      version: ROUND_TRIP_PERMISSIONS_VERSION,
      memberCount: manifest.members.length,
    };
    zip.file("manifest.json", JSON.stringify(parsed, null, 2));
  }
  return { ...result, buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) };
}

export function previewRoundTripPermissionMappings(
  userId: string,
  workspaceId: string,
  manifestValue: unknown,
): PermissionMappingSuggestion[] {
  assertWorkspaceManager(userId, workspaceId);
  const manifest = validateRoundTripPermissionsManifest(manifestValue);
  const db = getDb();
  const users = db.prepare("SELECT id, username, email FROM users WHERE COALESCE(isDisabled, 0) = 0 ORDER BY id").all() as Array<{
    id: string;
    username: string;
    email: string | null;
  }>;

  return manifest.members.map((source) => {
    const emailMatches = source.email
      ? users.filter((target) => target.email && target.email.toLowerCase() === source.email!.toLowerCase())
      : [];
    const usernameMatches = users.filter((target) => target.username.toLowerCase() === source.username.toLowerCase());
    const candidates = emailMatches.length ? emailMatches : usernameMatches;
    const match: PermissionMappingSuggestion["match"] = candidates.length > 1
      ? "ambiguous"
      : candidates.length === 1
        ? (emailMatches.length ? "email" : "username")
        : "none";
    const candidate = candidates.length === 1 ? candidates[0] : null;
    return {
      sourceUserId: source.sourceUserId,
      username: source.username,
      email: source.email,
      sourceRole: source.role,
      suggestedTargetUserId: candidate?.id || null,
      suggestedTargetUsername: candidate?.username || null,
      match,
      appliedRole: roleForApply(source.role),
      warning: source.role === "owner" ? "源工作区 owner 将降级为 admin；目标 owner 不会被替换" : undefined,
    };
  });
}

export function applyRoundTripPermissionMappings(params: {
  actorUserId: string;
  workspaceId: string;
  manifest: unknown;
  mappings: PermissionMappingInput[];
}): { applied: number; skipped: number; items: Array<{ sourceUserId: string; targetUserId: string; role: string }> } {
  assertWorkspaceManager(params.actorUserId, params.workspaceId);
  const manifest = validateRoundTripPermissionsManifest(params.manifest);
  const sourceById = new Map(manifest.members.map((member) => [member.sourceUserId, member]));
  const db = getDb();
  const targetWorkspace = db.prepare("SELECT id, ownerId FROM workspaces WHERE id = ?").get(params.workspaceId) as
    | { id: string; ownerId: string }
    | undefined;
  if (!targetWorkspace) throw new Error("工作区不存在");

  const items: Array<{ sourceUserId: string; targetUserId: string; role: string }> = [];
  let skipped = 0;
  const usedTargets = new Set<string>();
  const transaction = db.transaction(() => {
    for (const mapping of params.mappings || []) {
      const source = sourceById.get(String(mapping.sourceUserId || ""));
      const targetUserId = String(mapping.targetUserId || "");
      if (!source || !targetUserId || usedTargets.has(targetUserId)) {
        skipped += 1;
        continue;
      }
      usedTargets.add(targetUserId);
      const target = db.prepare("SELECT id FROM users WHERE id = ? AND COALESCE(isDisabled, 0) = 0").get(targetUserId) as { id: string } | undefined;
      if (!target || targetUserId === targetWorkspace.ownerId) {
        skipped += 1;
        continue;
      }
      const desired = mapping.role === "admin" || mapping.role === "editor" || mapping.role === "viewer"
        ? mapping.role
        : roleForApply(source.role);
      const existing = db.prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
        .get(params.workspaceId, targetUserId) as { role: string } | undefined;
      if (existing && roleRank(existing.role) >= roleRank(desired)) {
        skipped += 1;
        continue;
      }
      if (existing) {
        db.prepare("UPDATE workspace_members SET role = ? WHERE workspaceId = ? AND userId = ?")
          .run(desired, params.workspaceId, targetUserId);
      } else {
        db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
          .run(params.workspaceId, targetUserId, desired);
      }
      items.push({ sourceUserId: source.sourceUserId, targetUserId, role: desired });
    }
  });
  transaction();
  return { applied: items.length, skipped, items };
}

export function parsePermissionsFromPackageBuffer(buffer: Buffer): Promise<RoundTripPermissionsManifest | null> {
  return JSZip.loadAsync(buffer).then(async (zip) => {
    const entry = zip.file("permissions.json");
    if (!entry) return null;
    return validateRoundTripPermissionsManifest(JSON.parse(await entry.async("string")));
  });
}

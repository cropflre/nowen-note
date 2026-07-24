import JSZip from "jszip";
import {
  roundTripPermissionMappingRepository,
  type RoundTripWorkspaceAccessRow,
} from "../repositories/roundTripPermissionMappingRepository";
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

function permissionError(message: string, code: string, status: number): Error {
  const error = new Error(message);
  (error as Error & { code?: string; status?: number }).code = code;
  (error as Error & { code?: string; status?: number }).status = status;
  return error;
}

async function assertWorkspaceManager(
  userId: string,
  workspaceId: string,
): Promise<RoundTripWorkspaceAccessRow> {
  const access = await roundTripPermissionMappingRepository.getWorkspaceAccess(userId, workspaceId);
  if (!access) {
    throw permissionError("工作区不存在", "WORKSPACE_NOT_FOUND", 404);
  }
  if (
    access.actorSystemRole !== "admin"
    && access.actorWorkspaceRole !== "owner"
    && access.actorWorkspaceRole !== "admin"
  ) {
    throw permissionError(
      "仅目标工作区所有者、管理员或系统管理员可迁移成员权限",
      "WORKSPACE_ADMIN_REQUIRED",
      403,
    );
  }
  return access;
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

export async function buildRoundTripPermissionsManifest(
  userId: string,
  workspaceId: string,
): Promise<RoundTripPermissionsManifest> {
  const workspace = await assertWorkspaceManager(userId, workspaceId);
  const rows = await roundTripPermissionMappingRepository.listWorkspaceMembers(workspaceId);

  return {
    format: "nowen-workspace-permissions",
    version: ROUND_TRIP_PERMISSIONS_VERSION,
    exportedAt: new Date().toISOString(),
    sourceWorkspace: { id: workspace.id, name: workspace.name },
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
    throw permissionError("权限清单格式或版本不受支持", "INVALID_PERMISSION_MANIFEST", 400);
  }
  if (!manifest.sourceWorkspace?.id || !Array.isArray(manifest.members)) {
    throw permissionError("权限清单缺少工作区或成员信息", "INVALID_PERMISSION_MANIFEST", 400);
  }
  const seen = new Set<string>();
  const members = manifest.members.map((member) => {
    const sourceUserId = String(member?.sourceUserId || "");
    if (!sourceUserId || !member?.username || seen.has(sourceUserId)) {
      throw permissionError("权限清单包含无效或重复成员", "INVALID_PERMISSION_MEMBER", 400);
    }
    seen.add(sourceUserId);
    return {
      sourceUserId,
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
  const manifest = await buildRoundTripPermissionsManifest(params.userId, params.workspaceId);
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

export async function previewRoundTripPermissionMappings(
  userId: string,
  workspaceId: string,
  manifestValue: unknown,
): Promise<PermissionMappingSuggestion[]> {
  await assertWorkspaceManager(userId, workspaceId);
  const manifest = validateRoundTripPermissionsManifest(manifestValue);
  const users = await roundTripPermissionMappingRepository.listTargetUsers();

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

export async function applyRoundTripPermissionMappings(params: {
  actorUserId: string;
  workspaceId: string;
  manifest: unknown;
  mappings: PermissionMappingInput[];
}): Promise<{
  applied: number;
  skipped: number;
  items: Array<{ sourceUserId: string; targetUserId: string; role: string }>;
}> {
  const targetWorkspace = await assertWorkspaceManager(params.actorUserId, params.workspaceId);
  const manifest = validateRoundTripPermissionsManifest(params.manifest);
  const sourceById = new Map(manifest.members.map((member) => [member.sourceUserId, member]));
  const targetIds = [...new Set((params.mappings || [])
    .map((mapping) => String(mapping.targetUserId || ""))
    .filter(Boolean))];
  const existingTargetIds = await roundTripPermissionMappingRepository.listExistingUserIds(targetIds);
  const existingRoles = await roundTripPermissionMappingRepository.listWorkspaceMemberRoles(
    params.workspaceId,
    targetIds,
  );

  const items: Array<{ sourceUserId: string; targetUserId: string; role: string }> = [];
  let skipped = 0;
  const usedTargets = new Set<string>();
  for (const mapping of params.mappings || []) {
    const source = sourceById.get(String(mapping.sourceUserId || ""));
    const targetUserId = String(mapping.targetUserId || "");
    if (
      !source
      || !targetUserId
      || usedTargets.has(targetUserId)
      || !existingTargetIds.has(targetUserId)
      || targetUserId === targetWorkspace.ownerId
    ) {
      skipped += 1;
      continue;
    }
    usedTargets.add(targetUserId);
    const desired = mapping.role === "admin" || mapping.role === "editor" || mapping.role === "viewer"
      ? mapping.role
      : roleForApply(source.role);
    if (roleRank(existingRoles.get(targetUserId)) >= roleRank(desired)) {
      skipped += 1;
      continue;
    }
    items.push({ sourceUserId: source.sourceUserId, targetUserId, role: desired });
  }

  await roundTripPermissionMappingRepository.upsertWorkspaceMembers(
    params.workspaceId,
    items.map(({ targetUserId, role }) => ({ targetUserId, role })),
  );
  return { applied: items.length, skipped, items };
}

export function parsePermissionsFromPackageBuffer(buffer: Buffer): Promise<RoundTripPermissionsManifest | null> {
  return JSZip.loadAsync(buffer).then(async (zip) => {
    const entry = zip.file("permissions.json");
    if (!entry) return null;
    return validateRoundTripPermissionsManifest(JSON.parse(await entry.async("string")));
  });
}

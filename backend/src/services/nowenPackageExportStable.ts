import {
  createNowenPackageExport,
  type PreparedMarkdownPackageNote,
} from "./nowenPackageExport";
import { ensureNowenInstanceEnvironment } from "./nowenInstanceIdentity";
import { addPermissionsToNowenPackageExport } from "./roundTripPermissionTransfer";

export type { PreparedMarkdownPackageNote };

type StableExportParams = Parameters<typeof createNowenPackageExport>[0] & {
  includePermissions?: boolean;
};

/**
 * Ensure all user-facing Round-trip packages carry a stable sourceInstanceId.
 * Permission/member data remains an explicit admin-only extension and is omitted by default.
 */
export async function createStableNowenPackageExport(
  params: StableExportParams,
): Promise<Awaited<ReturnType<typeof createNowenPackageExport>>> {
  ensureNowenInstanceEnvironment();
  const { includePermissions = false, ...baseParams } = params;
  const result = await createNowenPackageExport(baseParams);
  if (!includePermissions) return result;
  if (!baseParams.workspaceId) throw new Error("成员与权限只能随工作区 Nowen 无损包导出");
  return addPermissionsToNowenPackageExport({
    result,
    userId: baseParams.userId,
    workspaceId: baseParams.workspaceId,
  });
}

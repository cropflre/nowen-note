import {
  createNowenPackageExport,
  type PreparedMarkdownPackageNote,
} from "./nowenPackageExport";
import { ensureNowenInstanceEnvironmentAsync } from "./nowenInstanceIdentity";

export type { PreparedMarkdownPackageNote };

/**
 * Ensure all user-facing Round-trip packages carry a stable sourceInstanceId.
 * The underlying exporter keeps its existing ZIP layout and streaming/storage behavior.
 */
export async function createStableNowenPackageExport(
  params: Parameters<typeof createNowenPackageExport>[0],
): ReturnType<typeof createNowenPackageExport> {
  await ensureNowenInstanceEnvironmentAsync();
  return createNowenPackageExport(params);
}

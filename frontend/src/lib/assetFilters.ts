import type { AssetFilters } from "@/types";
import type { AssetCategory } from "./fileExplorerModel";

export function explorerAssetFilters(
  category: AssetCategory,
  folderId: string | null,
  query: string,
  extra: AssetFilters,
): AssetFilters {
  const filters = { ...extra, q: query || undefined };
  if (folderId) filters.folderId = folderId;
  if (category === "unorganized") filters.folderId = "__unarchived";
  if (category === "image") filters.category = "image";
  if (["document", "video", "audio", "archive"].includes(category))
    filters.fileKind = category as AssetFilters["fileKind"];
  if (category === "recent") filters.recentDays = 7;
  return filters;
}

export function assetDateBoundary(
  date: string,
  end: boolean,
): string | undefined {
  return date
    ? new Date(`${date}T${end ? "23:59:59.999" : "00:00:00.000"}`).toISOString()
    : undefined;
}
export function assetLocalDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

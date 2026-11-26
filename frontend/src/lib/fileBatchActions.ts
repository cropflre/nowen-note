import type { TFunction } from "i18next";
import { confirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { chunkIds, FILE_BATCH_CHUNK_LIMIT } from "@/lib/fileExplorerModel";
import { toast } from "@/lib/toast";

export async function runChunkedBatchRemove({
  ids,
  isCurrent,
  t,
}: {
  ids: string[];
  isCurrent: () => boolean;
  t: TFunction;
}): Promise<{ confirmed: boolean; deleted: number; failed: Array<{ id: string; reason: string }> }> {
  if (!ids.length) return { confirmed: false, deleted: 0, failed: [] };
  const ok = await confirm({
    title: t("assetTrash.move"),
    description: t("assetTrash.moveHint", { count: ids.length }),
    danger: true,
  });
  if (!ok || !isCurrent()) return { confirmed: false, deleted: 0, failed: [] };

  let deleted = 0;
  const failed: Array<{ id: string; reason: string }> = [];
  for (const batch of chunkIds(ids, FILE_BATCH_CHUNK_LIMIT)) {
    const result = await api.files.batchRemove(batch);
    if (!isCurrent()) return { confirmed: true, deleted, failed };
    deleted += result.deleted;
    failed.push(...result.failed);
  }
  if (failed.length) toast.error(failed.map((failure) => failure.reason).join("; "));
  if (deleted) toast.success(t("assetTrash.moved", { count: deleted }));
  window.dispatchEvent(new CustomEvent("nowen:storage-changed", { detail: { reason: "asset-trash" } }));
  return { confirmed: true, deleted, failed };
}

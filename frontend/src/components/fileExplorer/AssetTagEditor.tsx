import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, getCurrentWorkspace, getServerUrl } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import type { AssetOrganization, AssetTag } from "@/types";

const identity = () =>
  `${getOfflineQueueStorageKey()}:${getServerUrl()}:${getCurrentWorkspace()}`;
export default function AssetTagEditor({
  ids,
  onChanged,
  onOpen,
}: {
  ids: string[];
  onChanged?: () => void;
  onOpen?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<AssetOrganization | null>(null);
  const [assigned, setAssigned] = useState<AssetTag[]>([]);
  const [duplicates, setDuplicates] = useState<
    Array<{ id: string; filename: string }>
  >([]);
  const [canManage, setCanManage] = useState(false);
  const [search, setSearch] = useState("");
  const [tagPage, setTagPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [scope] = useState(identity);
  const key = ids.join(",");
  useEffect(() => {
    let stale = false;
    setError("");
    const requestedIds = key.split(",");
    api.files.organization
      .list({ q: search, tagPage })
      .then(async (organization) => {
        if (stale || identity() !== scope) return;
        const detail =
          organization.supported && requestedIds.length === 1
            ? await api.files.organization.get(requestedIds[0])
            : null;
        if (stale || identity() !== scope) return;
        setState(organization);
        setAssigned(detail?.tags || []);
        setDuplicates(detail?.duplicates || []);
        setCanManage(detail ? detail.canManage : organization.canManageTags);
      })
      .catch((failure: unknown) => {
        if (!stale && identity() === scope)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => {
      stale = true;
    };
  }, [key, revision, scope, search, tagPage]);
  const change = async (tagId: string, operation: "add" | "remove") => {
    if (identity() !== scope || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.files.organization.tagFiles(ids, [tagId], operation);
      if (identity() !== scope) return;
      setRevision((value) => value + 1);
      onChanged?.();
    } catch (failure: unknown) {
      if (identity() === scope)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (!search.trim() || identity() !== scope || busy) return;
    const existing = state?.tags.find(
      (tag) =>
        tag.name.normalize("NFKC").toLocaleLowerCase() ===
        search.trim().normalize("NFKC").toLocaleLowerCase(),
    );
    if (existing) {
      await change(existing.id, "add");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { tag } = await api.files.organization.createTag(search.trim());
      if (identity() !== scope) return;
      await api.files.organization.tagFiles(ids, [tag.id], "add");
      if (identity() !== scope) return;
      setSearch("");
      setRevision((value) => value + 1);
      onChanged?.();
    } catch (failure: unknown) {
      if (identity() === scope)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label={t("assetOrganization.tags")}
      className="space-y-3 rounded-lg border border-app-border p-3 text-xs"
    >
      <h3 className="font-semibold text-tx-primary">
        {t("assetOrganization.tags")}
      </h3>
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
      {state?.supported === false ? (
        <p className="text-tx-secondary">
          {t("assetOrganization.nativeUnavailable")}
        </p>
      ) : !state ? (
        <p>{t("common.loading")}</p>
      ) : (
        <>
          {ids.length === 1 && (
            <div className="flex flex-wrap gap-2">
              {assigned.length ? (
                assigned.map((tag) => (
                  <button
                    key={tag.id}
                    disabled={!canManage || busy}
                    className="rounded border border-app-border px-2 py-1 disabled:opacity-60"
                    title={t("assetOrganization.removeTag")}
                    onClick={() => void change(tag.id, "remove")}
                  >
                    <span style={{ color: tag.color }}>● </span>
                    {tag.name}
                    {canManage && " ×"}
                  </button>
                ))
              ) : (
                <span className="text-tx-tertiary">
                  {t("assetOrganization.noTags")}
                </span>
              )}
            </div>
          )}
          {canManage && (
            <>
              <input
                aria-label={t("assetOrganization.searchOrCreate")}
                placeholder={t("assetOrganization.searchOrCreate")}
                value={search}
                maxLength={100}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setTagPage(1);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void create();
                  }
                }}
                className="w-full rounded border border-app-border bg-app-surface p-2 text-sm"
              />
              <div className="max-h-32 space-y-1 overflow-auto">
                {state.tags
                  .filter(
                    (tag) =>
                      tag.name
                        .toLocaleLowerCase()
                        .includes(search.toLocaleLowerCase()) &&
                      (ids.length > 1 ||
                        !assigned.some((item) => item.id === tag.id)),
                  )
                  .map((tag) => (
                    <div key={tag.id} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">
                        <span style={{ color: tag.color }}>● </span>
                        {tag.name}
                      </span>
                      <button
                        disabled={busy}
                        className="text-accent-primary"
                        onClick={() => void change(tag.id, "add")}
                      >
                        {t("assetOrganization.add")}
                      </button>
                      {ids.length > 1 && (
                        <button
                          disabled={busy}
                          className="text-tx-secondary"
                          onClick={() => void change(tag.id, "remove")}
                        >
                          {t("assetOrganization.remove")}
                        </button>
                      )}
                    </div>
                  ))}
              </div>
              <div className="flex gap-3">
                {tagPage > 1 && (
                  <button onClick={() => setTagPage((value) => value - 1)}>
                    {t("fileExplorer.previous")}
                  </button>
                )}
                {state.hasMoreTags && (
                  <button onClick={() => setTagPage((value) => value + 1)}>
                    {t("fileExplorer.next")}
                  </button>
                )}
              </div>
              {search.trim() &&
                !state.tags.some(
                  (tag) =>
                    tag.name.trim().toLocaleLowerCase() ===
                    search.trim().toLocaleLowerCase(),
                ) &&
                state.canManageTags && (
                  <button
                    disabled={busy}
                    className="text-accent-primary"
                    onClick={() => void create()}
                  >
                    {t("assetOrganization.createAndAdd", {
                      name: search.trim(),
                    })}
                  </button>
                )}
              {ids.length > 1 && (
                <p className="text-tx-tertiary">
                  {t("assetOrganization.batchHint", { count: ids.length })}
                </p>
              )}
            </>
          )}
          {ids.length === 1 && (
            <div className="border-t border-app-border pt-2">
              <h4 className="font-medium">
                {t("assetOrganization.duplicates")}
              </h4>
              <p className="mt-1 text-tx-secondary">
                {t(
                  duplicates.length
                    ? "assetOrganization.duplicateHint"
                    : "assetOrganization.noDuplicates",
                )}
              </p>
              {duplicates.map((file) => (
                <button
                  key={file.id}
                  className="mt-1 block max-w-full truncate text-left text-accent-primary"
                  disabled={!onOpen}
                  onClick={() => onOpen?.(file.id)}
                >
                  {file.filename}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

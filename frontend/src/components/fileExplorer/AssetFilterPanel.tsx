import { assetDateBoundary, assetLocalDate } from "@/lib/assetFilters";
import { useTranslation } from "react-i18next";
import type { AssetFilters, AssetTag } from "@/types";

export default function AssetFilterPanel({
  filters,
  tags,
  onChange,
  onSave,
  onUpdate,
  onClear,
}: {
  filters: AssetFilters;
  tags: AssetTag[];
  onChange: (filters: AssetFilters) => void;
  onSave: () => void;
  onUpdate?: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const change = (patch: Partial<AssetFilters>) =>
    onChange({ ...filters, ...patch });

  return (
    <div
      aria-label={t("assetOrganization.filters")}
      className="space-y-3 rounded-2xl border border-app-border/80 bg-app-elevated/85 p-3.5 text-xs shadow-xs backdrop-blur-md"
    >
      <div className="grid grid-cols-2 gap-2.5 [&>label]:min-w-0 md:gap-3 lg:grid-cols-3">
        <label className="font-medium text-tx-secondary">
          {t("assetOrganization.mime")}
          <select
            aria-label={t("assetOrganization.mime")}
            value={filters.mime || ""}
            onChange={(event) =>
              change({ mime: event.target.value || undefined })
            }
            className="mt-1 block w-full min-w-0 max-w-full cursor-pointer rounded-xl border border-app-border/80 bg-app-surface px-2.5 py-2 font-normal text-tx-primary outline-none focus:border-accent-primary"
          >
            <option value="">{t("assetOrganization.any")}</option>
            {[
              "application/pdf",
              "image/png",
              "image/jpeg",
              "image/webp",
              "text/plain",
              "application/zip",
              "video/mp4",
            ].map((mime) => (
              <option key={mime} value={mime}>
                {mime.split("/")[1].toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        {(["minSize", "maxSize"] as const).map((field) => (
          <label key={field} className="font-medium text-tx-secondary">
            {t(`assetOrganization.${field}`)}
            <input
              aria-label={t(`assetOrganization.${field}`)}
              type="number"
              min={0}
              step="any"
              value={
                filters[field] === undefined ? "" : filters[field]! / 1048576
              }
              onChange={(event) =>
                change({
                  [field]:
                    event.target.value === ""
                      ? undefined
                      : Math.round(Number(event.target.value) * 1048576),
                })
              }
              className="mt-1 block w-full min-w-0 max-w-full rounded-xl border border-app-border/80 bg-app-surface px-2.5 py-2 font-normal text-tx-primary outline-none focus:border-accent-primary"
            />
          </label>
        ))}
        {(["createdAfter", "createdBefore"] as const).map((field) => (
          <label key={field} className="font-medium text-tx-secondary">
            {t(`assetOrganization.${field}`)}
            <input
              aria-label={t(`assetOrganization.${field}`)}
              type="date"
              value={assetLocalDate(filters[field])}
              onChange={(event) =>
                change({
                  [field]: assetDateBoundary(
                    event.target.value,
                    field === "createdBefore",
                  ),
                })
              }
              className="mt-1 block w-full min-w-0 max-w-full rounded-xl border border-app-border/80 bg-app-surface px-2.5 py-2 font-normal text-tx-primary outline-none focus:border-accent-primary"
            />
          </label>
        ))}
        <label className="font-medium text-tx-secondary">
          {t("assetOrganization.references")}
          <select
            aria-label={t("assetOrganization.references")}
            value={filters.referenceState || ""}
            onChange={(event) =>
              change({
                referenceState: (event.target.value ||
                  undefined) as AssetFilters["referenceState"],
              })
            }
            className="mt-1 block w-full min-w-0 max-w-full cursor-pointer rounded-xl border border-app-border/80 bg-app-surface px-2.5 py-2 font-normal text-tx-primary outline-none focus:border-accent-primary"
          >
            <option value="">{t("assetOrganization.any")}</option>
            {(["referenced", "unreferenced", "multiple"] as const).map(
              (value) => (
                <option key={value} value={value}>
                  {t(`assetOrganization.${value}`)}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      {!!tags.length && (
        <fieldset>
          <legend className="mb-2 font-medium text-tx-secondary">
            {t("assetOrganization.allTags")}
          </legend>
          <div className="flex max-h-24 flex-wrap gap-2 overflow-auto">
            {tags.map((tag) => (
              <label
                key={tag.id}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-app-border/75 bg-app-surface px-2.5 py-1 transition-colors hover:border-accent-primary/40"
              >
                <input
                  type="checkbox"
                  className="accent-accent-primary"
                  checked={filters.tagIds?.includes(tag.id) || false}
                  onChange={(event) =>
                    change({
                      tagIds: event.target.checked
                        ? [...(filters.tagIds || []), tag.id]
                        : filters.tagIds?.filter((id) => id !== tag.id),
                    })
                  }
                />
                {tag.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-app-border/65 pt-2.5">
        <label className="inline-flex cursor-pointer items-center gap-2 text-tx-secondary">
          <input
            type="checkbox"
            className="accent-accent-primary"
            checked={filters.duplicateOnly || false}
            onChange={(event) =>
              change({ duplicateOnly: event.target.checked || undefined })
            }
          />
          {t("assetOrganization.duplicateOnly")}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-xl bg-accent-primary/10 px-3 py-1.5 font-medium text-accent-primary transition-colors hover:bg-accent-primary/18"
            onClick={onSave}
          >
            {t("assetOrganization.saveSmart")}
          </button>
          {onUpdate && (
            <button
              className="rounded-xl bg-violet-500/10 px-3 py-1.5 font-medium text-violet-600 transition-colors hover:bg-violet-500/18 dark:text-violet-300"
              onClick={onUpdate}
            >
              {t("assetOrganization.updateSmart")}
            </button>
          )}
          <button
            className="rounded-xl px-2.5 py-1.5 text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
            onClick={onClear}
          >
            {t("assetOrganization.clearFilters")}
          </button>
        </div>
      </div>
    </div>
  );
}

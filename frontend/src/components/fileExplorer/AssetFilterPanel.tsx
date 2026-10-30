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
      className="space-y-3 rounded-lg border border-app-border bg-app-surface p-3 text-xs"
    >
      <div className="grid grid-cols-2 gap-2 [&>label]:min-w-0 md:gap-3 lg:grid-cols-3">
        <label>
          {t("assetOrganization.mime")}
          <select
            aria-label={t("assetOrganization.mime")}
            value={filters.mime || ""}
            onChange={(event) =>
              change({ mime: event.target.value || undefined })
            }
            className="mt-1 block min-w-0 max-w-full w-full rounded border border-app-border bg-app-bg p-2"
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
          <label key={field}>
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
              className="mt-1 block min-w-0 max-w-full w-full rounded border border-app-border bg-app-bg p-2"
            />
          </label>
        ))}
        {(["createdAfter", "createdBefore"] as const).map((field) => (
          <label key={field}>
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
              className="mt-1 block min-w-0 max-w-full w-full rounded border border-app-border bg-app-bg p-2"
            />
          </label>
        ))}
        <label>
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
            className="mt-1 block min-w-0 max-w-full w-full rounded border border-app-border bg-app-bg p-2"
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
          <legend className="mb-2 text-tx-secondary">
            {t("assetOrganization.allTags")}
          </legend>
          <div className="flex max-h-24 flex-wrap gap-3 overflow-auto">
            {tags.map((tag) => (
              <label key={tag.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
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
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={filters.duplicateOnly || false}
          onChange={(event) =>
            change({ duplicateOnly: event.target.checked || undefined })
          }
        />
        {t("assetOrganization.duplicateOnly")}
      </label>
      <div className="flex flex-wrap gap-4">
        <button className="text-accent-primary" onClick={onSave}>
          {t("assetOrganization.saveSmart")}
        </button>
        {onUpdate && (
          <button className="text-accent-primary" onClick={onUpdate}>
            {t("assetOrganization.updateSmart")}
          </button>
        )}
        <button className="text-tx-secondary" onClick={onClear}>
          {t("assetOrganization.clearFilters")}
        </button>
      </div>
    </div>
  );
}

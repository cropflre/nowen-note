import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Search, Sparkles, Tag, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { confirm, prompt } from "@/components/ui/confirm";
import { toast } from "@/lib/toast";
import type { AssetOrganization, AssetSmartFolder } from "@/types";

export default function AssetOrganizationSidebar({
  state,
  activeTags,
  activeSmart,
  onTag,
  onSmart,
  onChanged,
  isCurrent,
}: {
  state: AssetOrganization;
  activeTags: string[];
  activeSmart: string | null;
  onTag: (id: string) => void;
  onSmart: (folder: AssetSmartFolder) => void;
  onChanged: () => void;
  isCurrent: () => boolean;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(state);
  const [tagPage, setTagPage] = useState(1);
  const [smartPage, setSmartPage] = useState(1);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!search && tagPage === 1 && smartPage === 1) {
      setLoaded(state);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void api.files.organization
        .list({ q: search, tagPage, smartPage })
        .then((result) => {
          if (!stale && isCurrent()) setLoaded(result);
        })
        .catch((failure: unknown) => {
          if (!stale && isCurrent())
            toast.error(
              failure instanceof Error ? failure.message : String(failure),
            );
        });
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [state, search, tagPage, smartPage, isCurrent]);

  const manage = async (
    kind: "tag" | "smart",
    id: string,
    name: string,
    remove: boolean,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      if (remove) {
        if (
          !(await confirm({
            title: t(
              kind === "tag"
                ? "assetOrganization.deleteTag"
                : "assetOrganization.deleteSmart",
              { name },
            ),
            description: t(
              kind === "tag"
                ? "assetOrganization.deleteTagHint"
                : "assetOrganization.deleteSmartHint",
            ),
            danger: true,
          })) ||
          !isCurrent()
        )
          return;
        if (kind === "tag") await api.files.organization.deleteTag(id);
        else await api.files.organization.deleteSmartFolder(id);
      } else {
        const next = await prompt({
          title: t(
            kind === "tag"
              ? "assetOrganization.renameTag"
              : "assetOrganization.renameSmart",
            { name },
          ),
          defaultValue: name,
        });
        if (!next?.trim() || !isCurrent()) return;
        if (kind === "tag")
          await api.files.organization.renameTag(id, next.trim());
        else
          await api.files.organization.saveSmartFolder(
            next.trim(),
            loaded.smartFolders.find((folder) => folder.id === id)!.filters,
            id,
          );
      }
      if (isCurrent()) onChanged();
    } catch (failure: unknown) {
      if (isCurrent())
        toast.error(
          failure instanceof Error ? failure.message : String(failure),
        );
    } finally {
      setBusy(false);
    }
  };

  if (!state.supported)
    return (
      <p className="mt-4 px-2 text-xs leading-5 text-tx-tertiary">
        {t("assetOrganization.nativeUnavailable")}
      </p>
    );

  return (
    <div className="mt-5 space-y-4 text-xs">
      <section aria-label={t("assetOrganization.tags")}>
        <h3 className="flex items-center gap-1.5 px-2 font-semibold text-tx-secondary">
          <Tag size={12} className="text-sky-500 dark:text-sky-400" />
          {t("assetOrganization.tags")}
        </h3>
        <div className="relative my-2">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary" />
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setTagPage(1);
            }}
            aria-label={t("assetOrganization.searchTags")}
            placeholder={t("assetOrganization.searchTags")}
            className="w-full rounded-xl border border-app-border/75 bg-app-bg/80 py-1.5 pl-7 pr-2.5 text-xs outline-none transition-colors focus:border-accent-primary/60 focus:bg-app-surface"
          />
        </div>
        <div className="space-y-0.5">
          {loaded.tags
            .filter((tag) =>
              tag.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
            )
            .map((tag) => (
              <div key={tag.id} className="group flex items-center gap-1">
                <button
                  aria-pressed={activeTags.includes(tag.id)}
                  onClick={() => onTag(tag.id)}
                  className="min-w-0 flex-1 truncate rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-app-hover/80 aria-pressed:bg-accent-primary/12 aria-pressed:font-medium aria-pressed:text-accent-primary"
                >
                  <span style={{ color: tag.color }}>● </span>
                  {tag.name}
                </button>
                {state.canManageTags && (
                  <>
                    <button
                      disabled={busy}
                      aria-label={t("assetOrganization.renameTag", {
                        name: tag.name,
                      })}
                      onClick={() => void manage("tag", tag.id, tag.name, false)}
                      className="rounded-lg p-1 text-tx-tertiary opacity-70 transition-all hover:bg-app-hover hover:text-tx-primary group-hover:opacity-100"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      disabled={busy}
                      aria-label={t("assetOrganization.deleteTag", {
                        name: tag.name,
                      })}
                      onClick={() => void manage("tag", tag.id, tag.name, true)}
                      className="rounded-lg p-1 text-tx-tertiary opacity-70 transition-all hover:bg-rose-500/10 hover:text-rose-500 group-hover:opacity-100"
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
        </div>
        {(tagPage > 1 || loaded.hasMoreTags) && (
          <div className="mt-1.5 flex gap-3 px-2 text-[11px] font-medium text-accent-primary">
            {tagPage > 1 && (
              <button onClick={() => setTagPage((value) => value - 1)}>
                {t("fileExplorer.previous")}
              </button>
            )}
            {loaded.hasMoreTags && (
              <button onClick={() => setTagPage((value) => value + 1)}>
                {t("fileExplorer.next")}
              </button>
            )}
          </div>
        )}
      </section>

      <section aria-label={t("assetOrganization.smartFolders")}>
        <h3 className="mb-2 flex items-center gap-1.5 px-2 font-semibold text-tx-secondary">
          <Sparkles size={12} className="text-violet-500 dark:text-violet-400" />
          {t("assetOrganization.smartFolders")}
        </h3>
        <div className="space-y-0.5">
          {loaded.smartFolders.map((folder) => (
            <div key={folder.id} className="group flex items-center gap-1">
              <button
                aria-pressed={activeSmart === folder.id}
                onClick={() => onSmart(folder)}
                className="min-w-0 flex-1 truncate rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-app-hover/80 aria-pressed:bg-violet-500/12 aria-pressed:font-medium aria-pressed:text-violet-600 dark:aria-pressed:text-violet-300"
              >
                {folder.name}
              </button>
              <button
                disabled={busy}
                className="rounded-lg p-1 text-tx-tertiary opacity-70 transition-all hover:bg-app-hover hover:text-tx-primary group-hover:opacity-100"
                aria-label={t("assetOrganization.renameSmart", {
                  name: folder.name,
                })}
                onClick={() =>
                  void manage("smart", folder.id, folder.name, false)
                }
              >
                <Pencil size={12} />
              </button>
              <button
                disabled={busy}
                className="rounded-lg p-1 text-tx-tertiary opacity-70 transition-all hover:bg-rose-500/10 hover:text-rose-500 group-hover:opacity-100"
                aria-label={t("assetOrganization.deleteSmart", {
                  name: folder.name,
                })}
                onClick={() => void manage("smart", folder.id, folder.name, true)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
        {(smartPage > 1 || loaded.hasMoreSmartFolders) && (
          <div className="mt-1.5 flex gap-3 px-2 text-[11px] font-medium text-accent-primary">
            {smartPage > 1 && (
              <button onClick={() => setSmartPage((value) => value - 1)}>
                {t("fileExplorer.previous")}
              </button>
            )}
            {loaded.hasMoreSmartFolders && (
              <button onClick={() => setSmartPage((value) => value + 1)}>
                {t("fileExplorer.next")}
              </button>
            )}
          </div>
        )}
        <p className="mt-2 rounded-xl bg-app-hover/45 px-2.5 py-2 text-[11px] leading-4 text-tx-tertiary">
          {t("assetOrganization.smartHint")}
        </p>
      </section>
    </div>
  );
}

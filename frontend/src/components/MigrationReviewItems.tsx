import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { migrationApi, type MigrationJob, type MigrationReportItem } from "@/lib/migrations";

export default function MigrationReviewItems({ job, busy, onDecision }: {
  job: MigrationJob; busy: boolean;
  onDecision: (itemId: string, decision: MigrationReportItem["decision"]) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<MigrationReportItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const key = `${job.id}:${job.previewDigest}`;
  const current = useRef(key); current.current = key;
  useEffect(() => {
    let cancelled = false;
    setItems([]); setError(""); setCursor(null); setLoading(true);
    void migrationApi.items(job.id).then((page) => {
      if (!cancelled) { setItems(page.items); setCursor(page.nextCursor); }
    }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t("migration.unknownError")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [job.id, job.previewDigest, t]);
  const more = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await migrationApi.items(job.id, cursor);
      if (current.current === key) { setItems((previous) => [...previous, ...page.items]); setCursor(page.nextCursor); }
    } catch (cause) { if (current.current === key) setError(cause instanceof Error ? cause.message : t("migration.unknownError")); }
    finally { if (current.current === key) setLoading(false); }
  };
  return <details className="rounded-lg border border-[var(--color-border)] p-3">
    <summary className="cursor-pointer text-sm font-medium">{t("migration.reviewItems")}</summary>
    <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{t("migration.decisionHint")}</p>
    {error && <p role="alert" className="mt-2 break-words text-xs text-red-600">{error}</p>}
    <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto">
      {items.map((item) => <li key={item.id} className="space-y-1 rounded border border-[var(--color-border)] p-2 text-xs">
        <div className="break-words font-medium">{item.title}</div>
        <div className="break-words text-[var(--color-text-secondary)]">{item.path.join(" / ")} · {t(`migration.itemStatus.${item.status}`, { defaultValue: item.status })}</div>
        {item.warnings.map((warning) => <p key={warning} className="break-words text-amber-700 dark:text-amber-300">{warning}</p>)}
        <select aria-label={t("migration.itemDecision", { title: item.title })} value={item.decision} disabled={busy || loading || item.status === "IMPORTED"}
          className="min-h-10 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[var(--color-text-primary)]"
          onChange={(event) => onDecision(item.id, event.target.value as MigrationReportItem["decision"])}>
          <option value="auto">{t("migration.itemActions.auto")}</option>
          {item.action === "existing" && <option value="keep-existing">{t("migration.itemActions.keep-existing")}</option>}
          <option value="create-copy">{t("migration.itemActions.create-copy")}</option>
          <option value="skip">{t("migration.itemActions.skip")}</option>
        </select>
      </li>)}
    </ul>
    {cursor && <button type="button" disabled={busy || loading} className="mt-2 min-h-10 text-xs text-[var(--color-accent-primary)]" onClick={() => void more()}>{t("migration.loadMore")}</button>}
    {loading && <p role="status" className="mt-2 text-xs">{t("migration.loadingItems")}</p>}
  </details>;
}

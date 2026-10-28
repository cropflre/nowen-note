import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, resolveAttachmentUrl } from "@/lib/api";
import { humanFileSize } from "@/lib/fileExplorerModel";
import { useFileToolDialog } from "@/hooks/useFileToolDialog";
import { fileToolError } from "@/lib/fileToolError";
import type { SimilarImageResult } from "@/types";

export default function SimilarImages({
  source,
  isCurrent,
  onClose,
  onOpen,
}: {
  source: { id: string; filename: string };
  isCurrent: () => boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [matches, setMatches] = useState<SimilarImageResult["matches"]>([]);
  const [counts, setCounts] = useState({ examined: 0, skipped: 0 });
  const [after, setAfter] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController>(undefined);
  const dialog = useFileToolDialog(onClose);
  const load = async (cursor?: string) => {
    if (controller.current || !isCurrent()) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError("");
    try {
      const result = await api.files.tools.similar(
        source.id,
        cursor,
        request.signal,
      );
      if (request.signal.aborted || !isCurrent()) return;
      setMatches((previous) =>
        [
          ...new Map(
            [...previous, ...result.matches].map((item) => [item.id, item]),
          ).values(),
        ].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)),
      );
      setCounts((previous) => ({
        examined: previous.examined + result.examined,
        skipped: previous.skipped + result.skipped,
      }));
      setAfter(result.nextAfter);
    } catch (failure: unknown) {
      if (!request.signal.aborted && isCurrent())
        setError(fileToolError(failure, t));
    } finally {
      if (controller.current === request) controller.current = undefined;
      if (!request.signal.aborted && isCurrent()) setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      controller.current?.abort();
      controller.current = undefined;
    };
    // The parent keys this dialog by source and account/server/workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-3"
      onClick={onClose}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("assetTools.similar")}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[85dvh] w-full max-w-3xl flex-col rounded-xl border border-app-border bg-app-elevated p-4 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-semibold">{t("assetTools.similar")}</h2>
            <p className="mt-1 truncate text-sm text-tx-secondary">
              {source.filename}
            </p>
          </div>
          <button
            aria-label={t("common.close")}
            onClick={onClose}
            className="rounded p-2 hover:bg-app-hover"
          >
            ×
          </button>
        </div>
        <p className="my-3 text-xs text-tx-secondary">
          {t("assetTools.similarHint")}
        </p>
        <p role="status" className="mb-3 text-xs text-tx-secondary">
          {t("assetTools.scanCount", counts)} ·{" "}
          {t(
            busy
              ? "assetTools.scanning"
              : after === null
                ? "assetTools.complete"
                : "assetTools.partial",
          )}
        </p>
        {error && (
          <p role="alert" className="mb-3 text-sm text-red-500">
            {error}
          </p>
        )}
        <div className="min-h-0 overflow-auto">
          {!matches.length && !busy && !error && (
            <p className="py-8 text-center text-sm text-tx-secondary">
              {t("assetTools.noMatches")}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {matches.map((item) => (
              <button
                key={item.id}
                className="overflow-hidden rounded-lg border border-app-border text-left hover:bg-app-hover"
                onClick={() => {
                  if (isCurrent()) {
                    onOpen(item.id);
                    onClose();
                  }
                }}
              >
                <img
                  loading="lazy"
                  decoding="async"
                  src={resolveAttachmentUrl(
                    `/api/attachments/${item.id}?w=240`,
                  )}
                  alt=""
                  className="h-32 w-full bg-app-surface object-contain"
                />
                <span className="block truncate px-3 pt-2 text-sm">
                  {item.filename}
                </span>
                <span className="block px-3 pb-2 text-xs text-tx-tertiary">
                  {humanFileSize(item.size)}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-3 text-sm">
          <button onClick={onClose}>{t("common.close")}</button>
          {after !== null && (
            <button
              disabled={busy}
              className="text-accent-primary disabled:opacity-40"
              onClick={() => void load(after || undefined)}
            >
              {t(error ? "fileExplorer.retry" : "assetTools.scanMore")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

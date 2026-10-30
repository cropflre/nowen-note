import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { fileRenamePreview } from "@/lib/fileRenamePreview";
import { useFileToolDialog } from "@/hooks/useFileToolDialog";
import { fileToolError } from "@/lib/fileToolError";

export default function BatchRenameDialog({
  files,
  isCurrent,
  onClose,
  onRenamed,
}: {
  files: Array<{ id: string; filename: string }>;
  isCurrent: () => boolean;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState(files);
  const [base, setBase] = useState("");
  const [start, setStart] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useFileToolDialog(onClose, busy);
  const preview = fileRenamePreview(source, base, start);
  const rename = async () => {
    if (!preview.length || busy || !isCurrent()) return;
    setBusy(true);
    setError("");
    try {
      await api.files.tools.batchRename(preview);
      if (isCurrent()) {
        onRenamed();
        onClose();
      }
    } catch (failure: unknown) {
      if (isCurrent()) setError(fileToolError(failure, t));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };
  const reload = async () => {
    if (busy || !isCurrent()) return;
    setBusy(true);
    setError("");
    try {
      const current = await Promise.all(
        source.map((file) => api.files.get(file.id)),
      );
      if (isCurrent()) setSource(current);
    } catch (failure: unknown) {
      if (isCurrent()) setError(fileToolError(failure, t));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-3">
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("assetTools.rename")}
        className="flex max-h-[85dvh] w-full max-w-2xl flex-col rounded-xl border border-app-border bg-app-elevated p-4 shadow-xl"
      >
        <h2 className="font-semibold">{t("assetTools.rename")}</h2>
        <p className="my-3 text-xs text-tx-secondary">
          {t("assetTools.renameHint")}
        </p>
        <div className="flex flex-wrap gap-3 text-sm">
          <label className="min-w-0 flex-1">
            {t("assetTools.baseName")}
            <input
              autoFocus
              disabled={busy}
              maxLength={200}
              value={base}
              onChange={(event) => setBase(event.target.value)}
              className="mt-1 w-full rounded border border-app-border bg-app-surface p-2"
            />
          </label>
          <label className="w-28">
            {t("assetTools.start")}
            <input
              disabled={busy}
              type="number"
              min={1}
              max={999999}
              value={Number.isNaN(start) ? "" : start}
              onChange={(event) => setStart(event.target.valueAsNumber)}
              className="mt-1 w-full rounded border border-app-border bg-app-surface p-2"
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-500">
            {error}{" "}
            <button
              disabled={busy}
              className="underline"
              onClick={() => void reload()}
            >
              {t("assetTools.reloadPreview")}
            </button>
          </p>
        )}
        {!preview.length && base && (
          <p role="alert" className="mt-3 text-xs text-red-500">
            {t("assetTools.invalidName")}
          </p>
        )}
        <div className="mt-4 min-h-0 overflow-auto">
          <table className="w-full table-fixed text-left text-xs">
            <thead className="text-tx-secondary">
              <tr>
                <th className="p-2">{t("assetTools.before")}</th>
                <th className="p-2">{t("assetTools.after")}</th>
              </tr>
            </thead>
            <tbody>
              {source.map((file, index) => (
                <tr key={file.id} className="border-t border-app-border">
                  <td className="break-words p-2">{file.filename}</td>
                  <td className="break-words p-2 text-accent-primary">
                    {preview[index]?.filename || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex justify-end gap-3 text-sm">
          <button disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            disabled={busy || !preview.length}
            className="text-accent-primary disabled:opacity-40"
            onClick={() => void rename()}
          >
            {t(busy ? "common.loading" : "assetTools.confirmRename", {
              count: source.length,
            })}
          </button>
        </div>
      </div>
    </div>
  );
}

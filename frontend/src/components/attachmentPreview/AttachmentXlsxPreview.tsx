import React, { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import SheetGrid from "@/components/SheetGrid";
import { loadAttachmentWorkbook } from "@/lib/attachmentXlsx";
import { workbookSheetToImport, XlsxError, type WorkbookPreviewModel } from "@/lib/sheetXlsx";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { getCurrentWorkspace } from "@/lib/api";
import { downloadAttachment } from "@/lib/downloadFile";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface Props { url: string; filename: string; size: number; heightClass?: string }

export default function AttachmentXlsxPreview({ url, filename, size, heightClass }: Props) {
  const { t } = useTranslation();
  const [workbook, setWorkbook] = useState<WorkbookPreviewModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeSheet, setActiveSheet] = useState(0);
  const [destinations, setDestinations] = useState<KnowledgeTreeNode[] | null>(null);
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const importBusy = useRef(false);
  const importWorkspace = useRef("");
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    generation.current += 1;
    setLoading(true);
    setWorkbook(null);
    setError("");
    setActiveSheet(0);
    setDestinations(null);
    void loadAttachmentWorkbook(url, size, controller.signal).then((result) => {
      if (!controller.signal.aborted) setWorkbook(result);
    }).catch((error) => {
      if (!controller.signal.aborted) setError(error instanceof XlsxError && error.code === "limit" ? "limitError" : "invalidError");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => { controller.abort(); generation.current += 1; };
  }, [url, size]);

  const sheet = workbook?.sheets[activeSheet];
  const importData = useMemo(() => sheet ? workbookSheetToImport(sheet.data) : null, [sheet]);
  const tooManyImportCells = importData && Object.keys(importData.cells).length > 50_000;

  const download = async () => {
    try { await downloadAttachment(url, filename); }
    catch { toast.error(t("xlsxPreview.downloadFailed")); }
  };

  const importSheet = async () => {
    if (!sheet || !importData || importBusy.current || tooManyImportCells) return;
    importBusy.current = true;
    setBusy(true);
    const requestGeneration = generation.current;
    try {
      if (!destinations) {
        importWorkspace.current = getCurrentWorkspace();
        const result = await knowledgeTreeApi.list();
        if (requestGeneration !== generation.current) return;
        const folders = result.nodes.filter((node) => node.resourceType === "notebook" && node.access.capabilities.canCreate);
        setDestinations(folders);
        setParentId("");
        return;
      }
      if (getCurrentWorkspace() !== importWorkspace.current) {
        setDestinations(null);
        throw new Error(t("xlsxPreview.workspaceChanged"));
      }
      await knowledgeTreeApi.create({
        parentId: parentId || null, nodeType: "sheet",
        title: `${filename.replace(/\.xlsx$/i, "")} · ${sheet.name}`,
        sheetData: importData,
      });
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", { detail: { reason: "xlsx-import" } }));
      toast.success(t("xlsxPreview.imported"));
      if (requestGeneration === generation.current) setDestinations(null);
    } catch (caughtError: unknown) {
      const error = caughtError as Error & { code?: string };
      toast.error(error?.message || t("xlsxPreview.importFailed"));
    } finally {
      importBusy.current = false;
      setBusy(false);
    }
  };

  return (
    <section className={cn("flex min-w-0 flex-col bg-app-bg", heightClass)} data-xlsx-preview>
      <div className="flex flex-wrap items-center gap-2 border-b border-app-border p-2 text-xs text-tx-secondary">
        <span className="min-w-0 flex-1">{t("xlsxPreview.readOnly")}</span>
        <button type="button" onClick={() => void download()} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-app-hover"><Download size={14} />{t("xlsxPreview.download")}</button>
        {sheet && <button type="button" disabled={busy || Boolean(tooManyImportCells)} onClick={() => void importSheet()} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-app-hover disabled:opacity-40">{busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}{t("xlsxPreview.import")}</button>}
      </div>
      {destinations && <div className="flex flex-wrap items-center gap-2 border-b border-app-border p-2 text-xs text-tx-secondary">
        <label>{t("xlsxPreview.destination")} <select aria-label={t("xlsxPreview.destination")} disabled={busy} value={parentId} onChange={(event) => setParentId(event.target.value)} className="max-w-full rounded border border-app-border bg-app-surface p-1">
          <option value="">{t("xlsxPreview.workspaceRoot")}</option>
          {destinations.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
        </select></label>
        <span>{t("xlsxPreview.importHint")}</span>
        <button type="button" disabled={busy} onClick={() => void importSheet()} className="rounded bg-accent-primary px-2 py-1 text-white disabled:opacity-40">{t("xlsxPreview.confirmImport", { name: sheet?.name })}</button>
        <button type="button" disabled={busy} onClick={() => setDestinations(null)}>{t("xlsxPreview.cancel")}</button>
      </div>}
      {loading ? <div className="flex items-center justify-center gap-2 py-16 text-sm text-tx-tertiary"><Loader2 size={16} className="animate-spin" />{t("xlsxPreview.loading")}</div>
        : error ? <div role="alert" className="px-4 py-12 text-center text-sm text-tx-secondary">{t(`xlsxPreview.${error}`)}</div>
        : sheet && <>
          <div role="tablist" aria-label={t("xlsxPreview.worksheets")} className="flex shrink-0 overflow-x-auto border-b border-app-border bg-app-surface p-1">
            {workbook?.sheets.map((item, index) => <button key={index} type="button" role="tab" aria-selected={index === activeSheet} disabled={busy} onClick={() => { setActiveSheet(index); setDestinations(null); }} className={cn("shrink-0 rounded px-3 py-1.5 text-xs", index === activeSheet ? "bg-accent-primary text-white" : "text-tx-secondary hover:bg-app-hover")}>{item.name}</button>)}
          </div>
          <div className="flex h-[min(60vh,600px)] min-h-[240px] min-w-0 flex-col" role="tabpanel" aria-label={sheet.name}>
            {sheet.data.rows.length ? <SheetGrid key={activeSheet} data={sheet.data} /> : <div className="p-10 text-center text-sm text-tx-tertiary">{t("xlsxPreview.empty")}</div>}
          </div>
          <p className="border-t border-app-border px-3 py-2 text-[11px] text-tx-tertiary">{t("xlsxPreview.dataOnly")}{tooManyImportCells ? ` ${t("xlsxPreview.importLimit")}` : ""}</p>
        </>}
    </section>
  );
}

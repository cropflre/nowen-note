import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dialogMotion, overlayMotion } from "@/lib/motion";
import type { EditorActionUiState } from "@/lib/editorActions/runner";
import { toast } from "@/lib/toast";
import { EditorActionIcon } from "./EditorActionIcon";

function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  const { t } = useTranslation();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.querySelector<HTMLButtonElement>("[data-primary]")?.focus(); }, []);
  return createPortal(<>
    <motion.div {...overlayMotion} className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
    <div className="pointer-events-none fixed inset-0 z-[71] flex items-end justify-center sm:items-center sm:p-4">
      <motion.div {...dialogMotion} ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
        className="pointer-events-auto flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl border border-app-border bg-app-surface shadow-2xl sm:max-w-xl sm:rounded-2xl">
        <div className="flex items-center gap-2 border-b border-app-border px-4 py-3">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold text-tx-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t("editorActions.close")} className="inline-flex h-11 w-11 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary md:h-8 md:w-8"><X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">{children}</div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-app-border px-4 py-3" style={{ paddingBottom: "calc(var(--safe-area-bottom, 0px) + 12px)" }}>{footer}</div>
      </motion.div>
    </div>
  </>, document.body);
}

/** Plain text only: results are never rendered as HTML. */
function TextBlock({ label, text }: { label: string; text: string }) {
  return <section>
    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-tx-tertiary">{label}</h3>
    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-app-border bg-app-bg px-3 py-2 font-sans text-sm text-tx-primary">{text}</pre>
  </section>;
}

async function copyText(text: string, t: (key: string) => string) {
  try { await navigator.clipboard.writeText(text); toast.success(t("editorActions.copied")); } catch { toast.error(t("editorActions.copyFailed")); }
}

export function EditorActionsHost({ state }: { state: EditorActionUiState }) {
  const { t } = useTranslation();
  if (state.phase === "idle") return null;
  if (state.phase === "running") {
    return createPortal(
      <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 z-[65] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2 rounded-full border border-app-border bg-app-elevated py-1.5 pl-3 pr-1.5 text-sm text-tx-primary shadow-lg">
        <Loader2 size={15} className="shrink-0 animate-spin text-accent-primary" aria-hidden />
        <span className="min-w-0 truncate">{t("editorActions.running", { label: state.action.label })}</span>
        <Button size="sm" variant="ghost" className="min-h-9 shrink-0" onClick={state.cancel}>{t("editorActions.cancel")}</Button>
      </div>,
      document.body,
    );
  }
  if (state.phase === "preview") {
    const { action, resolve } = state;
    return <Dialog title={t("editorActions.previewTitle", { label: action.label })} onClose={() => resolve("cancel")} footer={<>
      <Button variant="ghost" onClick={() => resolve("cancel")}>{t("editorActions.cancel")}</Button>
      <Button variant="outline" onClick={() => resolve("copy")}>{t("editorActions.copy")}</Button>
      {state.choices.includes("insert") && <Button variant={state.choices.length > 1 ? "outline" : "default"} data-primary={state.choices.length === 1 ? true : undefined} onClick={() => resolve("insert")}>{t("editorActions.insert")}</Button>}
      {state.choices.includes("replace") && <Button data-primary onClick={() => resolve("replace")}>{t("editorActions.replace")}</Button>}
    </>}>
      <p className="flex items-center gap-1.5 text-xs text-tx-tertiary"><EditorActionIcon icon={action.icon} size={13} />{t("editorActions.fromPlugin", { plugin: action.pluginName })}</p>
      <p className="text-sm text-tx-secondary">{t(state.ai ? "editorActions.previewAiNotice" : "editorActions.previewNotice")}</p>
      {state.original && <TextBlock label={t("editorActions.original")} text={state.original} />}
      <TextBlock label={t("editorActions.result")} text={state.result} />
    </Dialog>;
  }
  return <Dialog title={t("editorActions.conflictTitle")} onClose={state.dismiss} footer={<>
    <Button variant="ghost" onClick={state.dismiss}>{t("editorActions.close")}</Button>
    <Button variant="outline" onClick={() => void copyText(state.result, t)}>{t("editorActions.copy")}</Button>
    <Button data-primary onClick={state.retry}>{t("editorActions.retry")}</Button>
  </>}>
    <p className="text-sm text-tx-secondary">{t("editorActions.conflictBody")}</p>
    <TextBlock label={t("editorActions.result")} text={state.result} />
  </Dialog>;
}

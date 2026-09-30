import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Play, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CODE_BLOCK_TOOL_BUTTON_CLASS } from "@/lib/codeBlockPresentation";
import { buildHtmlPlaygroundDocument, isHtmlPlaygroundLanguage } from "@/lib/htmlPlayground";

function HtmlPlayground({ source, onRun, onClose }: {
  source: string;
  onRun: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const srcDoc = useMemo(() => buildHtmlPlaygroundDocument(source), [source]);

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="m-auto w-[calc(100%-1rem)] max-w-5xl max-h-[calc(100dvh-1rem)] rounded-xl border border-app-border bg-app-surface p-0 text-tx-primary shadow-xl backdrop:bg-black/60"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-app-border px-3 py-2">
        <h2 id={titleId} className="min-w-0 flex-1 text-sm font-medium">{t("htmlPlayground.title", "HTML 运行预览")}</h2>
        <button type="button" onClick={onRun} className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-app-hover">
          <RotateCcw size={14} />{t("htmlPlayground.rerun", "重新运行")}
        </button>
        <button type="button" onClick={onClose} autoFocus className="rounded p-1 hover:bg-app-hover" aria-label={t("htmlPlayground.close", "关闭预览")}>
          <X size={18} />
        </button>
      </div>
      <p className="border-b border-app-border px-3 py-2 text-xs text-tx-secondary">{t("htmlPlayground.description", "支持 HTML、CSS 和内联 JavaScript。预览与笔记隔离，外部脚本和网络请求受限。")}</p>
      <iframe
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        title={t("htmlPlayground.title", "HTML 运行预览")}
        className="block h-[70dvh] min-h-48 w-full border-0 bg-white"
      />
    </dialog>,
    document.body,
  );
}

/** Only an explicit click creates the script-enabled frame; reruns use a fresh source snapshot. */
export function HtmlCodeBlockRunButton({ language, source }: { language: string; source: string }) {
  const { t } = useTranslation();
  const [run, setRun] = useState<{ source: string; id: number } | null>(null);
  const supported = isHtmlPlaygroundLanguage(language);
  useEffect(() => {
    if (!supported) setRun(null);
  }, [supported]);
  if (!supported) return null;
  const label = t("htmlPlayground.run", "运行 HTML");
  const startRun = () => setRun((previous) => ({ source, id: (previous?.id ?? 0) + 1 }));
  return (
    <>
      <button
        type="button"
        className={CODE_BLOCK_TOOL_BUTTON_CLASS}
        aria-label={label}
        title={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => { event.stopPropagation(); startRun(); }}
      >
        <Play size={13} /><span className="hidden sm:inline">{label}</span>
      </button>
      {run && <HtmlPlayground key={run.id} source={run.source} onRun={startRun} onClose={() => setRun(null)} />}
    </>
  );
}

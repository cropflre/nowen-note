import { useRef, useState } from "react";
import { AlignLeft, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { canFormatCodeBlock, CodeBlockFormatError } from "@/lib/codeBlockFormatting";
import { toast } from "@/lib/toast";

export function CodeBlockFormatButton({ language, disabled = false, onFormat, className }: {
  language: string;
  disabled?: boolean;
  onFormat: () => Promise<void>;
  className?: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const supported = canFormatCodeBlock(language);
  const label = t(busy ? "codeBlockFormatting.formatting" : "codeBlockFormatting.format", {
    defaultValue: busy ? "格式化中…" : "格式化",
  });
  const title = disabled ? t("codeBlockFormatting.readOnly", "只读笔记无法格式化")
    : !supported ? t("codeBlockFormatting.unsupported", "暂不支持此语言的格式化") : label;
  return (
    <button type="button" className={className || "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-40"}
      disabled={disabled || !supported || busy} title={title} aria-label={label} aria-busy={busy}
      onMouseDown={(event) => event.preventDefault()}
      onClick={async (event) => {
        event.stopPropagation();
        if (running.current || disabled || !supported) return;
        running.current = true;
        setBusy(true);
        try { await onFormat(); } catch (error) {
          const reason = error instanceof CodeBlockFormatError ? error.reason : "invalid";
          toast.error(t(`codeBlockFormatting.${reason}`, "格式化失败，请检查语法和代码语言"));
        } finally { running.current = false; setBusy(false); }
      }}>
      {busy ? <Loader2 size={12} className="animate-spin" /> : <AlignLeft size={12} />}
      <span>{label}</span>
    </button>
  );
}

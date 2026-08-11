import React, { useCallback } from "react";
import {
  Bold,
  CheckSquare,
  Code2,
  Eye,
  List,
  ListOrdered,
  MoreHorizontal,
  Pencil,
  Quote,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export type SayMarkdownMode = "write" | "preview";
export type SayMarkdownAction =
  | "bold"
  | "inlineCode"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "quote";

export interface SayMarkdownEditResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface SayMarkdownPlaceholders {
  text: string;
  content: string;
}

const DEFAULT_PLACEHOLDERS: SayMarkdownPlaceholders = {
  text: "文本",
  content: "内容",
};

function wrapSelection(
  text: string,
  start: number,
  end: number,
  prefix: string,
  suffix: string,
  placeholder: string,
): SayMarkdownEditResult {
  const selected = text.slice(start, end);
  const fallback = selected || placeholder;
  const inserted = `${prefix}${fallback}${suffix}`;
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    selectionStart: start + prefix.length,
    selectionEnd: start + prefix.length + fallback.length,
  };
}

function prefixSelectedLines(
  text: string,
  start: number,
  end: number,
  prefixForIndex: (index: number) => string,
  placeholder: string,
): SayMarkdownEditResult {
  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nextBreak = text.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  const block = text.slice(lineStart, lineEnd) || placeholder;
  const replaced = block
    .split("\n")
    .map((line, index) => `${prefixForIndex(index)}${line}`)
    .join("\n");
  return {
    text: text.slice(0, lineStart) + replaced + text.slice(lineEnd),
    selectionStart: lineStart,
    selectionEnd: lineStart + replaced.length,
  };
}

export function applySayMarkdownAction(
  text: string,
  start: number,
  end: number,
  action: SayMarkdownAction,
  placeholders: SayMarkdownPlaceholders = DEFAULT_PLACEHOLDERS,
): SayMarkdownEditResult {
  switch (action) {
    case "bold":
      return wrapSelection(text, start, end, "**", "**", placeholders.text);
    case "inlineCode":
      return wrapSelection(text, start, end, "`", "`", placeholders.text);
    case "bulletList":
      return prefixSelectedLines(text, start, end, () => "- ", placeholders.content);
    case "orderedList":
      return prefixSelectedLines(text, start, end, (index) => `${index + 1}. `, placeholders.content);
    case "taskList":
      return prefixSelectedLines(text, start, end, () => "- [ ] ", placeholders.content);
    case "quote":
      return prefixSelectedLines(text, start, end, () => "> ", placeholders.content);
  }
}

interface SayMarkdownToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  mode: SayMarkdownMode;
  onModeChange: (mode: SayMarkdownMode) => void;
}

export default function SayMarkdownToolbar({
  textareaRef,
  value,
  onChange,
  mode,
  onModeChange,
}: SayMarkdownToolbarProps) {
  const { t } = useTranslation();

  const apply = useCallback((action: SayMarkdownAction) => {
    const textarea = textareaRef.current;
    if (!textarea || mode !== "write") return;
    const result = applySayMarkdownAction(
      value,
      textarea.selectionStart ?? value.length,
      textarea.selectionEnd ?? value.length,
      action,
      {
        text: t("diary.markdownTextPlaceholder"),
        content: t("diary.markdownContentPlaceholder"),
      },
    );
    onChange(result.text);
    requestAnimationFrame(() => {
      const next = textareaRef.current;
      if (!next) return;
      next.focus();
      next.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  }, [mode, onChange, t, textareaRef, value]);

  const actions: Array<{
    action: SayMarkdownAction;
    label: string;
    icon: React.ReactNode;
    mobilePrimary?: boolean;
  }> = [
    { action: "bold", label: t("diary.markdownBold"), icon: <Bold size={14} />, mobilePrimary: true },
    { action: "bulletList", label: t("diary.markdownBulletList"), icon: <List size={14} />, mobilePrimary: true },
    { action: "taskList", label: t("diary.markdownTaskList"), icon: <CheckSquare size={14} />, mobilePrimary: true },
    { action: "orderedList", label: t("diary.markdownOrderedList"), icon: <ListOrdered size={14} /> },
    { action: "quote", label: t("diary.markdownQuote"), icon: <Quote size={14} /> },
    { action: "inlineCode", label: t("diary.markdownInlineCode"), icon: <Code2 size={14} /> },
  ];
  const secondaryActions = actions.filter((item) => !item.mobilePrimary);

  const actionButtonClass = (mobilePrimary?: boolean) => cn(
    "grid h-10 w-10 shrink-0 place-items-center rounded-lg text-tx-tertiary transition-colors sm:h-7 sm:w-7 sm:rounded-md",
    !mobilePrimary && "hidden sm:grid",
    mode === "write"
      ? "hover:bg-app-hover hover:text-tx-primary"
      : "cursor-not-allowed opacity-40",
  );

  return (
    <div
      className="mt-2 border-t border-app-border/40 pt-2"
      data-diary-markdown-toolbar=""
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          {actions.map((item) => (
            <button
              key={item.action}
              type="button"
              disabled={mode !== "write"}
              title={item.label}
              aria-label={item.label}
              onMouseDown={(event) => {
                event.preventDefault();
                apply(item.action);
              }}
              className={actionButtonClass(item.mobilePrimary)}
            >
              {item.icon}
            </button>
          ))}

          <details className="relative shrink-0 sm:hidden">
            <summary
              className={cn(
                "grid h-10 w-10 cursor-pointer list-none place-items-center rounded-lg text-tx-tertiary transition-colors [&::-webkit-details-marker]:hidden",
                mode === "write"
                  ? "hover:bg-app-hover hover:text-tx-primary"
                  : "pointer-events-none opacity-40",
              )}
              title={t("diary.media.more")}
              aria-label={t("diary.media.more")}
            >
              <MoreHorizontal size={16} />
            </summary>
            <div className="absolute left-0 top-full z-50 mt-2 w-36 rounded-xl border border-app-border bg-app-elevated p-1.5 shadow-lg">
              {secondaryActions.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  disabled={mode !== "write"}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    apply(item.action);
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                  className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-xs text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </details>
        </div>

        <div
          className="flex shrink-0 items-center rounded-lg bg-app-hover/60 p-0.5"
          data-diary-markdown-mode=""
        >
          <button
            type="button"
            onClick={() => onModeChange("write")}
            title={t("diary.markdownWrite")}
            className={cn(
              "flex h-9 items-center gap-1 rounded-md px-2 text-[11px] transition-colors sm:h-auto sm:py-1",
              mode === "write" ? "bg-app-surface text-tx-primary shadow-sm" : "text-tx-tertiary hover:text-tx-secondary",
            )}
          >
            <Pencil size={12} />
            <span>{t("diary.markdownWrite")}</span>
          </button>
          <button
            type="button"
            onClick={() => onModeChange("preview")}
            title={t("diary.markdownPreview")}
            className={cn(
              "flex h-9 items-center gap-1 rounded-md px-2 text-[11px] transition-colors sm:h-auto sm:py-1",
              mode === "preview" ? "bg-app-surface text-tx-primary shadow-sm" : "text-tx-tertiary hover:text-tx-secondary",
            )}
          >
            <Eye size={12} />
            <span>{t("diary.markdownPreview")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

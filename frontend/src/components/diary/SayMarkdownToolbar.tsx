import React, { useCallback } from "react";
import {
  Bold,
  CheckSquare,
  Code2,
  Eye,
  List,
  ListOrdered,
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

function wrapSelection(
  text: string,
  start: number,
  end: number,
  prefix: string,
  suffix = prefix,
): SayMarkdownEditResult {
  const selected = text.slice(start, end);
  const placeholder = selected || "文本";
  const inserted = `${prefix}${placeholder}${suffix}`;
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    selectionStart: start + prefix.length,
    selectionEnd: start + prefix.length + placeholder.length,
  };
}

function prefixSelectedLines(
  text: string,
  start: number,
  end: number,
  prefixForIndex: (index: number) => string,
): SayMarkdownEditResult {
  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nextBreak = text.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  const block = text.slice(lineStart, lineEnd) || "内容";
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
): SayMarkdownEditResult {
  switch (action) {
    case "bold":
      return wrapSelection(text, start, end, "**");
    case "inlineCode":
      return wrapSelection(text, start, end, "`");
    case "bulletList":
      return prefixSelectedLines(text, start, end, () => "- ");
    case "orderedList":
      return prefixSelectedLines(text, start, end, (index) => `${index + 1}. `);
    case "taskList":
      return prefixSelectedLines(text, start, end, () => "- [ ] ");
    case "quote":
      return prefixSelectedLines(text, start, end, () => "> ");
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
    );
    onChange(result.text);
    requestAnimationFrame(() => {
      const next = textareaRef.current;
      if (!next) return;
      next.focus();
      next.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  }, [mode, onChange, textareaRef, value]);

  const actions: Array<{
    action: SayMarkdownAction;
    label: string;
    icon: React.ReactNode;
  }> = [
    { action: "bold", label: t("diary.markdownBold", { defaultValue: "加粗" }), icon: <Bold size={14} /> },
    { action: "bulletList", label: t("diary.markdownBulletList", { defaultValue: "无序列表" }), icon: <List size={14} /> },
    { action: "orderedList", label: t("diary.markdownOrderedList", { defaultValue: "有序列表" }), icon: <ListOrdered size={14} /> },
    { action: "taskList", label: t("diary.markdownTaskList", { defaultValue: "任务列表" }), icon: <CheckSquare size={14} /> },
    { action: "quote", label: t("diary.markdownQuote", { defaultValue: "引用" }), icon: <Quote size={14} /> },
    { action: "inlineCode", label: t("diary.markdownInlineCode", { defaultValue: "行内代码" }), icon: <Code2 size={14} /> },
  ];

  return (
    <div className="mt-2 flex items-center gap-1 overflow-x-auto border-t border-app-border/40 pt-2">
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
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded-md text-tx-tertiary transition-colors",
            mode === "write"
              ? "hover:bg-app-hover hover:text-tx-primary"
              : "cursor-not-allowed opacity-40",
          )}
        >
          {item.icon}
        </button>
      ))}
      <div className="mx-1 h-4 w-px shrink-0 bg-app-border" />
      <button
        type="button"
        onClick={() => onModeChange("write")}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
          mode === "write" ? "bg-app-hover text-tx-primary" : "text-tx-tertiary hover:text-tx-secondary",
        )}
      >
        <Pencil size={12} />
        {t("diary.markdownWrite", { defaultValue: "编辑" })}
      </button>
      <button
        type="button"
        onClick={() => onModeChange("preview")}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
          mode === "preview" ? "bg-app-hover text-tx-primary" : "text-tx-tertiary hover:text-tx-secondary",
        )}
      >
        <Eye size={12} />
        {t("diary.markdownPreview", { defaultValue: "预览" })}
      </button>
    </div>
  );
}

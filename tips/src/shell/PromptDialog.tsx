/**
 * 单行输入对话框（玻璃）—— 用于「新建待办」这类只要一个标题的场景。
 * 复用 Dialog 的玻璃外壳，保持一致观感。
 */
import { useEffect, useState } from "react";
import { Dialog } from "./Dialog";

export function PromptDialog({
  open,
  title,
  placeholder,
  initialValue = "",
  confirmLabel = "创建",
  onConfirm,
  onDismiss,
  busy = false,
}: {
  open: boolean;
  title: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onDismiss: () => void;
  busy?: boolean;
}) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  if (!open) return null;

  return (
    <Dialog
      open={open}
      title={title}
      message={
        <input
          className="dialog-input"
          autoFocus
          value={value}
          placeholder={placeholder}
          enterKeyHint="done"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim() && !busy) onConfirm(value.trim());
          }}
        />
      }
      actions={[
        {
          label: busy ? "处理中…" : confirmLabel,
          primary: true,
          onSelect: () => {
            if (value.trim() && !busy) onConfirm(value.trim());
          },
        },
        { label: "取消", onSelect: onDismiss },
      ]}
      onDismiss={onDismiss}
    />
  );
}

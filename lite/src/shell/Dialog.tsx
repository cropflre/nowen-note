/**
 * 玻璃对话框 —— 替代 window.confirm / alert。
 *
 * 为什么不用原生 confirm：
 *   1) 样式完全不可控，和液态玻璃 UI 割裂；
 *   2) 原生 confirm 只有「确定/取消」两个按钮，而版本冲突需要三个选项；
 *   3) 原生弹窗在自动化测试里要另开 dialog 监听，断言也更脆弱。
 *
 * 用 <dialog> 元素：自带焦点陷阱、Esc 关闭、顶层渲染，比自己搭 div 更省事。
 */
import { useEffect, useRef } from "react";

export interface DialogAction {
  label: string;
  /** 主按钮（蓝色实心）；不填则为次要样式 */
  primary?: boolean;
  /** 危险操作（红字） */
  danger?: boolean;
  onSelect: () => void;
}

export function Dialog({
  open,
  title,
  message,
  actions,
  onDismiss,
}: {
  open: boolean;
  title: string;
  message?: React.ReactNode;
  actions: DialogAction[];
  onDismiss?: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onDismiss) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onDismiss();
    };
    el.addEventListener("cancel", onCancel);
    return () => el.removeEventListener("cancel", onCancel);
  }, [onDismiss]);

  if (!open) return null;

  return (
    <dialog ref={ref} className="sheet">
      <div className="sheet-inner glass">
        <h2 className="sheet-title">{title}</h2>
        {message ? <div className="sheet-message">{message}</div> : null}
        <div className="sheet-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`btn ${a.primary ? "" : "btn-secondary"} ${
                a.danger ? "btn-danger" : ""
              }`}
              onClick={a.onSelect}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </dialog>
  );
}

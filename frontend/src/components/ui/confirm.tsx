/**
 * 全局确认/输入弹窗（替代浏览器原生 window.confirm / window.prompt）
 *
 * 设计目标：
 * 1. **命令式 API**：旧代码里的 `if (!window.confirm("..."))` 这种命令式调用
 *    很常见，强行改成"声明式 Modal"会让每个调用点都炸成一团 state。所以
 *    这里直接给一个 Promise 化的命令式 API：
 *
 *      const ok = await confirm({ title, description, danger: true });
 *      const password = await prompt({ title, type: "password" });
 *
 * 2. **栈式**：同一时刻可能弹多个（比如批量操作里的二次确认套确认），
 *    用栈管理，最后弹的最先关。
 *
 * 3. **零 Provider 入侵**：函数式 API（导出的 confirm/prompt）通过 module
 *    级 dispatcher 派发，组件内可以直接 `import { confirm } from "@/components/ui/confirm"`
 *    使用。但仍然要在 App 顶层挂一次 <ConfirmProvider />，否则会回退到
 *    浏览器原生（保底，避免逻辑彻底中断）。
 *
 * 4. **样式与产品深浅色一致**：复用 app 设计 token（app-surface / accent-primary
 *    / tx-* 等）。危险操作（danger: true）按钮用红色，并默认聚焦在"取消"。
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  /** 弹窗标题，必填 */
  title: string;
  /** 描述文本，支持多行（\n 自动转换为段落分隔）；也可以传 ReactNode 自由排版 */
  description?: React.ReactNode;
  /** 确认按钮文案，默认 "确定" */
  confirmText?: string;
  /** 取消按钮文案，默认 "取消" */
  cancelText?: string;
  /** 是否危险操作：true 时确认按钮变红 + 顶部出现告警图标 + 默认聚焦取消 */
  danger?: boolean;
}

export interface PromptOptions extends ConfirmOptions {
  /** 输入框初始值 */
  defaultValue?: string;
  /** 输入框 placeholder */
  placeholder?: string;
  /** 输入类型：text / password / email / number 等，默认 text */
  type?: React.HTMLInputTypeAttribute;
  /** 自定义验证：返回 string 则视为错误信息阻止提交，返回 null/undefined 视为通过 */
  validate?: (value: string) => string | null | undefined;
  /** 是否允许空值提交，默认 false（空值会被拒绝） */
  allowEmpty?: boolean;
}

export interface ChoiceOption {
  value: string;
  label: string;
  variant?: "default" | "outline" | "destructive";
}

export interface ChoiceOptions extends ConfirmOptions {
  choices: ChoiceOption[];
}

type StackItem =
  | {
      kind: "confirm";
      id: number;
      options: ConfirmOptions;
      resolve: (ok: boolean) => void;
    }
  | {
      kind: "prompt";
      id: number;
      options: PromptOptions;
      resolve: (value: string | null) => void;
    }
  | {
      kind: "choice";
      id: number;
      options: ChoiceOptions;
      resolve: (value: string | null) => void;
    };

// ---------------------------------------------------------------------------
// 全局 dispatcher（module 级单例）
// ---------------------------------------------------------------------------

type Dispatcher = {
  push: (item: Omit<StackItem, "id">) => number;
  resolve: (id: number, value: any) => void;
};

let dispatcher: Dispatcher | null = null;
let nextId = 1;
// 在 Provider 还没挂载时短暂排队的 pending（理论上 Provider 应该最早挂载，
// 这里只是兜底；超时仍未挂载会回退到浏览器原生）。
const pending: Array<{ item: Omit<StackItem, "id">; bind: (id: number) => void }> = [];

function setDispatcher(d: Dispatcher | null) {
  dispatcher = d;
  if (d) {
    while (pending.length) {
      const { item, bind } = pending.shift()!;
      const id = d.push(item);
      bind(id);
    }
  }
}

/**
 * 命令式 confirm。返回 Promise<boolean>。
 * 用法：
 *   const ok = await confirm({ title: "删除？", danger: true });
 *   if (!ok) return;
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const item: Omit<StackItem, "id"> = { kind: "confirm", options, resolve };
    if (dispatcher) {
      dispatcher.push(item);
      return;
    }
    // 兜底：100ms 内还没 Provider 就回退到原生
    let bound = false;
    const bind = (_id: number) => {
      bound = true;
    };
    pending.push({ item, bind });
    setTimeout(() => {
      if (!bound && !dispatcher) {
        // 移出队列并回退原生
        const idx = pending.findIndex((p) => p.item === item);
        if (idx >= 0) pending.splice(idx, 1);
        const fallback = window.confirm(
          [options.title, typeof options.description === "string" ? options.description : ""]
            .filter(Boolean)
            .join("\n\n"),
        );
        resolve(fallback);
      }
    }, 100);
  });
}

/**
 * 命令式 prompt。返回 Promise<string | null>，取消返回 null。
 */
export function prompt(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const item: Omit<StackItem, "id"> = { kind: "prompt", options, resolve };
    if (dispatcher) {
      dispatcher.push(item);
      return;
    }
    let bound = false;
    const bind = (_id: number) => {
      bound = true;
    };
    pending.push({ item, bind });
    setTimeout(() => {
      if (!bound && !dispatcher) {
        const idx = pending.findIndex((p) => p.item === item);
        if (idx >= 0) pending.splice(idx, 1);
        const fallback = window.prompt(
          [options.title, typeof options.description === "string" ? options.description : ""]
            .filter(Boolean)
            .join("\n\n"),
          options.defaultValue ?? "",
        );
        resolve(fallback);
      }
    }, 100);
  });
}

// ---------------------------------------------------------------------------
// Hook 形式（如果组件内更喜欢 hook 风格）
// ---------------------------------------------------------------------------

export function choose(options: ChoiceOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const item: Omit<StackItem, "id"> = { kind: "choice", options, resolve };
    if (dispatcher) {
      dispatcher.push(item);
      return;
    }
    let bound = false;
    const bind = (_id: number) => { bound = true; };
    pending.push({ item, bind });
    setTimeout(() => {
      if (!bound && !dispatcher) {
        const idx = pending.findIndex((entry) => entry.item === item);
        if (idx >= 0) pending.splice(idx, 1);
        const fallback = window.confirm(
          [options.title, typeof options.description === "string" ? options.description : ""]
            .filter(Boolean)
            .join("\n\n"),
        );
        resolve(fallback ? options.choices[0]?.value ?? null : null);
      }
    }, 100);
  });
}

export function useConfirm() {
  return confirm;
}
export function usePrompt() {
  return prompt;
}
export function useChoice() {
  return choose;
}

// ---------------------------------------------------------------------------
// Provider + 渲染
// ---------------------------------------------------------------------------

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = React.useState<StackItem[]>([]);

  React.useEffect(() => {
    const d: Dispatcher = {
      push: (item) => {
        const id = nextId++;
        setStack((prev) => [...prev, { ...item, id } as StackItem]);
        return id;
      },
      resolve: (id, value) => {
        setStack((prev) => {
          const target = prev.find((it) => it.id === id);
          if (target) {
            // resolve 在 setState 同步阶段调用是安全的（回调是用户的 then）
            (target.resolve as any)(value);
          }
          return prev.filter((it) => it.id !== id);
        });
      },
    };
    setDispatcher(d);
    return () => {
      setDispatcher(null);
    };
  }, []);

  // ESC 关闭最上层（取消语义）
  React.useEffect(() => {
    if (stack.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const top = stack[stack.length - 1];
        if (!top) return;
        e.stopPropagation();
        if (top.kind === "confirm") top.resolve(false);
        else top.resolve(null);
        setStack((prev) => prev.filter((it) => it.id !== top.id));
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [stack]);

  const close = (id: number, value: any) => {
    setStack((prev) => {
      const target = prev.find((it) => it.id === id);
      if (target) (target.resolve as any)(value);
      return prev.filter((it) => it.id !== id);
    });
  };

  return (
    <>
      {children}
      {createPortal(
        <AnimatePresence>
          {stack.map((item, idx) => {
            const isTop = idx === stack.length - 1;
            return (
              <DialogShell
                key={item.id}
                item={item}
                isTop={isTop}
                onCancel={() =>
                  close(item.id, item.kind === "confirm" ? false : null)
                }
                onConfirm={(value) =>
                  close(item.id, item.kind === "confirm" ? true : value)
                }
              />
            );
          })}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 单个对话框
// ---------------------------------------------------------------------------

function DialogShell({
  item,
  isTop,
  onCancel,
  onConfirm,
}: {
  item: StackItem;
  isTop: boolean;
  onCancel: () => void;
  onConfirm: (value?: string) => void;
}) {
  const { title, description, confirmText, cancelText, danger } = item.options;

  // prompt 专属
  const isPrompt = item.kind === "prompt";
  const isChoice = item.kind === "choice";
  const promptOpts = isPrompt ? (item.options as PromptOptions) : null;
  const choiceOpts = isChoice ? (item.options as ChoiceOptions) : null;
  const [value, setValue] = React.useState(promptOpts?.defaultValue ?? "");
  const [error, setError] = React.useState<string | null>(null);

  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const cancelBtnRef = React.useRef<HTMLButtonElement | null>(null);
  const confirmBtnRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    // 自动聚焦：prompt 优先聚焦输入框；danger 默认聚焦取消（防误回车）；其它聚焦确认
    const t = setTimeout(() => {
      if (isPrompt) inputRef.current?.focus();
      else if (isChoice || danger) cancelBtnRef.current?.focus();
      else confirmBtnRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [isPrompt, isChoice, danger]);

  const submit = () => {
    if (isPrompt) {
      const v = value;
      if (!promptOpts!.allowEmpty && v.trim() === "") {
        setError("不能为空");
        return;
      }
      const err = promptOpts!.validate?.(v);
      if (err) {
        setError(err);
        return;
      }
      onConfirm(v);
    } else {
      onConfirm();
    }
  };

  // 描述文本：字符串自动按 \n\n 拆段；ReactNode 直接渲染
  const renderDescription = () => {
    if (description == null) return null;
    if (typeof description !== "string") return description;
    return description.split(/\n\n+/).map((para, i) => (
      <p key={i} className="whitespace-pre-line">
        {para}
      </p>
    ));
  };

  return (
    <motion.div
      className={cn(
        "fixed inset-0 z-[10000] flex items-center justify-center px-4",
        isTop ? "pointer-events-auto" : "pointer-events-none",
      )}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onMouseDown={(e) => {
        // 点击遮罩 = 取消（仅最顶层；点 dialog 本体不会冒泡到这里）
        if (isTop && e.target === e.currentTarget) onCancel();
      }}
    >
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />

      {/* 对话框 */}
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ scale: 0.95, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.97, opacity: 0, y: 4 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="relative z-10 w-full max-w-md rounded-xl border border-app-border bg-app-surface shadow-xl overflow-hidden"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isChoice && (isPrompt || !danger)) {
            // prompt：回车提交；confirm 非危险：回车确认；危险确认默认要点
            e.preventDefault();
            submit();
          }
        }}
      >
        {/* 关闭 X */}
        <button
          type="button"
          onClick={onCancel}
          className="absolute right-3 top-3 p-1 rounded-md text-tx-tertiary hover:text-tx-primary hover:bg-app-hover transition-colors"
          aria-label={cancelText || "关闭"}
        >
          <X size={16} />
        </button>

        <div className="p-5 pb-4">
          <div className="flex items-start gap-3">
            {danger && (
              <div className="shrink-0 mt-0.5 w-9 h-9 rounded-full bg-red-500/10 text-red-500 flex items-center justify-center">
                <AlertTriangle size={18} />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-tx-primary leading-tight pr-6">
                {title}
              </h3>
              {description != null && (
                <div className="mt-2 text-sm text-tx-secondary space-y-2 leading-relaxed">
                  {renderDescription()}
                </div>
              )}
            </div>
          </div>

          {isPrompt && (
            <div className="mt-4">
              <Input
                ref={inputRef}
                type={promptOpts!.type ?? "text"}
                value={value}
                placeholder={promptOpts!.placeholder}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error) setError(null);
                }}
                aria-invalid={!!error}
                className={cn(error && "border-red-500 focus-visible:ring-red-500")}
              />
              {error && (
                <p className="mt-1.5 text-xs text-red-500">{error}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 bg-app-bg/40 border-t border-app-border">
          <Button
            ref={cancelBtnRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
          >
            {cancelText || "取消"}
          </Button>
          {isChoice ? (
            choiceOpts!.choices.map((choice) => (
              <Button
                key={choice.value}
                type="button"
                size="sm"
                variant={choice.variant || "default"}
                onClick={() => onConfirm(choice.value)}
              >
                {choice.label}
              </Button>
            ))
          ) : (
            <Button
              ref={confirmBtnRef}
              type="button"
              size="sm"
              variant={danger ? "destructive" : "default"}
              onClick={submit}
              className={cn(
                danger &&
                  "bg-red-500 hover:bg-red-500/90 text-white border-transparent",
              )}
            >
              {confirmText || "确定"}
            </Button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

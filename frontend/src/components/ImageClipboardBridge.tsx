import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardPaste, Copy, Scissors, X } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  buildImageClipboardPasteTransaction,
  createImageClipboardPayload,
  mapImageClipboardPayload,
  type ImageClipboardMode,
  type ImageClipboardPayload,
} from "@/lib/imageNodeClipboard";

type TiptapEditorLike = {
  state: any;
  view: any;
  isDestroyed?: boolean;
  on: (event: string, callback: (payload: any) => void) => void;
  off: (event: string, callback: (payload: any) => void) => void;
};

type RuntimeClipboard = ImageClipboardPayload & {
  editor: TiptapEditorLike;
};

const CLIPBOARD_HOST_ATTR = "data-nowen-image-clipboard-slot";

function editorFromDom(dom: HTMLElement | null): TiptapEditorLike | null {
  return (dom as (HTMLElement & { editor?: TiptapEditorLike }) | null)?.editor || null;
}

function selectedImageEditor(): TiptapEditorLike | null {
  const editors = Array.from(document.querySelectorAll<HTMLElement>('.ProseMirror[contenteditable="true"]'));
  for (const dom of editors) {
    const editor = editorFromDom(dom);
    const selection = editor?.state?.selection;
    if (selection?.node?.type?.name === "image") return editor || null;
  }
  return null;
}

function ensureClipboardHost(): HTMLElement | null {
  const transformSlot = document.querySelector<HTMLElement>('[data-nowen-image-transform-slot="true"]');
  const panel = transformSlot?.parentElement;
  if (!transformSlot || !panel) return null;

  let host = panel.querySelector<HTMLElement>(`:scope > [${CLIPBOARD_HOST_ATTR}="true"]`);
  if (!host) {
    host = document.createElement("div");
    host.setAttribute(CLIPBOARD_HOST_ATTR, "true");
    transformSlot.insertAdjacentElement("afterend", host);
  }
  return host;
}

function closeImageActions(host: HTMLElement | null): void {
  const sheet = host?.closest<HTMLElement>(".fixed.bottom-0.left-0.right-0");
  const closeButton = sheet?.querySelector<HTMLButtonElement>(
    'button[aria-label="关闭"], button[aria-label="Close"], button[aria-label="关闭图片操作"], button[aria-label="Close image actions"]',
  ) || sheet?.querySelector<HTMLButtonElement>(".mb-3 button");
  closeButton?.click();
}

function sourceWrapper(editor: TiptapEditorLike, pos: number): HTMLElement | null {
  const dom = editor.view?.nodeDOM?.(pos) as HTMLElement | null;
  if (!dom) return null;
  if (dom.classList.contains("resizable-image-wrapper")) return dom;
  return dom.querySelector<HTMLElement>(".resizable-image-wrapper")
    || dom.closest<HTMLElement>(".resizable-image-wrapper")
    || dom;
}

function keyboardInset(): number {
  if (typeof window === "undefined") return 0;
  const viewport = window.visualViewport;
  if (!viewport) return 0;
  return Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
}

export default function ImageClipboardBridge() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [selectedEditor, setSelectedEditor] = useState<TiptapEditorLike | null>(null);
  const [clipboard, setClipboard] = useState<RuntimeClipboard | null>(null);
  const clipboardRef = useRef<RuntimeClipboard | null>(null);
  const applyingRef = useRef(false);
  const [bottomInset, setBottomInset] = useState(() => keyboardInset());

  const updateClipboard = useCallback((next: RuntimeClipboard | null) => {
    clipboardRef.current = next;
    setClipboard(next);
  }, []);

  useEffect(() => {
    let frame = 0;
    const reconcile = () => {
      frame = 0;
      const nextEditor = selectedImageEditor();
      const nextHost = nextEditor ? ensureClipboardHost() : null;
      setSelectedEditor((current) => current === nextEditor ? current : nextEditor);
      setHost((current) => current === nextHost ? current : nextHost);

      const pending = clipboardRef.current;
      if (pending && (pending.editor.isDestroyed || !pending.editor.view?.dom?.isConnected)) {
        updateClipboard(null);
      }
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reconcile);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true });
    window.addEventListener("resize", schedule, { passive: true });
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.querySelectorAll<HTMLElement>(`[${CLIPBOARD_HOST_ATTR}="true"]`).forEach((node) => node.remove());
    };
  }, [updateClipboard]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const sync = () => setBottomInset(keyboardInset());
    viewport?.addEventListener("resize", sync);
    viewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync, { passive: true });
    sync();
    return () => {
      viewport?.removeEventListener("resize", sync);
      viewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

  useEffect(() => {
    if (!clipboard) return;
    const editor = clipboard.editor;
    const onTransaction = ({ transaction }: { transaction: any }) => {
      if (applyingRef.current || !transaction) return;
      const current = clipboardRef.current;
      if (!current || current.editor !== editor) return;
      const mapped = mapImageClipboardPayload(current, transaction);
      if (!mapped) {
        updateClipboard(null);
        return;
      }
      if (mapped.sourcePos !== current.sourcePos) {
        updateClipboard({ ...current, sourcePos: mapped.sourcePos });
      }
    };
    editor.on("transaction", onTransaction);
    return () => editor.off("transaction", onTransaction);
  }, [clipboard?.editor, updateClipboard]);

  useEffect(() => {
    if (!clipboard || clipboard.mode !== "cut") return;
    const wrapper = sourceWrapper(clipboard.editor, clipboard.sourcePos);
    if (!wrapper) return;
    const previousOpacity = wrapper.style.opacity;
    const previousOutline = wrapper.style.outline;
    const previousOutlineOffset = wrapper.style.outlineOffset;
    wrapper.dataset.nowenImageCutPending = "true";
    wrapper.style.opacity = "0.55";
    wrapper.style.outline = "2px dashed var(--color-accent-primary, #3b82f6)";
    wrapper.style.outlineOffset = "3px";
    return () => {
      delete wrapper.dataset.nowenImageCutPending;
      wrapper.style.opacity = previousOpacity;
      wrapper.style.outline = previousOutline;
      wrapper.style.outlineOffset = previousOutlineOffset;
    };
  }, [clipboard?.editor, clipboard?.mode, clipboard?.sourcePos]);

  const capture = useCallback((mode: ImageClipboardMode) => {
    const editor = selectedEditor;
    if (!editor || editor.isDestroyed) return;
    const payload = createImageClipboardPayload(editor.state, mode);
    if (!payload) {
      toast.error("请先选择一张图片");
      return;
    }
    updateClipboard({ ...payload, editor });
    closeImageActions(host);
    toast.success(mode === "copy"
      ? "图片已复制，请点击目标位置后粘贴"
      : "图片已剪切，请点击目标位置后粘贴；粘贴成功前原图不会删除");
  }, [host, selectedEditor, updateClipboard]);

  const paste = useCallback(() => {
    const current = clipboardRef.current;
    if (!current || current.editor.isDestroyed) return;
    const editor = current.editor;
    if (!editor.view?.dom?.isConnected) {
      updateClipboard(null);
      return;
    }
    if (typeof editor.view.hasFocus === "function" && !editor.view.hasFocus()) {
      toast.info("请先点击当前笔记中要粘贴的位置");
      return;
    }

    const result = buildImageClipboardPasteTransaction(editor.state, current);
    if (result.status === "source-missing") {
      updateClipboard(null);
      toast.error("原图片位置已变化，请重新复制或剪切");
      return;
    }
    if (result.status === "same-position") {
      toast.info("请先点击图片要移动到的位置");
      return;
    }

    const mappedAfterCopy = current.mode === "copy"
      ? mapImageClipboardPayload(current, result.transaction)
      : null;
    applyingRef.current = true;
    try {
      editor.view.dispatch(result.transaction);
    } finally {
      applyingRef.current = false;
    }

    if (current.mode === "cut") {
      updateClipboard(null);
      toast.success("图片已移动到新位置");
    } else if (mappedAfterCopy) {
      updateClipboard({ ...current, sourcePos: mappedAfterCopy.sourcePos });
      toast.success("图片已粘贴，可继续选择其他位置粘贴");
    } else {
      updateClipboard(null);
      toast.success("图片已粘贴");
    }
  }, [updateClipboard]);

  const menu = host && selectedEditor
    ? createPortal(
        <div
          className="mt-2 grid grid-cols-2 gap-1.5"
          data-nowen-image-clipboard-actions="true"
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => capture("copy")}
            className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-surface text-[11px] text-tx-secondary active:bg-app-hover"
          >
            <Copy size={14} /> 复制图片
          </button>
          <button
            type="button"
            onClick={() => capture("cut")}
            className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-surface text-[11px] text-tx-secondary active:bg-app-hover"
          >
            <Scissors size={14} /> 剪切图片
          </button>
        </div>,
        host,
      )
    : null;

  const pasteBar = clipboard && typeof document !== "undefined"
    ? createPortal(
        <div
          className="fixed left-3 right-3 z-[80] mx-auto flex max-w-md items-center gap-2 rounded-2xl border border-app-border bg-app-elevated px-3 py-2.5 shadow-2xl"
          style={{ bottom: Math.max(12, bottomInset + 12) }}
          data-nowen-image-clipboard-bar="true"
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs font-medium text-tx-primary">
              {clipboard.mode === "cut" ? <Scissors size={14} /> : <Copy size={14} />}
              {clipboard.mode === "cut" ? "已剪切图片" : "已复制图片"}
            </div>
            <div className="mt-0.5 truncate text-[10px] text-tx-tertiary">
              点击正文目标位置，再粘贴到这里
            </div>
          </div>
          <button
            type="button"
            onClick={paste}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-accent-primary px-3 text-xs font-medium text-white active:opacity-80"
          >
            <ClipboardPaste size={14} /> 粘贴到这里
          </button>
          <button
            type="button"
            aria-label="取消图片剪贴"
            onClick={() => updateClipboard(null)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-tx-secondary active:bg-app-hover"
          >
            <X size={16} />
          </button>
        </div>,
        document.body,
      )
    : null;

  return <>{menu}{pasteBar}</>;
}

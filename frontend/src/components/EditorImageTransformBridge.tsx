import React, { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useTranslation } from "react-i18next";
import { NodeSelection } from "@tiptap/pm/state";
import { FlipHorizontal, RotateCcw, RotateCw, Scan } from "lucide-react";
import {
  getPersistentImageTransform,
  normalizeImageFlipX,
  normalizeImageRotation,
  type ImageRotation,
} from "@/lib/imageNodeTransformBootstrap";
import { computeEditorImageTransformLayout } from "@/lib/editorImageTransformLayout";

interface TiptapEditorLike {
  state: any;
  view: any;
  chain: () => any;
  on: (event: string, callback: () => void) => void;
  off: (event: string, callback: () => void) => void;
}

const MOBILE_BACKDROP_SELECTOR = [
  'button[aria-label="关闭图片操作"]',
  'button[aria-label="Close image actions"]',
].join(",");
const originalBackdropPointerEvents = new WeakMap<HTMLButtonElement, string>();
const imageLoadListeners = new WeakSet<HTMLImageElement>();

function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)")?.matches === true;
}

export function findImageTransformWrapper(dom: HTMLElement | null): HTMLElement | null {
  if (!dom) return null;
  if (dom.classList.contains("resizable-image-wrapper")) return dom;
  return dom.querySelector<HTMLElement>(".resizable-image-wrapper")
    || dom.closest<HTMLElement>(".resizable-image-wrapper");
}

function hasSelectedEditorImage(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('.ProseMirror[contenteditable="true"]')).some((editorDom) => {
    const editor = (editorDom as HTMLElement & { editor?: TiptapEditorLike }).editor;
    const selection = editor?.state?.selection;
    if (!editor?.view || selection?.node?.type?.name !== "image") return false;
    return !!findImageTransformWrapper(editor.view.nodeDOM(selection.from) as HTMLElement | null);
  });
}

function positive(value: unknown): number | null {
  const numeric = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function setStyle(element: HTMLElement, property: keyof CSSStyleDeclaration, value: string): void {
  if (element.style[property] !== value) {
    (element.style[property] as string) = value;
  }
}

function availableImageWidth(wrapper: HTMLElement, fallback: number): number {
  const parent = wrapper.parentElement;
  const parentWidth = parent?.clientWidth
    || wrapper.closest<HTMLElement>(".ProseMirror")?.clientWidth
    || fallback;
  const style = getComputedStyle(wrapper);
  const margins = (positive(style.marginLeft) || 0) + (positive(style.marginRight) || 0);
  return Math.max(1, parentWidth - margins);
}

/**
 * Keep the editor's selection frame in normal document flow and rotate only the visual image.
 * This prevents 90°/270° images from painting over the following paragraph, and keeps handles
 * plus the live `px` badge readable instead of rotating them with the bitmap.
 */
export function applyImageTransformLayout(
  wrapper: HTMLElement,
  rotation: ImageRotation,
  flipX: boolean,
): boolean {
  const image = wrapper.querySelector<HTMLImageElement>("img");
  if (!image) return false;

  const measuredWidth = image.offsetWidth;
  const measuredHeight = image.offsetHeight;
  const naturalWidth = image.naturalWidth
    || positive(image.getAttribute("width"))
    || measuredWidth;
  const naturalHeight = image.naturalHeight
    || (measuredWidth > 0 && measuredHeight > 0 && naturalWidth > 0
      ? naturalWidth * measuredHeight / measuredWidth
      : measuredHeight);

  if (!naturalWidth || !naturalHeight) {
    if (!imageLoadListeners.has(image)) {
      imageLoadListeners.add(image);
      image.addEventListener("load", () => {
        imageLoadListeners.delete(image);
        requestAnimationFrame(syncAllImageWrappers);
      }, { once: true });
    }
    return false;
  }

  const attributeWidth = positive(image.getAttribute("width"));
  let requestedWidth = attributeWidth
    || positive(image.dataset.nowenRequestedImageWidth)
    || measuredWidth
    || naturalWidth;
  if (!attributeWidth && !image.dataset.nowenRequestedImageWidth) {
    image.dataset.nowenRequestedImageWidth = String(requestedWidth);
  }

  const layout = computeEditorImageTransformLayout({
    requestedWidth,
    naturalWidth,
    naturalHeight,
    availableWidth: availableImageWidth(wrapper, requestedWidth),
    rotation,
  });
  if (!layout) return false;

  wrapper.dataset.imageRotation = String(rotation);
  wrapper.dataset.imageFlipX = flipX ? "true" : "false";
  wrapper.dataset.nowenRotationLayout = "frame";

  // React's NodeView historically wrote the transform on this wrapper. Explicitly neutralize
  // it because wrapper children include the selection outline, four handles and size tooltip.
  setStyle(wrapper, "transform", "none");
  setStyle(wrapper, "transformOrigin", "center center");
  setStyle(wrapper, "transition", "none");
  setStyle(wrapper, "width", `${layout.frameWidth}px`);
  setStyle(wrapper, "height", `${layout.frameHeight}px`);
  setStyle(wrapper, "maxWidth", "100%");
  setStyle(wrapper, "overflow", "visible");
  setStyle(wrapper, "verticalAlign", "middle");

  // 图片节点在 ProseMirror 模型中保持 inline，以免破坏有序列表结构；但横图旋转为
  // 竖图后占位宽度会明显变窄，外层若继续参与行内排版就会被塞进上一行的剩余空间。
  // 仅在 90°/270° 时让 React NodeView 独占一行，复原后恢复原有行内语义。
  const flowHost = wrapper.closest<HTMLElement>(".react-renderer.node-image") || wrapper;
  setStyle(flowHost, "display", layout.sideways
    ? "block"
    : flowHost === wrapper ? "inline-block" : "inline");

  const persistentTransform = getPersistentImageTransform(rotation, flipX);
  const visualTransform = `translate(-50%, -50%)${persistentTransform ? ` ${persistentTransform}` : ""}`;
  image.dataset.nowenImageVisual = "true";
  setStyle(image, "position", "absolute");
  setStyle(image, "left", "50%");
  setStyle(image, "top", "50%");
  setStyle(image, "width", `${layout.imageWidth}px`);
  setStyle(image, "height", `${layout.imageHeight}px`);
  setStyle(image, "maxWidth", "none");
  setStyle(image, "transform", visualTransform);
  setStyle(image, "transformOrigin", "center center");
  setStyle(image, "transition", isCoarsePointer() ? "none" : "transform 160ms ease");

  // Old bridge versions swapped cursors because the entire wrapper rotated. Handles are now
  // axis-aligned, so restore their original cursor direction.
  wrapper.querySelectorAll<HTMLElement>('span[style*="resize"]').forEach((handle) => {
    const original = handle.dataset.originalResizeCursor || handle.style.cursor;
    if (!original) return;
    handle.dataset.originalResizeCursor = original;
    if (handle.style.cursor !== original) handle.style.cursor = original;
  });
  return true;
}

function syncAllImageWrappers(): void {
  document.querySelectorAll<HTMLElement>(".resizable-image-wrapper").forEach((wrapper) => {
    applyImageTransformLayout(
      wrapper,
      normalizeImageRotation(wrapper.dataset.imageRotation),
      normalizeImageFlipX(wrapper.dataset.imageFlipX),
    );
  });
}

/**
 * The compact Android image menu renders a transparent fixed backdrop above the editor.
 * Let pointer/touch events pass through that backdrop so a visible resize handle works on the
 * first drag. The action sheet itself remains interactive because it is a separate z-70 node.
 */
export function allowImageResizeThroughMobileBackdrop(root: ParentNode = document): number {
  const backdrops = Array.from(root.querySelectorAll<HTMLButtonElement>(MOBILE_BACKDROP_SELECTOR));
  backdrops.forEach((button) => {
    if (!originalBackdropPointerEvents.has(button)) {
      originalBackdropPointerEvents.set(button, button.style.pointerEvents || "");
    }
    button.dataset.nowenImageBackdropPassthrough = "true";
    if (button.style.pointerEvents !== "none") button.style.pointerEvents = "none";
  });
  return backdrops.length;
}

function restoreMobileBackdropPointerCapture(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('[data-nowen-image-backdrop-passthrough="true"]').forEach((button) => {
    const original = originalBackdropPointerEvents.get(button) ?? "";
    if (original) button.style.pointerEvents = original;
    else button.style.removeProperty("pointer-events");
    delete button.dataset.nowenImageBackdropPassthrough;
    originalBackdropPointerEvents.delete(button);
  });
}

export function updateImageAttributesAt(
  editor: Pick<TiptapEditorLike, "state" | "view">,
  pos: number,
  attrs: Record<string, unknown>,
): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (node?.type?.name !== "image") return false;

  const selection = editor.state.selection;
  const keepNodeSelection = selection?.node?.type?.name === "image"
    && Number(selection.from) === pos;

  let transaction = editor.state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    ...attrs,
  });

  if (keepNodeSelection) {
    const mappedPos = transaction.mapping.map(pos);
    const updatedNode = transaction.doc.nodeAt(mappedPos);
    if (updatedNode?.type?.name === "image") {
      transaction = transaction.setSelection(NodeSelection.create(transaction.doc, mappedPos));
    }
  }

  editor.view.dispatch(transaction);
  return true;
}

function TransformButton({
  label,
  active,
  onClick,
  children,
  mobile = false,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  mobile?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={mobile
        ? `flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border px-1.5 text-[11px] ${active ? "border-accent-primary bg-accent-primary/10 text-accent-primary" : "border-app-border bg-app-surface text-tx-secondary active:bg-app-hover"}`
        : `shrink-0 rounded-md p-1.5 transition-colors ${active ? "bg-accent-primary/20 text-accent-primary" : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"}`}
    >
      {children}
    </button>
  );
}

export default function EditorImageTransformBridge() {
  const reconcile = useCallback(() => {
    syncAllImageWrappers();
    if (hasSelectedEditorImage()) allowImageResizeThroughMobileBackdrop();
    else restoreMobileBackdropPointerCapture();
  }, []);

  useEffect(() => {
    let frame = 0;
    let attachedEditor: TiptapEditorLike | null = null;
    let observedEditorDom: HTMLElement | null = null;
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reconcile);
    };
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(schedule)
      : null;
    const attachEditor = () => {
      const editorDom = document.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
      const editor = (editorDom as (HTMLElement & { editor?: TiptapEditorLike }) | null)?.editor || null;
      if (editor !== attachedEditor) {
        if (attachedEditor) {
          attachedEditor.off("selectionUpdate", schedule);
          attachedEditor.off("transaction", schedule);
          attachedEditor.off("focus", schedule);
          attachedEditor.off("blur", schedule);
        }
        attachedEditor = editor;
        if (attachedEditor) {
          attachedEditor.on("selectionUpdate", schedule);
          attachedEditor.on("transaction", schedule);
          attachedEditor.on("focus", schedule);
          attachedEditor.on("blur", schedule);
        }
      }
      if (editorDom !== observedEditorDom) {
        if (observedEditorDom) resizeObserver?.unobserve(observedEditorDom);
        observedEditorDom = editorDom;
        if (observedEditorDom) resizeObserver?.observe(observedEditorDom);
      }
    };
    const observe = () => {
      attachEditor();
      schedule();
    };
    const prepareResizeMeasurement = (event: Event) => {
      const handle = event.target instanceof HTMLElement ? event.target : null;
      if (!handle?.style.cursor.includes("resize")) return;
      const wrapper = handle.closest<HTMLElement>(".resizable-image-wrapper");
      const image = wrapper?.querySelector<HTMLImageElement>('img[data-nowen-image-visual="true"]');
      const transform = image?.style.transform || "";
      if (!image || !transform) return;
      const transition = image.style.transition;
      // ResizableImageView reads getBoundingClientRect().width on pointer down. Remove only the
      // bitmap transform during that synchronous event so it receives the unrotated image width.
      image.style.transition = "none";
      image.style.transform = "none";
      queueMicrotask(() => {
        if (!image.isConnected) return;
        image.style.transform = transform;
        image.style.transition = transition;
      });
    };

    observe();
    const observer = new MutationObserver(observe);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "aria-label",
        "width",
        "src",
        "data-image-rotation",
        "data-image-flip-x",
      ],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("mousedown", prepareResizeMeasurement, true);
    document.addEventListener("touchstart", prepareResizeMeasurement, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("mousedown", prepareResizeMeasurement, true);
      document.removeEventListener("touchstart", prepareResizeMeasurement, true);
      restoreMobileBackdropPointerCapture();
      if (attachedEditor) {
        attachedEditor.off("selectionUpdate", schedule);
        attachedEditor.off("transaction", schedule);
        attachedEditor.off("focus", schedule);
        attachedEditor.off("blur", schedule);
      }
    };
  }, [reconcile]);

  return null;
}

/** Render beside the image actions, using the owning editor rather than global DOM discovery. */
export function EditorImageTransformControls({ editor, mobile = false }: { editor: Editor; mobile?: boolean }) {
  const { i18n } = useTranslation();
  const english = i18n.language?.toLowerCase().startsWith("en");
  const [, refresh] = useState(0);
  useEffect(() => {
    const update = () => refresh((value) => value + 1);
    editor.on("transaction", update);
    return () => { editor.off("transaction", update); };
  }, [editor]);

  const selection = editor.state.selection;
  if (!editor.isEditable || !(selection instanceof NodeSelection) || selection.node.type.name !== "image") return null;
  const labels = english
    ? { left: "Rotate left 90°", right: "Rotate right 90°", flip: "Flip horizontally", reset: "Reset transform", group: "Rotate and flip" }
    : { left: "向左旋转 90°", right: "向右旋转 90°", flip: "水平翻转", reset: "复原变换", group: "旋转与翻转" };
  const flipX = normalizeImageFlipX(selection.node.attrs.flipX);
  const update = (transform: (attrs: Record<string, unknown>) => Record<string, unknown>) => {
    const current = editor.state.selection;
    if (!editor.isEditable || !(current instanceof NodeSelection) || current.node.type.name !== "image") return;
    updateImageAttributesAt(editor, current.from, transform(current.node.attrs));
  };
  const buttons = <>
    <TransformButton mobile={mobile} label={labels.left} onClick={() => update((attrs) => ({ rotation: normalizeImageRotation(normalizeImageRotation(attrs.rotation) - 90) }))}>
      <RotateCcw size={14} />{mobile && (english ? "Left" : "左转")}
    </TransformButton>
    <TransformButton mobile={mobile} label={labels.right} onClick={() => update((attrs) => ({ rotation: normalizeImageRotation(normalizeImageRotation(attrs.rotation) + 90) }))}>
      <RotateCw size={14} />{mobile && (english ? "Right" : "右转")}
    </TransformButton>
    <TransformButton mobile={mobile} label={labels.flip} active={flipX} onClick={() => update((attrs) => ({ flipX: !normalizeImageFlipX(attrs.flipX) }))}>
      <FlipHorizontal size={14} />{mobile && (english ? "Flip" : "翻转")}
    </TransformButton>
    <TransformButton mobile={mobile} label={labels.reset} onClick={() => update(() => ({ rotation: 0, flipX: false }))}>
      <Scan size={14} />{mobile && (english ? "Reset" : "复原")}
    </TransformButton>
  </>;
  return mobile ? (
    <div className="mt-2 grid grid-cols-4 gap-1.5" data-nowen-editor-image-transforms="true" role="group" aria-label={labels.group}>{buttons}</div>
  ) : <><div className="mx-0.5 h-4 w-px shrink-0 bg-app-border" aria-hidden="true" />{buttons}</>;
}

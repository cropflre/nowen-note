import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FlipHorizontal, RotateCcw, RotateCw } from "lucide-react";
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

interface ImageTarget {
  editor: TiptapEditorLike;
  pos: number;
  wrapper: HTMLElement;
  rotation: ImageRotation;
  flipX: boolean;
  desktopToolbar: HTMLElement | null;
  mobileSheet: HTMLElement | null;
}

const MOBILE_BACKDROP_SELECTOR = [
  'button[aria-label="关闭图片操作"]',
  'button[aria-label="Close image actions"]',
].join(",");
const originalBackdropPointerEvents = new WeakMap<HTMLButtonElement, string>();
const imageLoadListeners = new WeakSet<HTMLImageElement>();

function isEnglishUi(): boolean {
  return document.documentElement.lang?.toLowerCase().startsWith("en") ?? false;
}

function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)")?.matches === true;
}

function findDesktopImageToolbar(): HTMLElement | null {
  const expected = isEnglishUi()
    ? ["View large image", "Download image"]
    : ["查看大图", "下载图片"];
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("div.fixed.z-50.flex.items-center"));
  const translatedMatch = candidates.find((candidate) => {
    const titles = Array.from(candidate.querySelectorAll<HTMLButtonElement>("button[title]"))
      .map((button) => button.title.trim());
    return expected.every((label) => titles.includes(label));
  });
  if (translatedMatch) return translatedMatch;
  // Fallback for custom translations: image toolbar has six direct actions plus one size menu.
  return candidates.find((candidate) =>
    candidate.querySelectorAll(":scope > button, :scope > div.relative > button").length === 7,
  ) || null;
}

function findCompactMobileSheet(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-nowen-image-transform-slot="true"]');
}

export function findImageTransformWrapper(dom: HTMLElement | null): HTMLElement | null {
  if (!dom) return null;
  if (dom.classList.contains("resizable-image-wrapper")) return dom;
  return dom.querySelector<HTMLElement>(".resizable-image-wrapper")
    || dom.closest<HTMLElement>(".resizable-image-wrapper");
}

function selectedImageTarget(): Omit<ImageTarget, "desktopToolbar" | "mobileSheet"> | null {
  const editorDom = document.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
  const editor = (editorDom as (HTMLElement & { editor?: TiptapEditorLike }) | null)?.editor;
  if (!editor?.state || !editor?.view) return null;
  const selection = editor.state.selection;
  if (selection?.node?.type?.name !== "image") return null;
  const pos = Number(selection.from);
  if (!Number.isFinite(pos)) return null;
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
  const wrapper = findImageTransformWrapper(dom);
  if (!wrapper) return null;
  return {
    editor,
    pos,
    wrapper,
    rotation: normalizeImageRotation(selection.node.attrs?.rotation),
    flipX: normalizeImageFlipX(selection.node.attrs?.flipX),
  };
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
  const transaction = editor.state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    ...attrs,
  });
  editor.view.dispatch(transaction);
  return true;
}

function positionDesktopToolbar(toolbar: HTMLElement, wrapper: HTMLElement): void {
  const rect = wrapper.getBoundingClientRect();
  const width = toolbar.getBoundingClientRect().width || 400;
  const height = toolbar.getBoundingClientRect().height || 40;
  const margin = 8;
  const gap = 8;
  const above = rect.top - height - gap;
  const top = above >= margin
    ? above
    : Math.min(rect.bottom + gap, window.innerHeight - height - margin);
  const left = Math.max(
    margin,
    Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - margin),
  );
  const nextTop = `${Math.round(top)}px`;
  const nextLeft = `${Math.round(left)}px`;
  if (toolbar.style.top !== nextTop) toolbar.style.top = nextTop;
  if (toolbar.style.left !== nextLeft) toolbar.style.left = nextLeft;
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
  const [target, setTarget] = useState<ImageTarget | null>(null);
  const targetRef = useRef<ImageTarget | null>(null);

  const reconcile = useCallback(() => {
    syncAllImageWrappers();
    const selected = selectedImageTarget();
    if (!selected) {
      restoreMobileBackdropPointerCapture();
      targetRef.current = null;
      setTarget(null);
      return;
    }

    allowImageResizeThroughMobileBackdrop();
    const next: ImageTarget = {
      ...selected,
      desktopToolbar: findDesktopImageToolbar(),
      mobileSheet: findCompactMobileSheet(),
    };
    applyImageTransformLayout(next.wrapper, next.rotation, next.flipX);
    if (next.desktopToolbar) positionDesktopToolbar(next.desktopToolbar, next.wrapper);
    const previous = targetRef.current;
    const changed = !previous
      || previous.editor !== next.editor
      || previous.pos !== next.pos
      || previous.wrapper !== next.wrapper
      || previous.rotation !== next.rotation
      || previous.flipX !== next.flipX
      || previous.desktopToolbar !== next.desktopToolbar
      || previous.mobileSheet !== next.mobileSheet;
    targetRef.current = next;
    if (changed) setTarget(next);
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

  const update = useCallback((attrs: Record<string, unknown>) => {
    const current = targetRef.current;
    if (!current) return;
    updateImageAttributesAt(current.editor, current.pos, attrs);
    requestAnimationFrame(reconcile);
  }, [reconcile]);

  const labels = useMemo(() => isEnglishUi()
    ? { left: "Rotate left 90°", right: "Rotate right 90°", flip: "Flip horizontally", group: "Rotate and flip" }
    : { left: "向左旋转 90°", right: "向右旋转 90°", flip: "水平翻转", group: "旋转与翻转" }, []);

  if (!target) return null;

  const rotate = (delta: -90 | 90) => {
    const current = targetRef.current?.editor.state.selection?.node?.attrs?.rotation;
    update({ rotation: normalizeImageRotation(normalizeImageRotation(current) + delta) });
  };
  const flip = () => {
    const current = targetRef.current?.editor.state.selection?.node?.attrs?.flipX;
    update({ flipX: !normalizeImageFlipX(current) });
  };

  const desktopPortal = target.desktopToolbar ? createPortal(
    <>
      <div className="mx-0.5 h-4 w-px shrink-0 bg-app-border" aria-hidden="true" />
      <TransformButton label={labels.left} onClick={() => rotate(-90)}><RotateCcw size={14} /></TransformButton>
      <TransformButton label={labels.right} onClick={() => rotate(90)}><RotateCw size={14} /></TransformButton>
      <TransformButton label={labels.flip} active={target.flipX} onClick={flip}><FlipHorizontal size={14} /></TransformButton>
    </>,
    target.desktopToolbar,
  ) : null;

  const mobilePortal = target.mobileSheet ? createPortal(
    <div className="mt-2" data-nowen-editor-image-transforms="true" role="group" aria-label={labels.group}>
      <div className="grid grid-cols-3 gap-1.5">
        <TransformButton mobile label={labels.left} onClick={() => rotate(-90)}><RotateCcw size={14} />{isEnglishUi() ? "Left" : "左转"}</TransformButton>
        <TransformButton mobile label={labels.right} onClick={() => rotate(90)}><RotateCw size={14} />{isEnglishUi() ? "Right" : "右转"}</TransformButton>
        <TransformButton mobile label={labels.flip} active={target.flipX} onClick={flip}><FlipHorizontal size={14} />{isEnglishUi() ? "Flip" : "翻转"}</TransformButton>
      </div>
    </div>,
    target.mobileSheet,
  ) : null;

  return <>{desktopPortal}{mobilePortal}</>;
}

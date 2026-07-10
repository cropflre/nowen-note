import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  MoreHorizontal,
  Palette,
  RotateCcw,
  RotateCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  findMobileImageSheet,
  findSharedLightbox,
  getHorizontalSwipeDirection,
  getImageElementSource,
  getRotatedContainLimits,
  normalizeQuarterTurn,
  stepGalleryIndex,
  type MobileImageSheetControls,
  type SharedLightboxContext,
} from "@/lib/imageExperience";

const compactSheetOriginalDisplay = new WeakMap<HTMLElement, string>();

function isEnglishUi(): boolean {
  return document.documentElement.lang?.toLowerCase().startsWith("en") ?? false;
}

function buttonLabel(button: HTMLButtonElement | undefined, fallback: string): string {
  return button?.textContent?.trim() || fallback;
}

async function hideNativeKeyboard(): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) await Keyboard.hide();
  } catch {
    // Browser, Electron and unsupported native shells keep their existing behavior.
  }
}

function hideOriginalSheet(controls: MobileImageSheetControls): void {
  if (!compactSheetOriginalDisplay.has(controls.root)) {
    compactSheetOriginalDisplay.set(controls.root, controls.root.style.display || "");
  }
  controls.root.dataset.nowenCompactImageSheet = "source";
  controls.root.style.setProperty("display", "none", "important");
}

function restoreOriginalSheet(controls: MobileImageSheetControls | null): void {
  if (!controls) return;
  const previous = compactSheetOriginalDisplay.get(controls.root) ?? "";
  if (previous) controls.root.style.display = previous;
  else controls.root.style.removeProperty("display");
  delete controls.root.dataset.nowenCompactImageSheet;
  compactSheetOriginalDisplay.delete(controls.root);
}

function parseScale(transform: string): number {
  const match = transform.match(/scale\(([-+\d.]+)\)/);
  const value = match ? Number(match[1]) : 1;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function galleryKey(context: SharedLightboxContext, index: number): string {
  const source = context.sourceImages[index];
  return `${index}:${source ? getImageElementSource(source) : ""}`;
}

/**
 * Runtime image UX integration.
 *
 * The bridge deliberately reuses Tiptap's existing action buttons and SharedNoteView's
 * existing lightbox state. It changes presentation and navigation only, so upload,
 * replace, edit, permission and persistence behavior remain owned by the original code.
 */
export default function ImageExperienceBridge() {
  const [mobileSheet, setMobileSheet] = useState<MobileImageSheetControls | null>(null);
  const mobileSheetRef = useRef<MobileImageSheetControls | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const [shareLightbox, setShareLightbox] = useState<SharedLightboxContext | null>(null);
  const shareLightboxRef = useRef<SharedLightboxContext | null>(null);
  const pendingGalleryIndexRef = useRef<number | null>(null);
  const rotationsRef = useRef<Map<string, number>>(new Map());
  const [rotationVersion, setRotationVersion] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsVisibleRef = useRef(true);
  const suppressImageTapUntilRef = useRef(0);

  useEffect(() => {
    controlsVisibleRef.current = controlsVisible;
  }, [controlsVisible]);

  useEffect(() => {
    let frame = 0;

    const reconcile = () => {
      frame = 0;

      const nextSheet = findMobileImageSheet(document);
      const previousSheet = mobileSheetRef.current;
      if (nextSheet?.root !== previousSheet?.root) {
        restoreOriginalSheet(previousSheet);
        if (nextSheet) hideOriginalSheet(nextSheet);
        mobileSheetRef.current = nextSheet;
        setMobileSheet(nextSheet);
        setMoreOpen(false);
      } else if (nextSheet) {
        hideOriginalSheet(nextSheet);
      }

      const nextLightbox = findSharedLightbox(document);
      const previousLightbox = shareLightboxRef.current;
      if (nextLightbox) {
        const pendingIndex = pendingGalleryIndexRef.current;
        if (
          pendingIndex !== null &&
          pendingIndex >= 0 &&
          pendingIndex < nextLightbox.sourceImages.length &&
          getImageElementSource(nextLightbox.sourceImages[pendingIndex]) === getImageElementSource(nextLightbox.image)
        ) {
          nextLightbox.currentIndex = pendingIndex;
          pendingGalleryIndexRef.current = null;
        }

        const changed =
          previousLightbox?.overlay !== nextLightbox.overlay ||
          previousLightbox?.image !== nextLightbox.image ||
          previousLightbox?.currentIndex !== nextLightbox.currentIndex ||
          previousLightbox?.sourceImages.length !== nextLightbox.sourceImages.length;
        shareLightboxRef.current = nextLightbox;
        if (changed) {
          setShareLightbox(nextLightbox);
          setControlsVisible(true);
        }
      } else if (previousLightbox) {
        shareLightboxRef.current = null;
        pendingGalleryIndexRef.current = null;
        rotationsRef.current.clear();
        setShareLightbox(null);
        setControlsVisible(true);
        setRotationVersion((value) => value + 1);
      }
    };

    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reconcile);
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "src"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("focus", schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focus", schedule);
      restoreOriginalSheet(mobileSheetRef.current);
      mobileSheetRef.current = null;
    };
  }, []);

  const closeMobileSheet = useCallback(() => {
    const controls = mobileSheetRef.current;
    controls?.closeButton.click();
    setMoreOpen(false);
    void hideNativeKeyboard();
  }, []);

  useEffect(() => {
    if (!mobileSheet) return;

    const editor = document.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
    const previousInputMode = editor?.getAttribute("inputmode") ?? null;
    editor?.setAttribute("inputmode", "none");

    void hideNativeKeyboard();
    const timers = [50, 240, 700].map((delay) =>
      window.setTimeout(() => void hideNativeKeyboard(), delay),
    );
    const keepKeyboardHidden = () => void hideNativeKeyboard();
    window.addEventListener("focus", keepKeyboardHidden);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMobileSheet();
    };
    window.addEventListener("keydown", onKeyDown, true);

    let disposed = false;
    let removeBackButton: (() => void) | null = null;
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener("backButton", () => closeMobileSheet())
        .then((handle) => {
          if (disposed) void handle.remove();
          else removeBackButton = () => void handle.remove();
        })
        .catch(() => {});
    }

    return () => {
      disposed = true;
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("focus", keepKeyboardHidden);
      window.removeEventListener("keydown", onKeyDown, true);
      removeBackButton?.();
      if (editor) {
        if (previousInputMode === null) editor.removeAttribute("inputmode");
        else editor.setAttribute("inputmode", previousInputMode);
      }
      // Do not restore focus: the next explicit tap in text should be what reopens IME.
      void hideNativeKeyboard();
    };
  }, [mobileSheet, closeMobileSheet]);

  const runOriginalImageAction = useCallback((index: number) => {
    const button = mobileSheetRef.current?.actionButtons[index];
    if (!button || button.disabled) return;
    button.click();
    void hideNativeKeyboard();

    // Replace/edit may focus the editor after a file picker or dialog finishes.
    if (index === 2 || index === 5) {
      [100, 450, 1000].forEach((delay) => {
        window.setTimeout(() => void hideNativeKeyboard(), delay);
      });
    }
    if (index === 4) setMoreOpen(false);
  }, []);

  const runOriginalSizeAction = useCallback((index: number) => {
    const button = mobileSheetRef.current?.sizeButtons[index];
    if (!button || button.disabled) return;
    button.click();
    void hideNativeKeyboard();
  }, []);

  const navigateGallery = useCallback((delta: number) => {
    const context = shareLightboxRef.current;
    if (!context || context.sourceImages.length <= 1) return;
    const nextIndex = stepGalleryIndex(context.currentIndex, delta, context.sourceImages.length);
    if (nextIndex < 0 || nextIndex === context.currentIndex) return;

    pendingGalleryIndexRef.current = nextIndex;
    suppressImageTapUntilRef.current = Date.now() + 450;
    context.sourceImages[nextIndex].dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
  }, []);

  const rotateCurrentImage = useCallback((delta: number) => {
    const context = shareLightboxRef.current;
    if (!context) return;
    const key = galleryKey(context, context.currentIndex);
    const next = normalizeQuarterTurn((rotationsRef.current.get(key) || 0) + delta);
    rotationsRef.current.set(key, next);
    setRotationVersion((value) => value + 1);
  }, []);

  const resetCurrentRotation = useCallback(() => {
    const context = shareLightboxRef.current;
    if (!context) return;
    rotationsRef.current.set(galleryKey(context, context.currentIndex), 0);
    setRotationVersion((value) => value + 1);
  }, []);

  const currentRotation = useMemo(() => {
    if (!shareLightbox) return 0;
    return rotationsRef.current.get(galleryKey(shareLightbox, shareLightbox.currentIndex)) || 0;
    // rotationVersion intentionally invalidates the memo after map mutations.
  }, [shareLightbox, rotationVersion]);

  useEffect(() => {
    const context = shareLightbox;
    if (!context) return;

    const scale = parseScale(context.image.style.transform);
    const desiredTransform = `scale(${scale}) rotate(${currentRotation}deg)`;
    if (context.image.style.transform !== desiredTransform) {
      context.image.style.transform = desiredTransform;
    }
    const limits = getRotatedContainLimits(currentRotation);
    if (context.image.style.maxWidth !== limits.maxWidth) context.image.style.maxWidth = limits.maxWidth;
    if (context.image.style.maxHeight !== limits.maxHeight) context.image.style.maxHeight = limits.maxHeight;
    context.image.style.touchAction = "pan-y pinch-zoom";

    const nativeToolbar = Array.from(context.overlay.children).find((child) => {
      return child instanceof HTMLElement &&
        child.classList.contains("absolute") &&
        child.classList.contains("top-3") &&
        child.classList.contains("right-3");
    }) as HTMLElement | undefined;
    if (nativeToolbar) {
      nativeToolbar.style.transition = "opacity 160ms ease";
      nativeToolbar.style.opacity = controlsVisible ? "1" : "0";
      nativeToolbar.style.pointerEvents = controlsVisible ? "auto" : "none";
    }
  }, [shareLightbox, currentRotation, controlsVisible]);

  useEffect(() => {
    const context = shareLightbox;
    if (!context) return;

    let touchStart: { x: number; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      touchStart = { x: touch.clientX, y: touch.clientY };
    };
    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch || !touchStart) return;
      const direction = getHorizontalSwipeDirection(touchStart, {
        x: touch.clientX,
        y: touch.clientY,
      });
      touchStart = null;
      if (!direction) return;
      suppressImageTapUntilRef.current = Date.now() + 450;
      navigateGallery(direction);
    };
    const onImageClick = (event: MouseEvent) => {
      event.stopPropagation();
      if (Date.now() < suppressImageTapUntilRef.current) return;
      setControlsVisible((visible) => !visible);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigateGallery(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        navigateGallery(1);
      }
    };

    context.overlay.addEventListener("touchstart", onTouchStart, { passive: true });
    context.overlay.addEventListener("touchend", onTouchEnd, { passive: true });
    context.image.addEventListener("click", onImageClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      context.overlay.removeEventListener("touchstart", onTouchStart);
      context.overlay.removeEventListener("touchend", onTouchEnd);
      context.image.removeEventListener("click", onImageClick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [shareLightbox, navigateGallery]);

  const mobilePortal = mobileSheet && typeof document !== "undefined" ? createPortal(
    <>
      <button
        type="button"
        aria-label={isEnglishUi() ? "Close image actions" : "关闭图片操作"}
        className="fixed inset-0 z-[69] cursor-default bg-black/20 backdrop-blur-[1px]"
        onClick={closeMobileSheet}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={isEnglishUi() ? "Image actions" : "图片操作"}
        className="fixed inset-x-0 bottom-0 z-[70] overflow-y-auto rounded-t-2xl border-t border-app-border bg-app-elevated px-3 pt-2 shadow-[0_-12px_32px_rgba(15,23,42,0.18)]"
        style={{
          maxHeight: "min(42dvh, 360px)",
          paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-tx-tertiary/30" />
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-tx-primary">
            {isEnglishUi() ? "Image actions" : "图片操作"}
          </span>
          <button
            type="button"
            className="rounded-lg p-2 text-tx-secondary active:bg-app-hover"
            onClick={closeMobileSheet}
            aria-label={isEnglishUi() ? "Close" : "关闭"}
          >
            <X size={17} />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {[
            { index: 0, icon: ExternalLink, fallback: isEnglishUi() ? "View" : "查看大图" },
            { index: 2, icon: Upload, fallback: isEnglishUi() ? "Replace" : "替换图片" },
            { index: 5, icon: Palette, fallback: isEnglishUi() ? "Edit" : "编辑图片" },
            { index: 1, icon: Download, fallback: isEnglishUi() ? "Download" : "下载图片" },
          ].map((item) => {
            const Icon = item.icon;
            const original = mobileSheet.actionButtons[item.index];
            return (
              <button
                key={item.index}
                type="button"
                disabled={original?.disabled}
                onClick={() => runOriginalImageAction(item.index)}
                className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border border-app-border bg-app-surface px-1 py-2 text-[11px] leading-tight text-tx-secondary active:bg-app-hover disabled:opacity-40"
              >
                <Icon size={17} />
                <span>{buttonLabel(original, item.fallback)}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 overflow-x-auto pb-1 hide-scrollbar">
            <div className="flex min-w-max gap-2">
              {mobileSheet.sizeButtons.map((button, index) => (
                <button
                  key={index}
                  type="button"
                  disabled={button.disabled}
                  onClick={() => runOriginalSizeAction(index)}
                  className="h-9 shrink-0 rounded-lg border border-app-border bg-app-surface px-3 text-xs text-tx-secondary active:bg-app-hover disabled:opacity-40"
                >
                  {buttonLabel(button, index === 4 ? (isEnglishUi() ? "Original" : "原始") : `${(index + 1) * 25}%`)}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMoreOpen((open) => !open)}
            className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-3 text-xs text-tx-secondary active:bg-app-hover"
            aria-expanded={moreOpen}
          >
            <MoreHorizontal size={16} />
            {isEnglishUi() ? "More" : "更多"}
          </button>
        </div>

        {moreOpen && (
          <div className="mt-2 grid grid-cols-2 gap-2 rounded-xl bg-app-hover/50 p-2">
            <button
              type="button"
              onClick={() => runOriginalImageAction(3)}
              className="flex h-10 items-center justify-center gap-2 rounded-lg bg-app-surface text-xs text-tx-secondary active:bg-app-hover"
            >
              <Copy size={15} />
              {buttonLabel(mobileSheet.actionButtons[3], isEnglishUi() ? "Copy address" : "复制图片地址")}
            </button>
            <button
              type="button"
              onClick={() => runOriginalImageAction(4)}
              className="flex h-10 items-center justify-center gap-2 rounded-lg bg-red-500/10 text-xs text-red-500 active:bg-red-500/20"
            >
              <Trash2 size={15} />
              {buttonLabel(mobileSheet.actionButtons[4], isEnglishUi() ? "Delete" : "删除图片")}
            </button>
          </div>
        )}
      </section>
    </>,
    document.body,
  ) : null;

  const sharePortal = shareLightbox && typeof document !== "undefined" ? createPortal(
    <>
      {controlsVisible && shareLightbox.sourceImages.length > 1 && (
        <>
          <div
            className="pointer-events-none absolute left-3 top-3 z-20 rounded-full bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur"
            aria-live="polite"
          >
            {shareLightbox.currentIndex + 1} / {shareLightbox.sourceImages.length}
          </div>
          <button
            type="button"
            disabled={shareLightbox.currentIndex === 0}
            onClick={(event) => { event.stopPropagation(); navigateGallery(-1); }}
            className="absolute left-2 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur transition active:bg-black/65 disabled:pointer-events-none disabled:opacity-25 sm:left-4"
            aria-label={isEnglishUi() ? "Previous image" : "上一张"}
          >
            <ChevronLeft size={24} />
          </button>
          <button
            type="button"
            disabled={shareLightbox.currentIndex === shareLightbox.sourceImages.length - 1}
            onClick={(event) => { event.stopPropagation(); navigateGallery(1); }}
            className="absolute right-2 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur transition active:bg-black/65 disabled:pointer-events-none disabled:opacity-25 sm:right-4"
            aria-label={isEnglishUi() ? "Next image" : "下一张"}
          >
            <ChevronRight size={24} />
          </button>
        </>
      )}

      {controlsVisible && (
        <div
          className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/55 p-1.5 text-white shadow-lg backdrop-blur"
          style={{ marginBottom: "env(safe-area-inset-bottom)" }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => rotateCurrentImage(-90)}
            className="flex h-9 w-9 items-center justify-center rounded-full active:bg-white/20"
            aria-label={isEnglishUi() ? "Rotate left" : "向左旋转"}
          >
            <RotateCcw size={18} />
          </button>
          <span className="min-w-10 select-none text-center text-[11px] text-white/80">
            {normalizeQuarterTurn(currentRotation)}°
          </span>
          <button
            type="button"
            onClick={() => rotateCurrentImage(90)}
            className="flex h-9 w-9 items-center justify-center rounded-full active:bg-white/20"
            aria-label={isEnglishUi() ? "Rotate right" : "向右旋转"}
          >
            <RotateCw size={18} />
          </button>
          {currentRotation !== 0 && (
            <button
              type="button"
              onClick={resetCurrentRotation}
              className="h-9 rounded-full px-3 text-xs active:bg-white/20"
            >
              {isEnglishUi() ? "Reset" : "还原"}
            </button>
          )}
        </div>
      )}
    </>,
    shareLightbox.overlay,
  ) : null;

  return <>{mobilePortal}{sharePortal}</>;
}

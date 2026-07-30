import React, { forwardRef, useEffect } from "react";

import type { NoteEditorHandle } from "@/components/editors/types";
import { useEditorInitializationTimeout } from "@/hooks/useEditorInitializationTimeout";
import TiptapEditorRuntime from "./TiptapEditorRuntime";

type TiptapEditorInitializationRuntimeProps = React.ComponentPropsWithoutRef<typeof TiptapEditorRuntime>;

type PreviewPointer = {
  pointerId: number;
  x: number;
  y: number;
  overlay: HTMLElement;
};

const PREVIEW_IMAGE_SELECTOR = 'img[alt="preview"]';
const TAP_MOVE_TOLERANCE_PX = 14;

function findImagePreviewOverlay(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const image = target.closest<HTMLImageElement>(PREVIEW_IMAGE_SELECTOR);
  if (!image) return null;
  const overlay = image.parentElement;
  if (!overlay?.classList.contains("fixed") || !overlay.classList.contains("inset-0")) return null;
  return overlay;
}

function isTouchLikePointer(event: PointerEvent): boolean {
  return event.pointerType === "touch"
    || (event.pointerType === "" && window.matchMedia("(pointer: coarse)").matches);
}

/**
 * Android WebView turns a touch on the lightbox image into the image's mouse-drag path.
 * That path calls preventDefault(), so the overlay click handler never receives a click.
 * Capture the native pointer gesture before React's mouse compatibility events and route a
 * stationary tap to the existing close button. Desktop mouse dragging remains unchanged.
 */
function useAndroidImagePreviewTapClose(): void {
  useEffect(() => {
    let pointer: PreviewPointer | null = null;

    const handlePointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || !isTouchLikePointer(event)) return;
      const overlay = findImagePreviewOverlay(event.target);
      if (!overlay) return;

      pointer = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        overlay,
      };
      // Prevent the compatibility mousedown from entering the desktop image-drag handler.
      event.preventDefault();
    };

    const handlePointerUp = (event: PointerEvent) => {
      const current = pointer;
      pointer = null;
      if (!current || current.pointerId !== event.pointerId) return;
      if (findImagePreviewOverlay(event.target) !== current.overlay) return;

      const distance = Math.hypot(event.clientX - current.x, event.clientY - current.y);
      if (distance > TAP_MOVE_TOLERANCE_PX) return;

      event.preventDefault();
      current.overlay.querySelector<HTMLButtonElement>('button[title="关闭"]')?.click();
    };

    const cancelPointer = () => {
      pointer = null;
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", cancelPointer, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("pointercancel", cancelPointer, true);
    };
  }, []);
}

/** Adds the shared initialization watchdog around the existing Tiptap runtime shell. */
const TiptapEditorInitializationRuntime = forwardRef<
  NoteEditorHandle,
  TiptapEditorInitializationRuntimeProps
>(function TiptapEditorInitializationRuntime(props, ref) {
  useAndroidImagePreviewTapClose();

  const onEditorReady = useEditorInitializationTimeout({
    noteId: props.note.id,
    engine: "tiptap",
    onEditorReady: props.onEditorReady,
  });

  return (
    <TiptapEditorRuntime
      {...props}
      ref={ref}
      onEditorReady={onEditorReady}
    />
  );
});

TiptapEditorInitializationRuntime.displayName = "TiptapEditorInitializationRuntime";

export default TiptapEditorInitializationRuntime;

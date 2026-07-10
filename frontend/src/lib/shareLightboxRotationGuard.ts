import {
  getRotatedContainLimits,
  normalizeQuarterTurn,
} from "@/lib/imageExperience";

const INSTALL_KEY = Symbol.for("nowen.share-lightbox-rotation-guard");

type GuardedWindow = Window & typeof globalThis & {
  [INSTALL_KEY]?: () => void;
};

function readScale(transform: string): number {
  const value = Number(transform.match(/scale\(([-+\d.]+)\)/)?.[1] || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * SharedNoteView owns zoom in React state and rewrites the image transform on each zoom.
 * This guard remembers the bridge-provided quarter turn and merges it back after those
 * updates, keeping zoom and rotation independent and preventing mutation feedback loops.
 */
export function installShareLightboxRotationGuard(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const guardedWindow = window as GuardedWindow;
  if (guardedWindow[INSTALL_KEY]) return;

  const rotations = new WeakMap<HTMLImageElement, number>();
  let frame = 0;

  const reconcile = () => {
    frame = 0;
    if (!document.querySelector(".shared-note-content")) return;

    const overlays = Array.from(document.querySelectorAll<HTMLElement>("div.fixed.inset-0"));
    for (const overlay of overlays) {
      const image = overlay.querySelector<HTMLImageElement>('img[draggable="false"]');
      if (!image || image.closest(".shared-note-content")) continue;

      const transform = image.style.transform || "";
      const rotateMatch = transform.match(/rotate\(([-+\d.]+)deg\)/);
      if (rotateMatch) {
        rotations.set(image, normalizeQuarterTurn(Number(rotateMatch[1])));
      }

      const rotation = rotations.get(image);
      if (rotation === undefined) continue;
      const desired = `scale(${readScale(transform)}) rotate(${rotation}deg)`;
      if (image.style.transform !== desired) image.style.transform = desired;

      const limits = getRotatedContainLimits(rotation);
      if (image.style.maxWidth !== limits.maxWidth) image.style.maxWidth = limits.maxWidth;
      if (image.style.maxHeight !== limits.maxHeight) image.style.maxHeight = limits.maxHeight;
    }
  };

  const schedule = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(reconcile);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "src"],
  });
  schedule();

  guardedWindow[INSTALL_KEY] = () => {
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
    delete guardedWindow[INSTALL_KEY];
  };
}

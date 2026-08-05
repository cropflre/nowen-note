import React, { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import MobileImageViewer from "@/components/MobileImageViewer";

interface ViewerRequest {
  src: string;
  alt: string;
  source: "markdown" | "tiptap";
}

interface HiddenNativePreview {
  overlay: HTMLElement;
  visibility: string;
  visibilityPriority: string;
  pointerEvents: string;
  pointerEventsPriority: string;
  ariaHidden: string | null;
}

function isMobileViewerEnvironment(): boolean {
  if (Capacitor.getPlatform() === "android") return true;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(max-width: 767px), (pointer: coarse)").matches;
}

function getImageSource(image: HTMLImageElement): string {
  return image.currentSrc || image.src || image.getAttribute("src") || "";
}

function findNativeTiptapPreview(): { overlay: HTMLElement; image: HTMLImageElement } | null {
  const images = Array.from(document.querySelectorAll<HTMLImageElement>('img[alt="preview"]'));
  for (const image of images) {
    if (image.closest("[data-nowen-mobile-image-viewer]")) continue;
    const overlay = image.closest<HTMLElement>("div.fixed.inset-0");
    if (!overlay || !getImageSource(image)) continue;
    return { overlay, image };
  }
  return null;
}

function restoreNativePreview(hidden: HiddenNativePreview): void {
  hidden.overlay.style.setProperty("visibility", hidden.visibility, hidden.visibilityPriority);
  hidden.overlay.style.setProperty("pointer-events", hidden.pointerEvents, hidden.pointerEventsPriority);
  if (hidden.ariaHidden === null) hidden.overlay.removeAttribute("aria-hidden");
  else hidden.overlay.setAttribute("aria-hidden", hidden.ariaHidden);
}

/**
 * Routes mobile Markdown and Tiptap image previews into one gesture-safe viewer.
 *
 * Markdown image clicks are captured before PreviewImage can call window.open(), avoiding the
 * Android "open Chrome" prompt. Tiptap's existing lightbox remains the state owner; it is hidden
 * while the shared viewer is visible and its original close action is invoked on exit.
 */
export default function MobileImageViewerBridge() {
  const [request, setRequest] = useState<ViewerRequest | null>(null);
  const requestRef = useRef<ViewerRequest | null>(null);
  const hiddenNativeRef = useRef<HiddenNativePreview | null>(null);
  const suppressNativeUntilRef = useRef(0);

  useEffect(() => {
    requestRef.current = request;
  }, [request]);

  const hideNativePreview = useCallback((overlay: HTMLElement) => {
    const current = hiddenNativeRef.current;
    if (current?.overlay === overlay) return;

    if (current?.overlay.isConnected) restoreNativePreview(current);

    hiddenNativeRef.current = {
      overlay,
      visibility: overlay.style.getPropertyValue("visibility"),
      visibilityPriority: overlay.style.getPropertyPriority("visibility"),
      pointerEvents: overlay.style.getPropertyValue("pointer-events"),
      pointerEventsPriority: overlay.style.getPropertyPriority("pointer-events"),
      ariaHidden: overlay.getAttribute("aria-hidden"),
    };
    overlay.style.setProperty("visibility", "hidden", "important");
    overlay.style.setProperty("pointer-events", "none", "important");
    overlay.setAttribute("aria-hidden", "true");
  }, []);

  const clearDisconnectedNativePreview = useCallback(() => {
    const hidden = hiddenNativeRef.current;
    if (!hidden || hidden.overlay.isConnected) return;
    hiddenNativeRef.current = null;
    if (requestRef.current?.source === "tiptap") setRequest(null);
  }, []);

  useEffect(() => {
    const handleMarkdownImageClick = (event: MouseEvent) => {
      if (!isMobileViewerEnvironment()) return;
      if (!(event.target instanceof Element)) return;
      const image = event.target.closest<HTMLImageElement>(".nowen-md-preview img");
      if (!image || image.closest("[data-nowen-mobile-image-viewer]")) return;

      const src = getImageSource(image);
      if (!src) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setRequest({ src, alt: image.alt || "", source: "markdown" });
    };

    document.addEventListener("click", handleMarkdownImageClick, true);
    return () => document.removeEventListener("click", handleMarkdownImageClick, true);
  }, []);

  useEffect(() => {
    const reconcile = () => {
      clearDisconnectedNativePreview();
      if (!isMobileViewerEnvironment() || Date.now() < suppressNativeUntilRef.current) return;

      const native = findNativeTiptapPreview();
      if (!native) return;
      const src = getImageSource(native.image);
      if (!src) return;

      hideNativePreview(native.overlay);
      const current = requestRef.current;
      if (current?.source === "tiptap" && current.src === src) return;
      setRequest({ src, alt: native.image.alt === "preview" ? "" : native.image.alt, source: "tiptap" });
    };

    reconcile();
    const observer = new MutationObserver(reconcile);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "src"],
    });
    window.addEventListener("resize", reconcile);
    window.addEventListener("focus", reconcile);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reconcile);
      window.removeEventListener("focus", reconcile);

      const hidden = hiddenNativeRef.current;
      if (hidden?.overlay.isConnected) restoreNativePreview(hidden);
      hiddenNativeRef.current = null;
    };
  }, [clearDisconnectedNativePreview, hideNativePreview]);

  const closeViewer = useCallback(() => {
    const current = requestRef.current;
    setRequest(null);
    requestRef.current = null;

    if (current?.source !== "tiptap") return;
    const hidden = hiddenNativeRef.current;
    if (!hidden?.overlay.isConnected) {
      hiddenNativeRef.current = null;
      return;
    }

    suppressNativeUntilRef.current = Date.now() + 700;
    const closeButton = hidden.overlay.querySelector<HTMLButtonElement>(
      'button[title="关闭"], button[aria-label="关闭"], button[aria-label="关闭图片预览"]',
    );
    if (closeButton) closeButton.click();
    else hidden.overlay.click();
  }, []);

  return (
    <MobileImageViewer
      open={!!request}
      src={request?.src || ""}
      alt={request?.alt || ""}
      onClose={closeViewer}
    />
  );
}

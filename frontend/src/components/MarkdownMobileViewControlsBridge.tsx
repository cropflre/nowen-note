import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, FileCode } from "lucide-react";
import { cn } from "@/lib/utils";

interface MobileViewControlsTarget {
  host: HTMLDivElement;
  sourceButton: HTMLButtonElement;
  previewButton: HTMLButtonElement;
  liveButton: HTMLButtonElement | null;
  sourceActive: boolean;
  previewActive: boolean;
  liveActive: boolean;
  sourceLabel: string;
  previewLabel: string;
  liveLabel: string;
}

const HOST_ATTR = "data-nowen-markdown-mobile-view-controls";
const ORIGINAL_GROUP_ATTR = "data-nowen-markdown-mobile-view-controls-source";
const originalGroupDisplay = new WeakMap<HTMLElement, string>();

function matchesViewport(query: string): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(query).matches;
}

function isCompactMarkdownViewport(): boolean {
  return matchesViewport("(max-width: 767px)");
}

function isPhoneMarkdownViewport(): boolean {
  // Keep this threshold aligned with MarkdownEditorImpl.isMobileMarkdownViewport().
  // Phones do not support split mode; 640–767px compact/tablet layouts may still use it.
  return matchesViewport("(max-width: 639px)");
}

function findModeButton(
  root: HTMLElement,
  iconClass: "lucide-file-code" | "lucide-eye",
): HTMLButtonElement | null {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"))
    .find((button) => button.querySelector(`svg.${iconClass}`)) || null;
}

function ensureHost(compactToolbar: HTMLElement): HTMLDivElement {
  const existing = compactToolbar.querySelector<HTMLDivElement>(`[${HOST_ATTR}]`);
  if (existing) return existing;

  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "true");
  host.className = "flex shrink-0 items-center gap-0.5 overflow-hidden rounded-md border border-app-border";

  const firstDivider = Array.from(compactToolbar.children).find((child) =>
    child instanceof HTMLElement
    && child.tagName === "DIV"
    && child.classList.contains("w-px")
    && child.classList.contains("h-5"),
  );
  compactToolbar.insertBefore(host, firstDivider || null);
  return host;
}

function restoreOriginalGroups(): void {
  document.querySelectorAll<HTMLElement>(`[${ORIGINAL_GROUP_ATTR}]`).forEach((group) => {
    const original = originalGroupDisplay.get(group) ?? "";
    if (original) group.style.display = original;
    else group.style.removeProperty("display");
    group.removeAttribute(ORIGINAL_GROUP_ATTR);
    originalGroupDisplay.delete(group);
  });
}

function resolveTarget(): MobileViewControlsTarget | null {
  if (!isCompactMarkdownViewport()) return null;

  const compactToolbar = document.querySelector<HTMLElement>('[data-markdown-mobile-toolbar="compact"]');
  const expandedToolbar = document.querySelector<HTMLElement>('[data-markdown-mobile-toolbar="expanded"]');
  if (!compactToolbar || !expandedToolbar) return null;

  // These two compact-mode buttons are React's canonical mobile source/preview state controls.
  const mobileSourceButton = findModeButton(expandedToolbar, "lucide-file-code");
  const mobilePreviewButton = findModeButton(expandedToolbar, "lucide-eye");
  if (!mobileSourceButton || !mobilePreviewButton) return null;

  // MarkdownExperienceBridge injects the historical live-preview action into the desktop mode
  // group. Reuse that exact button on mobile so entering/leaving live preview always configures
  // the same CodeMirror compartment and localStorage state instead of duplicating the behavior.
  const liveButton = expandedToolbar.querySelector<HTMLButtonElement>('[data-nowen-markdown-live="1"]');
  const liveGroup = liveButton?.parentElement instanceof HTMLElement ? liveButton.parentElement : null;
  const liveGroupNativeButtons = liveGroup
    ? Array.from(liveGroup.querySelectorAll<HTMLButtonElement>(":scope > button"))
      .filter((button) => button.dataset.nowenMarkdownLive !== "1")
    : [];
  const sourceButton = liveGroupNativeButtons[0] || mobileSourceButton;
  const previewButton = liveGroupNativeButtons[1] || mobilePreviewButton;

  const liveActive = liveButton?.getAttribute("aria-pressed") === "true";
  let sourceActive = !liveActive && mobileSourceButton.getAttribute("aria-pressed") === "true";
  const previewActive = !liveActive && mobilePreviewButton.getAttribute("aria-pressed") === "true";

  // MarkdownEditorImpl normalizes a desktop split preference on the first phone mount, but its
  // note-switch effect historically wrote the raw preference back. In that state no phone mode
  // is active. Route it through the canonical source action, but never override live preview.
  if (isPhoneMarkdownViewport() && !sourceActive && !previewActive && !liveActive) {
    sourceButton.click();
    sourceActive = true;
  }

  // The canonical mobile buttons used to live inside the collapsed secondary toolbar.
  // Keep them as the state source, but hide their old visual container so expanding “more” does
  // not show duplicates now that source/live/preview are permanently visible on the first row.
  const originalGroup = mobileSourceButton.parentElement;
  if (originalGroup instanceof HTMLElement && originalGroup === mobilePreviewButton.parentElement) {
    if (!originalGroupDisplay.has(originalGroup)) {
      originalGroupDisplay.set(originalGroup, originalGroup.style.display || "");
    }
    originalGroup.setAttribute(ORIGINAL_GROUP_ATTR, "true");
    originalGroup.style.display = "none";
  }

  const host = ensureHost(compactToolbar);
  return {
    host,
    sourceButton,
    previewButton,
    liveButton,
    sourceActive,
    previewActive,
    liveActive,
    sourceLabel: mobileSourceButton.getAttribute("aria-label") || mobileSourceButton.title || "源码",
    previewLabel: mobilePreviewButton.getAttribute("aria-label") || mobilePreviewButton.title || "预览",
    liveLabel: liveButton?.title || "实时预览",
  };
}

function sameTarget(a: MobileViewControlsTarget | null, b: MobileViewControlsTarget | null): boolean {
  if (!a || !b) return a === b;
  return a.host === b.host
    && a.sourceButton === b.sourceButton
    && a.previewButton === b.previewButton
    && a.liveButton === b.liveButton
    && a.sourceActive === b.sourceActive
    && a.previewActive === b.previewActive
    && a.liveActive === b.liveActive
    && a.sourceLabel === b.sourceLabel
    && a.previewLabel === b.previewLabel
    && a.liveLabel === b.liveLabel;
}

export default function MarkdownMobileViewControlsBridge() {
  const [target, setTarget] = useState<MobileViewControlsTarget | null>(null);

  useEffect(() => {
    let frame = 0;
    const reconcile = () => {
      frame = 0;
      const next = resolveTarget();
      setTarget((current) => sameTarget(current, next) ? current : next);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(reconcile);
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-pressed", "class"],
    });
    window.addEventListener("resize", schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.querySelectorAll<HTMLElement>(`[${HOST_ATTR}]`).forEach((host) => host.remove());
      restoreOriginalGroups();
    };
  }, []);

  if (!target) return null;

  const buttonClass = (active: boolean) => cn(
    "flex h-7 w-7 items-center justify-center rounded-[5px] transition-colors",
    active
      ? "bg-accent-primary/10 text-accent-primary"
      : "text-tx-tertiary active:bg-app-hover",
  );

  return createPortal(
    <>
      <button
        type="button"
        className={buttonClass(target.sourceActive)}
        title={target.sourceLabel}
        aria-label={target.sourceLabel}
        aria-pressed={target.sourceActive}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => target.sourceButton.click()}
      >
        <FileCode size={14} />
      </button>
      {target.liveButton && (
        <button
          type="button"
          className={buttonClass(target.liveActive)}
          title={target.liveLabel}
          aria-label={target.liveLabel}
          aria-pressed={target.liveActive}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => target.liveButton?.click()}
        >
          <span aria-hidden="true" className="text-[14px] leading-none">✦</span>
        </button>
      )}
      <button
        type="button"
        className={buttonClass(target.previewActive)}
        title={target.previewLabel}
        aria-label={target.previewLabel}
        aria-pressed={target.previewActive}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => target.previewButton.click()}
      >
        <Eye size={14} />
      </button>
    </>,
    target.host,
  );
}

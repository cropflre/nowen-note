import {
  appendShortcutToTooltip,
  detectShortcutPlatform,
  detectShortcutSurface,
  resolveShortcutCommandIdByTooltipLabel,
} from "./shortcutRegistry";

function readTooltipBase(element: HTMLElement): string {
  const title = element.getAttribute("title")?.trim();
  const previousEnhanced = element.dataset.shortcutEnhancedTitle;
  const previousBase = element.dataset.shortcutBaseTitle;
  if (title && previousEnhanced && title === previousEnhanced && previousBase) return previousBase;
  return title || element.getAttribute("aria-label")?.trim() || "";
}

/** Adds registry-backed shortcut hints to existing toolbar titles without editing large editors. */
export function enhanceShortcutTooltips(root: ParentNode = document): number {
  const platform = detectShortcutPlatform();
  const surface = detectShortcutSurface();
  let enhancedCount = 0;
  root.querySelectorAll<HTMLElement>("[title], [aria-label]").forEach((element) => {
    const baseTitle = readTooltipBase(element);
    if (!baseTitle || !resolveShortcutCommandIdByTooltipLabel(baseTitle)) return;
    const enhancedTitle = appendShortcutToTooltip(baseTitle, platform, surface);
    if (enhancedTitle === baseTitle) return;
    element.dataset.shortcutBaseTitle = baseTitle;
    element.dataset.shortcutEnhancedTitle = enhancedTitle;
    if (element.getAttribute("title") !== enhancedTitle) {
      element.setAttribute("title", enhancedTitle);
      enhancedCount += 1;
    }
  });
  return enhancedCount;
}

export function installShortcutTooltipBridge(): () => void {
  let raf: number | null = null;
  const schedule = () => {
    if (raf != null) return;
    raf = window.requestAnimationFrame(() => {
      raf = null;
      enhanceShortcutTooltips(document);
    });
  };
  schedule();
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["title", "aria-label"],
  });
  return () => {
    observer.disconnect();
    if (raf != null) window.cancelAnimationFrame(raf);
  };
}

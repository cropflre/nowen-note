const SETTINGS_HIGHLIGHT_ATTRIBUTE = "data-settings-highlight";
const HIGHLIGHT_MS = 1800;
// How long a revealed target is watched for being re-mounted.
const SETTLE_MS = 1500;

const FOCUSABLE_CONTROL = 'input:not([disabled]):not([type="hidden"]),select:not([disabled]),button:not([disabled])';
// A segmented control is entered through its selected option.
const SELECTED_RADIO = '[role="radio"][aria-checked="true"]:not([disabled])';

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

function reveal(element: HTMLElement, focus: boolean): void {
  element.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  element.setAttribute(SETTINGS_HIGHLIGHT_ATTRIBUTE, "");
  window.setTimeout(() => element.removeAttribute(SETTINGS_HIGHLIGHT_ATTRIBUTE), HIGHLIGHT_MS);
  if (!focus) return;
  const control = element.matches(FOCUSABLE_CONTROL)
    ? element
    : element.querySelector<HTMLElement>(SELECTED_RADIO) ?? element.querySelector<HTMLElement>(FOCUSABLE_CONTROL);
  control?.focus({ preventScroll: true });
}

/**
 * Scrolls a settings item into view, briefly highlights it and optionally focuses its control.
 * Panels load lazily (another tab, async data), so this waits until the target renders, and
 * reveals it again if the panel re-mounts it shortly afterwards (e.g. once the account loads).
 * Returns a cancel function for effect cleanup.
 */
export function revealSettingsTarget(
  root: HTMLElement,
  selector: string,
  options: { focus?: boolean; timeoutMs?: number } = {},
): () => void {
  let observer: MutationObserver | null = null;
  let timeout: number | undefined;
  let revealed: HTMLElement | null = null;
  const stop = () => {
    observer?.disconnect();
    observer = null;
    if (timeout !== undefined) window.clearTimeout(timeout);
    timeout = undefined;
  };
  const stopAfter = (ms: number) => {
    if (timeout !== undefined) window.clearTimeout(timeout);
    timeout = window.setTimeout(stop, ms);
  };
  const check = () => {
    const element = root.querySelector<HTMLElement>(selector);
    if (!element || element === revealed) return;
    const first = revealed === null;
    revealed = element;
    reveal(element, options.focus ?? false);
    if (first && observer) stopAfter(SETTLE_MS);
  };

  if (typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(check);
    observer.observe(root, { childList: true, subtree: true });
  }
  check();
  if (observer && !revealed) stopAfter(options.timeoutMs ?? 4000);
  return stop;
}

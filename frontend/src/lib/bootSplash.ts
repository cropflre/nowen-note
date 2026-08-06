const BOOT_SPLASH_ID = "app-boot-splash";
const BOOT_SPLASH_VISIBLE_CLASS = "app-boot-splash--visible";
const BOOT_SPLASH_LEAVING_CLASS = "app-boot-splash--leaving";
const BOOT_SPLASH_MIN_VISIBLE_MS = 600;
const BOOT_SPLASH_LEAVE_MS = 200;

interface NowenBootWindow extends Window {
  __NOWEN_BOOT_TIMER__?: number;
  __NOWEN_BOOT_REVEAL_TIMER__?: number;
  __NOWEN_BOOT_VISIBLE_AT__?: number;
}

let dismissed = false;
let removeTimer: number | null = null;

function bootWindow(): NowenBootWindow {
  return window as NowenBootWindow;
}

function getReactRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById("root");
}

function concealReactRoot(): void {
  const root = getReactRoot();
  if (!root) return;
  // Opacity conceals the transient AuthGate/Suspense UI without inheriting a hidden
  // visibility state into descendants. The readiness observer can still inspect the real
  // mounted surface and reveal it at the correct moment.
  root.style.opacity = "0";
  root.style.pointerEvents = "none";
}

function revealReactRoot(): void {
  const root = getReactRoot();
  if (!root) return;
  root.style.opacity = "1";
  root.style.pointerEvents = "";
}

// This module is imported before ReactDOM.render. Hide the root before AuthGate or Suspense
// can paint a second full-screen spinner during the 260ms no-flash startup window.
concealReactRoot();

function clearBootTimers(): void {
  const target = bootWindow();
  if (target.__NOWEN_BOOT_TIMER__) window.clearTimeout(target.__NOWEN_BOOT_TIMER__);
  if (target.__NOWEN_BOOT_REVEAL_TIMER__) window.clearTimeout(target.__NOWEN_BOOT_REVEAL_TIMER__);
  target.__NOWEN_BOOT_TIMER__ = undefined;
  target.__NOWEN_BOOT_REVEAL_TIMER__ = undefined;
}

function removeSplash(element: HTMLElement): void {
  element.remove();
  removeTimer = null;
}

/**
 * Dismiss the HTML startup splash exactly once.
 *
 * The splash is intentionally outside the React root, so it can cover lazy module loading,
 * authentication restoration and quick-login probing without exposing another full-screen
 * spinner underneath. Fast starts never reveal the card; once revealed it stays long enough
 * to avoid a distracting flash.
 */
export function dismissBootSplash(): void {
  if (dismissed || typeof document === "undefined") return;
  dismissed = true;
  clearBootTimers();

  const element = document.getElementById(BOOT_SPLASH_ID);
  if (!element) {
    revealReactRoot();
    return;
  }

  const target = bootWindow();
  const visible = element.classList.contains(BOOT_SPLASH_VISIBLE_CLASS);
  if (!visible) {
    revealReactRoot();
    removeSplash(element);
    return;
  }

  const visibleAt = target.__NOWEN_BOOT_VISIBLE_AT__ || Date.now();
  const remaining = Math.max(0, BOOT_SPLASH_MIN_VISIBLE_MS - (Date.now() - visibleAt));
  window.setTimeout(() => {
    // Reveal the completed application underneath, then fade the only startup surface away.
    revealReactRoot();
    element.classList.add(BOOT_SPLASH_LEAVING_CLASS);
    removeTimer = window.setTimeout(() => removeSplash(element), BOOT_SPLASH_LEAVE_MS);
  }, remaining);
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none"
    && style.visibility !== "hidden"
    && style.opacity !== "0";
}

function isApplicationReady(root: HTMLElement): boolean {
  const explicitReadySelectors = [
    "[data-unified-sidebar]",
    "[data-nowen-knowledge-tree]",
    "form",
    "main",
    "article",
    "nav",
  ].join(",");

  if (Array.from(root.querySelectorAll(explicitReadySelectors)).some(isVisible)) return true;

  const visibleRootChildren = Array.from(root.children).filter(isVisible);
  if (visibleRootChildren.length === 0) return false;

  // AuthGate and Suspense previously produced a generic full-screen spinner. Keep the
  // branded splash above that transient state, but allow richer route/auth screens through.
  const spinnerCount = root.querySelectorAll(".animate-spin").length;
  const text = (root.textContent || "").replace(/\s+/g, " ").trim();
  const mediaCount = root.querySelectorAll("img, svg, canvas, video").length;
  return !(spinnerCount === 1 && mediaCount <= 1 && text.length < 80);
}

/**
 * Observe the React root and remove the startup splash only after a real application,
 * login, share or recovery surface has mounted. Returns an idempotent cleanup function.
 */
export function observeBootSplashReadiness(root: HTMLElement | null): () => void {
  if (!root || typeof MutationObserver === "undefined") {
    dismissBootSplash();
    return () => {};
  }
  let stopped = false;

  const check = () => {
    if (stopped || !isApplicationReady(root)) return;
    stopped = true;
    observer.disconnect();
    dismissBootSplash();
  };

  const observer = new MutationObserver(check);
  observer.observe(root, { childList: true, subtree: true, attributes: true });
  check();

  // React.StrictMode intentionally mounts, cleans up and mounts effects again in dev.
  // Cleanup must only detach this observer; cancelling the global fade/removal timers here
  // would leave the already-dismissed splash permanently covering the second mount.
  return () => {
    stopped = true;
    observer.disconnect();
  };
}
